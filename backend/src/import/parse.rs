//! Lectura e interpretación del CSV de un banco. Lógica pura, sin BD: todo lo
//! delicado (separador, comillas, fechas, importes, huellas) se prueba aquí.

use crate::domain::Kind;
use crate::error::{AppError, AppResult};
use crate::transactions::{normalize_description, strip_invisible, validate_amount, validate_date};
use chrono::{DateTime, NaiveDate};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Reverse;
use std::collections::HashMap;
use uuid::Uuid;

pub const MAX_CSV_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ROWS: usize = 5_000;
/// Un extracto bancario no pasa de unas decenas de columnas.
const MAX_COLUMNS: usize = 100;
/// Separadores que caben en un fichero válido (todas las filas con el máximo de columnas). El lector
/// reserva memoria por campo, así que un fichero de solo separadores (2 MiB de `;` = 2 millones de
/// campos, unos 150 MB) se rechaza contando bytes, antes de pasarlo por el lector.
const MAX_DELIMITERS: usize = (MAX_ROWS + 1) * (MAX_COLUMNS - 1);
/// Más que cualquier referencia bancaria real; evita índices con claves enormes.
const MAX_REF_CHARS: usize = 200;
/// En este orden desempatan al detectar el separador.
const DELIMITERS: &[u8; 3] = b";,\t";
/// Filas que se miran para detectar el separador.
const DETECT_ROWS: usize = 20;

fn invalid(msg: &str) -> AppError {
    AppError::Validation(msg.into())
}

// ---------------------------------------------------------------------------
// Lectura de la tabla
// ---------------------------------------------------------------------------

pub struct Table {
    pub delimiter: u8,
    /// Filas no vacías, con las celdas recortadas. La primera puede ser la cabecera.
    pub records: Vec<Vec<String>>,
}

fn reader(text: &str, delimiter: u8) -> csv::Reader<&[u8]> {
    csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes())
}

fn is_blank(rec: &csv::StringRecord) -> bool {
    rec.iter().all(|c| c.trim().is_empty())
}

/// Elige el separador cuyo reparto en columnas es más regular en las primeras
/// filas: primero cuántas filas comparten el número de columnas más habitual y,
/// a igualdad, cuántas columnas son (con `;` y decimales con coma, `,` también
/// reparte regular, pero en menos columnas).
fn detect_delimiter(text: &str) -> u8 {
    DELIMITERS
        .iter()
        .enumerate()
        .filter_map(|(i, &d)| {
            let mut freq: HashMap<usize, usize> = HashMap::new();
            for rec in reader(text, d).records().take(DETECT_ROWS).flatten() {
                if !is_blank(&rec) {
                    *freq.entry(rec.len()).or_default() += 1;
                }
            }
            let (cols, rows) = freq.into_iter().filter(|&(c, _)| c >= 2).max_by_key(|&(c, r)| (r, c))?;
            Some(((rows, cols, Reverse(i)), d))
        })
        .max_by_key(|&(score, _)| score)
        .map_or(b',', |(_, d)| d)
}

/// Lee el fichero entero. `has_header` solo sirve para aplicar el tope de filas
/// de datos (la cabecera no cuenta).
pub fn read_table(csv: &str, has_header: bool) -> AppResult<Table> {
    if csv.len() > MAX_CSV_BYTES {
        return Err(invalid("El fichero supera los 2 MB"));
    }
    let text = csv.strip_prefix('\u{feff}').unwrap_or(csv);
    if DELIMITERS.iter().any(|&d| text.bytes().filter(|&b| b == d).count() > MAX_DELIMITERS) {
        return Err(invalid("El fichero tiene demasiadas columnas"));
    }
    let delimiter = detect_delimiter(text);
    let max_records = MAX_ROWS + usize::from(has_header);
    let mut records = Vec::new();
    for rec in reader(text, delimiter).records() {
        let rec = rec.map_err(|_| invalid("El fichero no es un CSV válido"))?;
        if rec.len() > MAX_COLUMNS {
            return Err(invalid("El fichero tiene demasiadas columnas"));
        }
        if is_blank(&rec) {
            continue;
        }
        if records.len() == max_records {
            return Err(invalid("El fichero supera las 5.000 filas de datos"));
        }
        records.push(rec.iter().map(|c| c.trim().to_string()).collect());
    }
    if records.is_empty() {
        return Err(invalid("El fichero está vacío"));
    }
    Ok(Table { delimiter, records })
}

// ---------------------------------------------------------------------------
// Mapeo
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateFormat {
    #[default]
    Auto,
    Ymd,
    Dmy,
    Mdy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decimal {
    #[default]
    Auto,
    Comma,
    Dot,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct Mapping {
    pub date: usize,
    pub amount: usize,
    #[serde(default)]
    pub description: Option<usize>,
    #[serde(default)]
    pub reference: Option<usize>,
    #[serde(default = "yes")]
    pub has_header: bool,
    #[serde(default)]
    pub date_format: DateFormat,
    #[serde(default)]
    pub decimal: Decimal,
    #[serde(default)]
    pub invert_sign: bool,
    /// Zona IANA ("Europe/Madrid"); sin ella, UTC. Solo cuenta para ISO 8601 con zona.
    #[serde(default)]
    pub tz: Option<String>,
}

fn check_mapping(table: &Table, m: &Mapping) -> AppResult<()> {
    let width = table.records.iter().map(Vec::len).max().unwrap_or(0);
    let columns = [
        (Some(m.date), "fecha"),
        (Some(m.amount), "importe"),
        (m.description, "descripción"),
        (m.reference, "referencia"),
    ];
    for (col, name) in columns {
        if col.is_some_and(|c| c >= width) {
            return Err(AppError::Validation(format!("La columna de {name} no existe en el fichero")));
        }
    }
    if m.date == m.amount {
        return Err(invalid("La fecha y el importe no pueden ser la misma columna"));
    }
    Ok(())
}

fn parse_tz(m: &Mapping) -> AppResult<Tz> {
    m.tz.as_deref().map_or(Ok(Tz::UTC), |name| name.parse().map_err(|_| invalid("La zona horaria no es válida")))
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

/// Formato con el que se han leído las fechas (se devuelve en `/preview`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fmt {
    Ymd,
    Dmy,
    Mdy,
}

/// ISO 8601 con zona: el instante se pasa a la fecha local de `tz`, con el horario de
/// verano que tuviera ese día. Sin zona, o en los demás formatos, vale la fecha tal como
/// está escrita (la hora, si la hay, se ignora). Año de 4 cifras; día y mes de 1 o 2.
fn parse_date(raw: &str, fmt: Fmt, tz: Tz) -> Option<NaiveDate> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&tz).date_naive());
    }
    let date = raw.split(['T', ' ']).next()?;
    let sep = date.chars().find(|c| matches!(c, '-' | '/' | '.'))?;
    let parts: Vec<&str> = date.split(sep).collect();
    if parts.len() != 3 || !parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let (y, m, d) = match fmt {
        Fmt::Ymd => (parts[0], parts[1], parts[2]),
        Fmt::Dmy => (parts[2], parts[1], parts[0]),
        Fmt::Mdy => (parts[2], parts[0], parts[1]),
    };
    if y.len() != 4 || m.len() > 2 || d.len() > 2 {
        return None;
    }
    NaiveDate::from_ymd_opt(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?)
}

/// Con `auto` gana el formato que lee más filas; si dos leen las mismas pero
/// dan fechas distintas (01/02/2026 vale como 1 de febrero y como 2 de enero),
/// no se adivina: error. Una fila suelta ilegible no obliga a elegir a mano.
fn resolve_format(cells: &[&str], m: &Mapping, tz: Tz) -> AppResult<Fmt> {
    match m.date_format {
        DateFormat::Ymd => return Ok(Fmt::Ymd),
        DateFormat::Dmy => return Ok(Fmt::Dmy),
        DateFormat::Mdy => return Ok(Fmt::Mdy),
        DateFormat::Auto => {}
    }
    let candidates = [Fmt::Ymd, Fmt::Dmy, Fmt::Mdy];
    let parsed: Vec<Vec<Option<NaiveDate>>> = candidates
        .iter()
        .map(|&f| cells.iter().map(|c| parse_date(c, f, tz)).collect())
        .collect();
    let read = |p: &Vec<Option<NaiveDate>>| p.iter().flatten().count();
    let best = parsed.iter().map(read).max().unwrap_or(0);
    let top: Vec<usize> = (0..candidates.len()).filter(|&i| read(&parsed[i]) == best).collect();
    if top.iter().all(|&i| parsed[i] == parsed[top[0]]) {
        return Ok(candidates[top[0]]);
    }
    // Un extracto cubre un periodo seguido: si día/mes (el formato de la app) abarca menos de
    // la mitad que la siguiente lectura (del 01/10 al 09/10 frente a enero–septiembre), es ese.
    // Solo a su favor: un cargo mensual el día 5 leído como mes/día parecería los días 1 a 9
    // de mayo, y eso no se adivina. Si no es claro, se pregunta.
    let span = |p: &Vec<Option<NaiveDate>>| {
        let (min, max) = (p.iter().flatten().min(), p.iter().flatten().max());
        min.zip(max).map_or(0, |(a, b)| (*b - *a).num_days())
    };
    let mut by_span: Vec<(i64, usize)> = top.iter().map(|&i| (span(&parsed[i]), i)).collect();
    by_span.sort();
    if candidates[by_span[0].1] == Fmt::Dmy && by_span[0].0 * 2 < by_span[1].0 {
        return Ok(Fmt::Dmy);
    }
    Err(AppError::AmbiguousDate(
        "El formato de fecha es ambiguo (por ejemplo 01/02/2026 puede ser 1 de febrero o 2 de enero): elige el formato a mano".into(),
    ))
}

// ---------------------------------------------------------------------------
// Importes
// ---------------------------------------------------------------------------

/// Decide qué carácter es el decimal y cuál el de miles. Con ambos presentes
/// manda el último. Con uno solo: repetido es de miles; una vez, con tres
/// cifras detrás y 1-3 delante (sin cero inicial), es de miles; si no, decimal.
fn infer_separators(body: &str) -> (char, char) {
    let (dots, commas) = (body.matches('.').count(), body.matches(',').count());
    if dots > 0 && commas > 0 {
        return if body.rfind('.') > body.rfind(',') { ('.', ',') } else { (',', '.') };
    }
    let (sep, n, other) = if dots > 0 { ('.', dots, ',') } else { (',', commas, '.') };
    match n {
        0 => (',', '.'),
        1 => {
            let (before, after) = body.split_once(sep).unwrap_or((body, ""));
            if after.len() == 3 && (1..=3).contains(&before.len()) && !before.starts_with('0') {
                (other, sep)
            } else {
                (sep, other)
            }
        }
        _ => (other, sep),
    }
}

fn digits_to_i64(digits: &str) -> i64 {
    // Satura: un número desorbitado queda por encima del máximo y `validate_amount` lo rechaza.
    digits.bytes().fold(0i64, |a, b| a.saturating_mul(10).saturating_add(i64::from(b - b'0')))
}

/// Símbolos y códigos de moneda que se admiten fuera de las cifras (los códigos, sin
/// distinguir mayúsculas). Los largos antes que los cortos.
const CURRENCIES: [&str; 8] = ["EUROS", "EURO", "EUR", "USD", "GBP", "€", "$", "£"];

/// Lo que hay a un lado de las cifras de un importe.
#[derive(Default)]
struct Decor {
    negative: Option<bool>,
    open: bool,
    close: bool,
    currency: bool,
}

/// Lee lo que rodea a las cifras: espacios, a lo sumo un signo, un paréntesis y una moneda de
/// la lista. Cualquier otra cosa (letras como «DR» o «Saldo», signos repetidos, caracteres
/// invisibles que no son espacios) hace que no sea un importe.
fn scan_decor(mut s: &str, d: &mut Decor) -> Option<()> {
    loop {
        s = s.trim_start();
        let Some(c) = s.chars().next() else { return Some(()) };
        let used = match c {
            '-' | '\u{2212}' | '+' => {
                d.negative.replace(c != '+').is_none().then_some(c.len_utf8())?
            }
            '(' => (!std::mem::replace(&mut d.open, true)).then_some(1)?,
            ')' => (!std::mem::replace(&mut d.close, true)).then_some(1)?,
            _ => {
                let code = CURRENCIES
                    .iter()
                    .find(|k| s.get(..k.len()).is_some_and(|head| head.eq_ignore_ascii_case(k)))?;
                (!std::mem::replace(&mut d.currency, true)).then_some(code.len())?
            }
        };
        s = &s[used..];
    }
}

/// Importe en céntimos como (negativo, magnitud). `None` si no es un importe.
/// El signo (uno solo) puede ir delante o detrás (`-12,50`, `12,50-`) o ser un paréntesis
/// contable equilibrado (`(12,00)`); la moneda solo se admite fuera de las cifras.
/// Los miles deben ir en grupos de tres y los decimales son 1 o 2.
fn parse_amount(raw: &str, decimal: Decimal) -> Option<(bool, i64)> {
    let s = raw.trim();
    let first = s.find(|c: char| c.is_ascii_digit())?;
    let last = s.rfind(|c: char| c.is_ascii_digit())?;
    let (prefix, body, suffix) = (&s[..first], &s[first..=last], &s[last + 1..]);
    let (mut before, mut after) = (Decor::default(), Decor::default());
    scan_decor(prefix, &mut before)?;
    scan_decor(suffix, &mut after)?;
    let parens = match (before.open, before.close, after.open, after.close) {
        (true, false, false, true) => true,
        (false, false, false, false) => false,
        _ => return None,
    };
    let sign = match (before.negative, after.negative) {
        (Some(_), Some(_)) => return None,
        (a, b) => a.or(b),
    };
    if (before.currency && after.currency) || (parens && sign.is_some()) {
        return None;
    }
    let negative = parens || sign == Some(true);

    // Espacios (incluido el de no separación) como separador de miles: "1 234,56".
    let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    if !body.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
        return None;
    }
    let (dec, thousands) = match decimal {
        Decimal::Comma => (',', '.'),
        Decimal::Dot => ('.', ','),
        Decimal::Auto => infer_separators(&body),
    };
    let (int_part, frac) = match body.split_once(dec) {
        Some((i, f)) => (i, Some(f)),
        None => (body.as_str(), None),
    };
    if let Some(f) = frac
        && (!(1..=2).contains(&f.len()) || !f.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let groups: Vec<&str> = int_part.split(thousands).collect();
    let grouped_ok = groups.len() == 1
        || ((1..=3).contains(&groups[0].len()) && groups[1..].iter().all(|g| g.len() == 3));
    if !grouped_ok || groups.iter().any(|g| g.is_empty() || !g.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let units = digits_to_i64(&groups.concat());
    let cents = frac.map_or(0, |f| digits_to_i64(f) * if f.len() == 1 { 10 } else { 1 });
    Some((negative, units.saturating_mul(100).saturating_add(cents)))
}

// ---------------------------------------------------------------------------
// Texto normalizado, huellas y duplicados
// ---------------------------------------------------------------------------

/// Colapsa cualquier racha de espacios o saltos de línea en un espacio.
fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Descripción normalizada solo para sugerir categoría: minúsculas, sin cifras (suelen ser
/// números de operación o de tarjeta, y así «Compra tarjeta 1234» y «…5678» sugieren igual)
/// y sin espacios repetidos.
pub fn normalize_key(text: &str) -> String {
    squash(&text.chars().filter(|c| !c.is_numeric()).collect::<String>().to_lowercase())
}

/// Descripción para la huella: minúsculas y espacios colapsados, CON cifras («Bizum a 600111222»
/// y «Bizum a 600333444» el mismo día e importe son movimientos distintos).
fn fingerprint_text(text: &str) -> String {
    squash(&text.to_lowercase())
}

/// OJO: este formato se guarda en `transactions.import_ref`; cambiarlo haría que reimportar
/// un fichero duplicara todo lo importado antes (hay tests con valores fijos).
fn import_ref(prefix: &str, base: &str, nth: u32) -> String {
    format!("{prefix}{:x}", Sha256::digest(format!("{base}|{nth}")))
}

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct Row {
    pub index: usize,
    pub occurred_on: Option<NaiveDate>,
    pub kind: Option<Kind>,
    pub amount_cents: Option<i64>,
    pub description: Option<String>,
    pub reference: Option<String>,
    pub category_id: Option<Uuid>,
    /// Solo en filas sin error.
    pub import_ref: Option<String>,
    pub duplicate: bool,
    pub error: Option<String>,
}

/// Rellena la fila campo a campo; el primer fallo corta y queda como su error.
/// Los límites son los de `POST /api/transactions`.
fn fill_row(row: &mut Row, rec: &[String], m: &Mapping, fmt: Fmt, tz: Tz) -> AppResult<()> {
    let (Some(date), Some(amount)) = (rec.get(m.date), rec.get(m.amount)) else {
        return Err(invalid("Faltan columnas en esta fila"));
    };
    // La descripción va primero: si la fila falla después, se sabe cuál es.
    if let Some(text) = m.description.and_then(|c| rec.get(c)) {
        row.description = normalize_description(Some(squash(&strip_invisible(text))))?;
    }
    if date.is_empty() {
        return Err(invalid("Falta la fecha"));
    }
    let date = parse_date(date, fmt, tz).ok_or_else(|| invalid("Fecha no válida"))?;
    validate_date(date)?;
    row.occurred_on = Some(date);

    if amount.is_empty() {
        return Err(invalid("Falta el importe"));
    }
    let (negative, cents) = parse_amount(amount, m.decimal).ok_or_else(|| invalid("Importe no válido"))?;
    validate_amount(cents)?;
    row.amount_cents = Some(cents);
    row.kind = Some(if negative != m.invert_sign { Kind::Expense } else { Kind::Income });

    if let Some(text) = m.reference.and_then(|c| rec.get(c)) {
        let text = strip_invisible(text);
        let text = text.trim();
        if text.chars().count() > MAX_REF_CHARS {
            return Err(invalid("La referencia supera los 200 caracteres"));
        }
        row.reference = (!text.is_empty()).then(|| text.to_string());
    }
    Ok(())
}

/// `import_ref` de cada fila válida, siempre distinto dentro del fichero: el n.º de aparición de
/// la misma combinación distingue las repetidas (dos cafés idénticos el mismo día son dos
/// movimientos). La referencia del banco nunca basta sola, porque la de un recibo domiciliado
/// se repite cada mes: va dentro de la huella junto a fecha, importe y tipo (`ref:`); sin ella,
/// la huella lleva la descripción (`fp:`).
fn assign_refs(rows: &mut [Row]) {
    let mut appearances: HashMap<String, u32> = HashMap::new();
    for row in rows.iter_mut().filter(|r| r.error.is_none()) {
        let (Some(date), Some(cents), Some(kind)) = (row.occurred_on, row.amount_cents, row.kind) else {
            continue;
        };
        let (prefix, base) = match &row.reference {
            Some(reference) => ("ref:", format!("{reference}|{date}|{cents}|{kind}")),
            None => {
                let desc = fingerprint_text(row.description.as_deref().unwrap_or(""));
                ("fp:", format!("{date}|{cents}|{kind}|{desc}"))
            }
        };
        let nth = appearances.entry(format!("{prefix}{base}")).or_default();
        *nth += 1;
        row.import_ref = Some(import_ref(prefix, &base, *nth));
    }
}

/// Interpreta las filas de datos según el mapeo y dice con qué formato se leyeron las fechas.
/// Los errores globales (mapeo que no encaja, zona inválida, formato de fecha ambiguo) salen
/// como `Err`; los de una fila, en su campo `error`.
pub fn interpret(table: &Table, m: &Mapping) -> AppResult<(Vec<Row>, Fmt)> {
    check_mapping(table, m)?;
    let data = &table.records[usize::from(m.has_header).min(table.records.len())..];
    if data.is_empty() {
        return Err(invalid("El fichero no tiene filas de datos"));
    }
    let dates: Vec<&str> = data
        .iter()
        .filter_map(|r| r.get(m.date))
        .map(String::as_str)
        .filter(|c| !c.is_empty())
        .collect();
    // La zona solo cuenta en fechas ISO con zona: una inválida no debe bloquear un fichero DD/MM/YYYY.
    let tz = if dates.iter().any(|c| DateTime::parse_from_rfc3339(c).is_ok()) { parse_tz(m)? } else { Tz::UTC };
    let fmt = resolve_format(&dates, m, tz)?;
    let mut rows: Vec<Row> = data
        .iter()
        .enumerate()
        .map(|(index, rec)| {
            let mut row = Row { index, ..Row::default() };
            if let Err(e) = fill_row(&mut row, rec, m, fmt, tz) {
                row.error = Some(e.to_string());
            }
            row
        })
        .collect();
    assign_refs(&mut rows);
    Ok((rows, fmt))
}

// ---------------------------------------------------------------------------
// Categoría sugerida
// ---------------------------------------------------------------------------

/// Cuántas veces ha usado el usuario una categoría con una descripción tal cual
/// está guardada (la normalización se hace aquí, no en SQL, para que haya una sola).
pub struct Usage {
    pub kind: Kind,
    pub description: String,
    pub category_id: Uuid,
    pub count: i64,
    pub last: NaiveDate,
}

fn suggestion_key(kind: Kind, description: &str) -> Option<String> {
    let key = normalize_key(description);
    (!key.is_empty()).then(|| format!("{kind}|{key}"))
}

/// Pone a cada fila válida la categoría más usada para su tipo y descripción
/// normalizada; a igualdad, la usada más recientemente. Sin coincidencias, nada.
pub fn suggest(rows: &mut [Row], usage: Vec<Usage>) {
    let mut by_key: HashMap<String, HashMap<Uuid, (i64, NaiveDate)>> = HashMap::new();
    for u in usage {
        let Some(key) = suggestion_key(u.kind, &u.description) else { continue };
        let entry = by_key.entry(key).or_default().entry(u.category_id).or_insert((0, u.last));
        entry.0 += u.count;
        entry.1 = entry.1.max(u.last);
    }
    for row in rows.iter_mut().filter(|r| r.error.is_none()) {
        let (Some(kind), Some(desc)) = (row.kind, row.description.as_deref()) else { continue };
        row.category_id = suggestion_key(kind, desc)
            .and_then(|k| by_key.get(&k))
            .and_then(|cats| cats.iter().max_by_key(|&(id, &(n, last))| (n, last, *id)))
            .map(|(id, _)| *id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn mapping() -> Mapping {
        Mapping {
            date: 0,
            amount: 2,
            description: Some(1),
            reference: None,
            has_header: true,
            date_format: DateFormat::Auto,
            decimal: Decimal::Auto,
            invert_sign: false,
            tz: None,
        }
    }

    fn rows_of(csv: &str, m: &Mapping) -> AppResult<Vec<Row>> {
        interpret(&read_table(csv, m.has_header)?, m).map(|(rows, _)| rows)
    }

    const UTC: Tz = Tz::UTC;

    #[test]
    fn error_rows_keep_their_description() {
        let rows = rows_of("f;c;i\n09/10/2026;Comisión mantenimiento;0,00\n10/10/2026;Café;x\n", &mapping()).unwrap();
        assert!(rows.iter().all(|r| r.error.is_some()));
        assert_eq!(rows[0].description.as_deref(), Some("Comisión mantenimiento"));
        assert_eq!(rows[1].description.as_deref(), Some("Café"));
    }

    // --- tabla ---

    #[test]
    fn detects_each_delimiter() {
        let semi = "Fecha;Concepto;Importe\n2026-10-01;Nómina;2500,00\n2026-10-02;Café;-1,50\n";
        assert_eq!(read_table(semi, true).unwrap().delimiter, b';');
        let comma = "Fecha,Concepto,Importe\n2026-10-01,Nómina,2500.00\n2026-10-02,Café,-1.50\n";
        assert_eq!(read_table(comma, true).unwrap().delimiter, b',');
        let tab = "Fecha\tConcepto\tImporte\n2026-10-01\tNómina\t2500,00\n2026-10-02\tCafé\t-1,50\n";
        assert_eq!(read_table(tab, true).unwrap().delimiter, b'\t');
    }

    #[test]
    fn delimiter_ignores_separators_inside_quotes() {
        // Cada fila tiene un ";" y varias "," dentro de comillas, pero el separador es ",".
        let csv = "f,c,i\n2026-10-01,\"a; b\",1.50\n2026-10-02,\"c; d\",2.50\n";
        let t = read_table(csv, true).unwrap();
        assert_eq!(t.delimiter, b',');
        assert_eq!(t.records[1], ["2026-10-01", "a; b", "1.50"]);
        // Con ";" y decimales con coma, gana ";" aunque "," también reparta igual.
        let csv = "f;c;i\n2026-10-01;a;1,50\n2026-10-02;b;2,50\n";
        assert_eq!(read_table(csv, true).unwrap().delimiter, b';');
    }

    #[test]
    fn single_column_falls_back_to_comma() {
        assert_eq!(read_table("a\nb\nc\n", true).unwrap().delimiter, b',');
    }

    #[test]
    fn handles_quotes_escaped_quotes_and_newlines_in_fields() {
        let csv = "f;c;i\r\n2026-10-01;\"dijo \"\"hola\"\"; y\nsalió\";-1,00\r\n2026-10-02;b;2,00\r\n";
        let t = read_table(csv, true).unwrap();
        assert_eq!(t.records.len(), 3);
        assert_eq!(t.records[1][1], "dijo \"hola\"; y\nsalió");
        assert_eq!(t.records[2], ["2026-10-02", "b", "2,00"]);
    }

    #[test]
    fn strips_bom_and_skips_blank_lines() {
        let csv = "\u{feff}Fecha;Importe\n\n2026-10-01;1,00\n;;\n  ;  \n2026-10-02;2,00\n";
        let t = read_table(csv, true).unwrap();
        assert_eq!(t.records[0][0], "Fecha");
        assert_eq!(t.records.len(), 3);
    }

    #[test]
    fn rejects_empty_oversized_and_too_many_rows() {
        assert!(read_table("", true).is_err());
        assert!(read_table("\u{feff}\n \n", true).is_err());
        assert!(read_table(&"a".repeat(MAX_CSV_BYTES + 1), true).is_err());
        assert!(read_table(&"a".repeat(MAX_CSV_BYTES), true).is_ok());
        let rows = |n: usize| "a;b\n".repeat(n);
        // 5.000 filas de datos más la cabecera caben; una más no.
        assert!(read_table(&rows(MAX_ROWS + 1), true).is_ok());
        assert!(read_table(&rows(MAX_ROWS + 2), true).is_err());
        // Sin cabecera todas son de datos.
        assert!(read_table(&rows(MAX_ROWS), false).is_ok());
        assert!(read_table(&rows(MAX_ROWS + 1), false).is_err());
        assert!(read_table(&"a;".repeat(MAX_COLUMNS), true).is_err());
        assert!(read_table(&"a;".repeat(MAX_COLUMNS - 1), true).is_ok());
    }

    #[test]
    fn files_of_only_separators_are_rejected_before_being_read() {
        // 2 MiB de ";" son 2 millones de campos: antes costaban ~150 MB por petición.
        let bomb = ";".repeat(MAX_CSV_BYTES);
        for d in [";", ",", "\t"] {
            assert!(read_table(&bomb.replace(';', d), true).is_err(), "{d:?}");
        }
        // Un registro en blanco con demasiadas columnas ya no se salta en silencio.
        assert!(read_table(&format!("a;b\n{}\n1;2\n", ";".repeat(MAX_COLUMNS)), true).is_err());
        // Justo en el límite (todas las filas con el máximo de columnas) se acepta.
        let row = format!("{}\n", ["x"; MAX_COLUMNS].join(";"));
        assert!(read_table(&row.repeat(100), true).is_ok());
    }

    // --- fechas ---

    #[test]
    fn parses_every_date_format_and_separator() {
        let p = |s, f| parse_date(s, f, UTC);
        for s in ["2026-10-05", "2026/10/05", "2026.10.05", "2026-10-05T10:00:00", "2026-10-05 10:00:00"] {
            assert_eq!(p(s, Fmt::Ymd), Some(d(2026, 10, 5)), "{s}");
        }
        for s in ["05/10/2026", "05-10-2026", "05.10.2026", "5/10/2026", "05/10/2026 14:30"] {
            assert_eq!(p(s, Fmt::Dmy), Some(d(2026, 10, 5)), "{s}");
        }
        for s in ["10/05/2026", "10-05-2026", "10.05.2026"] {
            assert_eq!(p(s, Fmt::Mdy), Some(d(2026, 10, 5)), "{s}");
        }
    }

    #[test]
    fn rejects_malformed_dates() {
        for s in ["", "hola", "2026-13-01", "2026-02-30", "05/10/26", "5/10", "05/10/2026/1", "2026-10-", "-1/10/2026", "05/10-2026x"] {
            assert_eq!(parse_date(s, Fmt::Dmy, UTC), None, "{s}");
            assert_eq!(parse_date(s, Fmt::Ymd, UTC), None, "{s}");
        }
        // Un formato no lee las fechas del otro.
        assert_eq!(parse_date("2026-10-05", Fmt::Dmy, UTC), None);
        assert_eq!(parse_date("05/10/2026", Fmt::Ymd, UTC), None);
        assert_eq!(parse_date("13/10/2026", Fmt::Mdy, UTC), None);
    }

    #[test]
    fn iso_with_zone_becomes_local_date_with_that_days_offset() {
        let madrid: Tz = "Europe/Madrid".parse().unwrap();
        // 22:30 UTC: en julio (CEST, +2) ya es el día siguiente; en enero (CET, +1) todavía no.
        assert_eq!(parse_date("2026-07-01T22:30:00Z", Fmt::Ymd, madrid), Some(d(2026, 7, 2)));
        assert_eq!(parse_date("2026-01-01T22:30:00Z", Fmt::Ymd, madrid), Some(d(2026, 1, 1)));
        // 23:30 UTC: en enero también cambia de día.
        assert_eq!(parse_date("2026-01-01T23:30:00Z", Fmt::Ymd, madrid), Some(d(2026, 1, 2)));
        // Sin zona (o UTC) no hay desfase.
        assert_eq!(parse_date("2026-07-01T22:30:00Z", Fmt::Ymd, UTC), Some(d(2026, 7, 1)));
        // 01:00+02:00 del 14 son las 23:00 UTC del 13; en Nueva York (-4 en octubre) son las 19:00 del 13.
        let ny: Tz = "America/New_York".parse().unwrap();
        assert_eq!(parse_date("2026-10-14T01:00:00+02:00", Fmt::Ymd, UTC), Some(d(2026, 10, 13)));
        assert_eq!(parse_date("2026-10-14T01:00:00+02:00", Fmt::Ymd, ny), Some(d(2026, 10, 13)));
        assert_eq!(parse_date("2026-10-14T01:00:00.250+02:00", Fmt::Dmy, madrid), Some(d(2026, 10, 14)));
        assert_eq!(parse_date("2026-10-13 23:30:00+00:00", Fmt::Ymd, madrid), Some(d(2026, 10, 14)));
        // Sin zona no hay nada que convertir: vale la fecha escrita.
        assert_eq!(parse_date("2026-10-13T23:30:00", Fmt::Ymd, madrid), Some(d(2026, 10, 13)));
    }

    #[test]
    fn tz_must_be_a_known_iana_zone() {
        let mut m = mapping();
        let csv = "f;c;i\n2026-07-01T22:30:00Z;x;1,00\n";
        assert_eq!(rows_of(csv, &m).unwrap()[0].occurred_on, Some(d(2026, 7, 1)));
        m.tz = Some("Europe/Madrid".into());
        assert_eq!(rows_of(csv, &m).unwrap()[0].occurred_on, Some(d(2026, 7, 2)));
        for bad in ["", "Madrid", "Europe/Nowhere", "+02:00", "europe/madrid x"] {
            m.tz = Some(bad.into());
            assert!(rows_of(csv, &m).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn preview_reports_the_format_used() {
        let t = |csv: &str, f: DateFormat| {
            let mut m = mapping();
            m.date_format = f;
            interpret(&read_table(csv, true).unwrap(), &m).map(|(_, fmt)| fmt)
        };
        assert_eq!(t("f;c;i\n13/10/2026;x;1,00\n", DateFormat::Auto).unwrap(), Fmt::Dmy);
        assert_eq!(t("f;c;i\n2026-10-13;x;1,00\n", DateFormat::Auto).unwrap(), Fmt::Ymd);
        assert_eq!(t("f;c;i\n10/13/2026;x;1,00\n", DateFormat::Auto).unwrap(), Fmt::Mdy);
        assert_eq!(t("f;c;i\n01/02/2026;x;1,00\n", DateFormat::Dmy).unwrap(), Fmt::Dmy);
        assert_eq!(serde_json::to_string(&Fmt::Mdy).unwrap(), "\"mdy\"");
    }

    #[test]
    fn auto_picks_the_only_format_that_reads_every_row() {
        let m = mapping();
        let dates = |cells: &[&str]| resolve_format(cells, &m, UTC);
        assert_eq!(dates(&["2026-10-01", "2026-11-02"]).unwrap(), Fmt::Ymd);
        // Un día > 12 desambigua aunque las demás filas valgan en ambos.
        assert_eq!(dates(&["01/02/2026", "13/02/2026"]).unwrap(), Fmt::Dmy);
        assert_eq!(dates(&["01/02/2026", "02/13/2026"]).unwrap(), Fmt::Mdy);
        // Dos formatos leen todo pero dan fechas distintas: ambiguo.
        assert!(dates(&["01/02/2026"]).is_err());
        assert!(dates(&["01/02/2026", "03/04/2026", "12/12/2026"]).is_err());
        // Principio de mes en un extracto español: dmy cubre 8 días y mdy 8 meses.
        assert_eq!(dates(&["01/10/2026", "03/10/2026", "05/10/2026", "09/10/2026"]).unwrap(), Fmt::Dmy);
        // El rango solo puede dar la razón a día/mes. Si lo más corto fuera mes/día, se pregunta:
        // aquí parecería del 1 al 9 de octubre, pero también es el día 10 de enero, marzo y septiembre.
        assert!(dates(&["10/01/2026", "10/03/2026", "10/09/2026"]).is_err());
        // Un cargo mensual el día 5 leído como mes/día serían los días 1 a 9 de mayo.
        let monthly = ["05/01/2026", "05/02/2026", "05/03/2026", "05/04/2026", "05/05/2026", "05/06/2026", "05/07/2026", "05/08/2026", "05/09/2026"];
        assert!(dates(&monthly).is_err());
        // Si dan lo mismo, no hay ambigüedad real.
        assert!(dates(&["05/05/2026", "01/01/2026"]).is_ok());
        // Fechas ISO con zona valen igual para los tres formatos.
        assert!(dates(&["2026-10-01T10:00:00Z", "2026-10-02T10:00:00+02:00"]).is_ok());
        // Mezclar formatos incompatibles tampoco se adivina.
        assert!(dates(&["13/10/2026", "2026-10-14"]).is_err());
    }

    #[test]
    fn only_the_ambiguous_format_has_its_own_error_code() {
        let m = mapping();
        let err = resolve_format(&["01/02/2026"], &m, UTC).unwrap_err();
        assert!(matches!(err, AppError::AmbiguousDate(_)), "{err:?}");
        // Los demás errores globales siguen siendo `validation`.
        let mut bad = mapping();
        bad.tz = Some("No/Existe".into());
        for res in [rows_of("f;c;i\n2026-10-01T10:00:00Z;a;1,00\n", &bad), rows_of("f;c;i\n", &m)] {
            assert!(matches!(res.unwrap_err(), AppError::Validation(_)));
        }
        let ambiguous = rows_of("f;c;i\n01/02/2026;a;1,00\n", &m).unwrap_err();
        assert!(matches!(ambiguous, AppError::AmbiguousDate(_)));
    }

    #[test]
    fn auto_tolerates_a_single_unreadable_row() {
        let m = mapping();
        // "Saldo" no se lee con ningún formato, pero dmy lee 2 filas y mdy 1: gana dmy.
        let f = resolve_format(&["01/02/2026", "25/12/2026", "Saldo"], &m, UTC).unwrap();
        assert_eq!(f, Fmt::Dmy);
    }

    #[test]
    fn explicit_format_skips_detection() {
        let mut m = mapping();
        m.date_format = DateFormat::Mdy;
        let csv = "f;c;i\n01/02/2026;x;1,00\n";
        let rows = rows_of(csv, &m).unwrap();
        assert_eq!(rows[0].occurred_on, Some(d(2026, 1, 2)));
        m.date_format = DateFormat::Dmy;
        assert_eq!(rows_of(csv, &m).unwrap()[0].occurred_on, Some(d(2026, 2, 1)));
        m.date_format = DateFormat::Auto;
        assert!(rows_of(csv, &m).is_err());
    }

    // --- importes ---

    #[test]
    fn parses_amounts_in_both_locales() {
        let a = |s| parse_amount(s, Decimal::Auto);
        assert_eq!(a("1.234,56"), Some((false, 123_456)));
        assert_eq!(a("-12,50 €"), Some((true, 1250)));
        assert_eq!(a("1,234.56"), Some((false, 123_456)));
        assert_eq!(a("+3"), Some((false, 300)));
        assert_eq!(a("(12,00)"), Some((true, 1200)));
        assert_eq!(a("0"), Some((false, 0)));
        assert_eq!(a("12.5"), Some((false, 1250)));
        assert_eq!(a("12,5"), Some((false, 1250)));
        assert_eq!(a("€ 1.000,00"), Some((false, 100_000)));
        assert_eq!(a("EUR -4,00"), Some((true, 400)));
        assert_eq!(a("-€4,00"), Some((true, 400)));
        assert_eq!(a("$1,234.56"), Some((false, 123_456)));
        assert_eq!(a("4,00-"), Some((true, 400)));
        assert_eq!(a("\u{2212}4,00"), Some((true, 400)));
        assert_eq!(a("1 234,56"), Some((false, 123_456)));
        assert_eq!(a("1.234.567,89"), Some((false, 123_456_789)));
        assert_eq!(a("1234"), Some((false, 123_400)));
        assert_eq!(a("007,05"), Some((false, 705)));
        // Monedas de la lista, en mayúsculas o minúsculas, antes o después.
        for s in ["12,50 EUR", "eur 12,50", "12,50 Euros", "EURO 12,50", "12,50 usd", "GBP 12,50", "£12,50", "12,50 $", "12,50€", " 12,50 \u{a0}€ "] {
            assert_eq!(a(s), Some((false, 1250)), "{s:?}");
        }
        assert_eq!(a("-12,50 EUR"), Some((true, 1250)));
        assert_eq!(a("12,50 EUR-"), Some((true, 1250)));
        assert_eq!(a("(12,50 €)"), Some((true, 1250)));
        assert_eq!(a("+12,50"), Some((false, 1250)));
        assert_eq!(a("12,50+"), Some((false, 1250)));
    }

    #[test]
    fn auto_decimal_resolves_a_lone_separator_by_digit_count() {
        let a = |s| parse_amount(s, Decimal::Auto);
        // Tres cifras detrás: miles. Una o dos: decimal.
        assert_eq!(a("1,234"), Some((false, 123_400)));
        assert_eq!(a("1.234"), Some((false, 123_400)));
        assert_eq!(a("1,23"), Some((false, 123)));
        assert_eq!(a("100.000"), Some((false, 10_000_000)));
        // Ni miles (cero inicial, 4 cifras delante) ni decimales (3 cifras): error.
        assert_eq!(a("0,125"), None);
        assert_eq!(a("1234,567"), None);
    }

    #[test]
    fn explicit_decimal_is_strict() {
        assert_eq!(parse_amount("1.234", Decimal::Comma), Some((false, 123_400)));
        assert_eq!(parse_amount("1.234", Decimal::Dot), None);
        assert_eq!(parse_amount("12.5", Decimal::Comma), None);
        assert_eq!(parse_amount("1.234,56", Decimal::Dot), None);
        assert_eq!(parse_amount("12,50", Decimal::Comma), Some((false, 1250)));
        assert_eq!(parse_amount("12.50", Decimal::Dot), Some((false, 1250)));
        assert_eq!(parse_amount("1,234.5", Decimal::Dot), Some((false, 123_450)));
    }

    #[test]
    fn rejects_things_that_are_not_amounts() {
        for s in [
            "", "abc", "-", "€", "1,2,3", "1.2.3", "12,345.678", "1.23,45", "12a34", "1E5", "12-34", "1,", ",50", ".50",
            "12,", "1/2", "12:30", "1.234,5,6", "99%",
        ] {
            assert_eq!(parse_amount(s, Decimal::Auto), None, "{s:?}");
        }
    }

    #[test]
    fn only_a_closed_list_of_currencies_and_a_single_sign_are_allowed_around_the_digits() {
        let bad = [
            // Textos de los bancos para cargo/abono o saldo: no son monedas.
            "12,50 DR", "5,00 D", "D 5,00", "12,50 CARGO", "Saldo 12,50", "12,50 CR", "EUROPA 5,00", "12,50 EURX", "12,50 YEN", "¥5,00",
            // Signos repetidos o mezclados.
            "--5,00", "+-5,00", "-+5,00", "-5,00-", "+5,00+", "5,00--",
            // Paréntesis sin equilibrar, mal colocados o con signo.
            "(5,00", "5,00)", "((5,00))", ")5,00(", "()5,00", "(-5,00)", "(+5,00)", "-(5,00)", "(5,00)-",
            // Dos monedas.
            "€5,00€", "EUR 5,00 €",
            // Espacios Unicode raros delante del signo: U+3164 (relleno hangul), U+2800, U+200B, U+FEFF.
            "\u{3164}-5,00", "\u{3164} 5,00", "-\u{3164}5,00", "\u{2800}5,00", "\u{200b}-5,00", "\u{feff}-5,00", "5,00\u{3164}",
        ];
        for s in bad {
            assert_eq!(parse_amount(s, Decimal::Auto), None, "{s:?}");
        }
        // Los espacios de verdad (incluidos NBSP y el fino estrecho) siguen valiendo.
        assert_eq!(parse_amount("-\u{a0}5,00\u{202f}€", Decimal::Auto), Some((true, 500)));
        // Y llegan a la fila como "Importe no válido".
        let csv = "f;c;i\n2026-10-01;a;12,50 DR\n2026-10-02;b;\u{3164}-5,00\n2026-10-03;c;--5,00\n2026-10-04;d;(5,00\n2026-10-05;e;12,50 EUR\n";
        let rows = rows_of(csv, &mapping()).unwrap();
        let errs: Vec<_> = rows.iter().map(|r| r.error.as_deref()).collect();
        assert_eq!(errs, [Some("Importe no válido"), Some("Importe no válido"), Some("Importe no válido"), Some("Importe no válido"), None]);
    }

    #[test]
    fn huge_amounts_saturate_instead_of_overflowing() {
        let (_, cents) = parse_amount("99999999999999999999999,99", Decimal::Comma).unwrap();
        assert!(validate_amount(cents).is_err());
        let (_, cents) = parse_amount("1.000.000.000,00", Decimal::Auto).unwrap();
        assert!(validate_amount(cents).is_ok());
        let (_, cents) = parse_amount("1.000.000.000,01", Decimal::Auto).unwrap();
        assert!(validate_amount(cents).is_err());
    }

    // --- filas ---

    #[test]
    fn sign_decides_kind_and_invert_sign_flips_it() {
        let csv = "f;c;i\n2026-10-01;a;-12,50\n2026-10-02;b;+3\n2026-10-03;c;4,00\n";
        let mut m = mapping();
        let rows = rows_of(csv, &m).unwrap();
        let got: Vec<_> = rows.iter().map(|r| (r.kind.unwrap(), r.amount_cents.unwrap())).collect();
        assert_eq!(got, [(Kind::Expense, 1250), (Kind::Income, 300), (Kind::Income, 400)]);
        m.invert_sign = true;
        let rows = rows_of(csv, &m).unwrap();
        let got: Vec<_> = rows.iter().map(|r| (r.kind.unwrap(), r.amount_cents.unwrap())).collect();
        assert_eq!(got, [(Kind::Income, 1250), (Kind::Expense, 300), (Kind::Expense, 400)]);
    }

    #[test]
    fn invalid_rows_carry_a_spanish_error_and_do_not_stop_the_rest() {
        let long = "x".repeat(501);
        let csv = format!(
            "f;c;i\n2026-10-01;ok;1,00\n2026-10-02;cero;0\n1999-01-01;vieja;1,00\n;sin fecha;1,00\n2026-10-03;sin importe;\n2026-10-04;mala;abc\n2026-10-05;enorme;2.000.000.000,00\n2026-10-06;{long};1,00\n2026-10-07\n"
        );
        let rows = rows_of(&csv, &mapping()).unwrap();
        let errs: Vec<_> = rows.iter().map(|r| r.error.as_deref()).collect();
        assert_eq!(errs[0], None);
        assert_eq!(errs[1], Some("El importe debe ser mayor que 0"));
        assert_eq!(errs[2], Some("La fecha debe estar entre 2000-01-01 y 2100-12-31"));
        assert_eq!(errs[3], Some("Falta la fecha"));
        assert_eq!(errs[4], Some("Falta el importe"));
        assert_eq!(errs[5], Some("Importe no válido"));
        assert_eq!(errs[6], Some("El importe no puede superar 1.000.000.000,00 €"));
        assert_eq!(errs[7], Some("La descripción no puede superar los 500 caracteres"));
        assert_eq!(errs[8], Some("Faltan columnas en esta fila"));
        // Una fila con error no tiene import_ref; la válida, sí.
        assert!(rows[0].import_ref.is_some() && rows[1..].iter().all(|r| r.import_ref.is_none()));
        // La fecha buena de una fila con importe malo se conserva.
        assert_eq!(rows[1].occurred_on, Some(d(2026, 10, 2)));
        assert_eq!(rows[1].amount_cents, None);
    }

    #[test]
    fn mapping_must_fit_the_file() {
        let csv = "f;c;i\n2026-10-01;a;1,00\n";
        let mut m = mapping();
        m.amount = 3;
        assert!(rows_of(csv, &m).is_err());
        m = mapping();
        m.description = Some(9);
        assert!(rows_of(csv, &m).is_err());
        m = mapping();
        m.amount = 0;
        assert!(rows_of(csv, &m).is_err());
        m = mapping();
        m.tz = Some("No/Existe".into());
        // La zona solo se valida si hay fechas ISO con zona: sin ellas no bloquea el fichero.
        assert!(rows_of(csv, &m).is_ok());
        assert!(rows_of("f;c;i\n2026-10-01T10:00:00Z;a;1,00\n", &m).is_err());
        // Solo cabecera: nada que importar.
        assert!(rows_of("f;c;i\n", &mapping()).is_err());
    }

    #[test]
    fn has_header_false_keeps_the_first_row_as_data() {
        let mut m = mapping();
        m.has_header = false;
        let rows = rows_of("2026-10-01;a;1,00\n2026-10-02;b;2,00\n", &m).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].index, 0);
    }

    #[test]
    fn description_is_squashed_and_multiline_fields_survive() {
        let csv = "f;c;i\n2026-10-01;\"  COMPRA   TARJ\nMercadona  \";-1,00\n2026-10-02;   ;-1,00\n";
        let rows = rows_of(csv, &mapping()).unwrap();
        assert_eq!(rows[0].description.as_deref(), Some("COMPRA TARJ Mercadona"));
        assert_eq!(rows[1].description, None);
    }

    #[test]
    fn nul_and_invisible_characters_never_reach_descriptions_or_references() {
        let mut m = mapping();
        m.reference = Some(3);
        let csv = "f;c;i;r\n2026-10-01;\"Ca\u{0}fé \u{202e}Central\u{200b}\";-1,00;\"R\u{0}1\u{feff}\"\n2026-10-02;\u{0};-1,00;\u{200b}\n";
        let rows = rows_of(csv, &m).unwrap();
        assert_eq!(rows[0].description.as_deref(), Some("Café Central"));
        assert_eq!(rows[0].reference.as_deref(), Some("R1"));
        // Una referencia que se queda vacía es como no tenerla; una descripción vacía, null.
        assert_eq!((rows[1].description.as_deref(), rows[1].reference.as_deref()), (None, None));
        assert!(rows[1].import_ref.as_deref().unwrap().starts_with("fp:"));
        // La limpieza no cambia la identidad: con o sin NUL es la misma huella.
        let plain = rows_of("f;c;i;r\n2026-10-01;Café Central;-1,00;R1\n", &m).unwrap();
        assert_eq!(plain[0].import_ref, rows[0].import_ref);
    }

    // --- huellas y duplicados ---

    #[test]
    fn normalizes_descriptions() {
        assert_eq!(normalize_key("  COMPRA   Tarj. 1234  MERCADONA 08/10 "), "compra tarj. mercadona /");
        assert_eq!(normalize_key("Café\tCentral\n"), "café central");
        assert_eq!(normalize_key("12345"), "");
        assert_eq!(normalize_key(""), "");
        assert_eq!(normalize_key("ÁÑO Nuevo"), "áño nuevo");
    }

    #[test]
    fn import_ref_formats_are_frozen() {
        // Valores fijos: si cambian, los ficheros ya importados se duplicarían al reimportarlos.
        assert_eq!(
            import_ref("fp:", "2026-10-13|150|expense|café central", 1),
            "fp:23cc76ac421acf7a721235719e0028f53c7827164bcad87d37da910310e02055"
        );
        assert_eq!(
            import_ref("ref:", "MANDATO-77|2026-10-15|4500|expense", 1),
            "ref:a0c02305adca7506c98dba6deb631efef317c508213dd538a27173375e846fee"
        );
        assert_ne!(import_ref("fp:", "x", 1), import_ref("fp:", "x", 2));
        // Y las mismas cadenas salen de una fila real.
        let mut m = mapping();
        let rows = rows_of("f;c;i\n2026-10-13;Café   CENTRAL;-1,50\n", &m).unwrap();
        assert_eq!(rows[0].import_ref.as_deref(), Some("fp:23cc76ac421acf7a721235719e0028f53c7827164bcad87d37da910310e02055"));
        m.reference = Some(3);
        let rows = rows_of("f;c;i;r\n2026-10-15;Recibo;-45,00;MANDATO-77\n", &m).unwrap();
        assert_eq!(rows[0].import_ref.as_deref(), Some("ref:a0c02305adca7506c98dba6deb631efef317c508213dd538a27173375e846fee"));
    }

    #[test]
    fn fingerprint_keeps_digits_so_bizum_to_different_numbers_do_not_collide() {
        let rows = rows_of("f;c;i\n2026-10-13;Bizum a 600111222;-10,00\n2026-10-13;Bizum a 600333444;-10,00\n", &mapping()).unwrap();
        assert_eq!(
            rows[0].import_ref.as_deref(),
            Some("fp:03e343f1cd2317e37f92072bc401e6dd1b589a58bc28f6c04a9f55a070750070")
        );
        assert_eq!(
            rows[1].import_ref.as_deref(),
            Some("fp:8582568820c80b88525a2b467aaa987209bd73761f19b8257e8fb180e2d99eda")
        );
        // Pero sigue ignorando mayúsculas y espacios repetidos.
        let again = rows_of("f;c;i\n2026-10-13;BIZUM   A 600111222;-10,00\n", &mapping()).unwrap();
        assert_eq!(again[0].import_ref, rows[0].import_ref);
    }

    #[test]
    fn identical_rows_get_distinct_refs_and_reimport_gets_the_same_ones() {
        let csv = "f;c;i\n2026-10-13;Café;-1,50\n2026-10-13;CAFÉ;-1,50\n2026-10-13;café;-1,50\n2026-10-14;Café;-1,50\n";
        let rows = rows_of(csv, &mapping()).unwrap();
        let refs: Vec<_> = rows.iter().map(|r| r.import_ref.clone().unwrap()).collect();
        // Las tres primeras son la misma combinación (aparición 1, 2, 3).
        assert_eq!(refs.iter().collect::<HashSet<_>>().len(), 4);
        assert!(rows.iter().all(|r| !r.duplicate));
        assert_eq!(refs[0], import_ref("fp:", "2026-10-13|150|expense|café", 1));
        assert_eq!(refs[2], import_ref("fp:", "2026-10-13|150|expense|café", 3));
        assert_eq!(refs[3], import_ref("fp:", "2026-10-14|150|expense|café", 1));
        // El mismo fichero da las mismas referencias.
        let again = rows_of(csv, &mapping()).unwrap();
        assert_eq!(refs, again.iter().map(|r| r.import_ref.clone().unwrap()).collect::<Vec<_>>());
        // Un fichero solapado que solo trae la primera aparición reproduce su referencia.
        let overlap = rows_of("f;c;i\n2026-10-13;Café;-1,50\n", &mapping()).unwrap();
        assert_eq!(overlap[0].import_ref.as_ref(), Some(&refs[0]));
    }

    #[test]
    fn fingerprint_depends_on_date_amount_kind_and_description() {
        let csv = "f;c;i\n2026-10-13;a;-1,50\n2026-10-14;a;-1,50\n2026-10-13;a;-1,51\n2026-10-13;a;1,50\n2026-10-13;b;-1,50\n";
        let rows = rows_of(csv, &mapping()).unwrap();
        let refs: HashSet<_> = rows.iter().map(|r| r.import_ref.clone().unwrap()).collect();
        assert_eq!(refs.len(), 5);
    }

    #[test]
    fn bank_reference_alone_is_never_the_key() {
        let mut m = mapping();
        m.reference = Some(3);
        // El recibo domiciliado trae la misma referencia cada mes; "0" o "-" se repiten en muchas filas.
        let csv = "f;c;i;r\n2026-09-15;Recibo luz;-45,00;MANDATO-77\n2026-10-15;Recibo luz;-45,00;MANDATO-77\n2026-10-15;Otro;-9,00;0\n2026-10-16;Otro;-9,00;0\n2026-10-17;Otro;-9,00;-\n";
        let rows = rows_of(csv, &m).unwrap();
        let refs: HashSet<_> = rows.iter().map(|r| r.import_ref.clone().unwrap()).collect();
        assert_eq!(refs.len(), 5);
        assert!(rows.iter().all(|r| !r.duplicate && r.import_ref.as_deref().unwrap().starts_with("ref:")));
        // Cada mes, en su fichero, da la misma clave que dentro del fichero grande.
        let october = rows_of("f;c;i;r\n2026-10-15;Recibo luz;-45,00;MANDATO-77\n", &m).unwrap();
        assert_eq!(october[0].import_ref, rows[1].import_ref);
        assert_ne!(rows[0].import_ref, rows[1].import_ref);
        // La misma referencia con la misma fecha e importe repetida en el fichero son dos movimientos.
        let twice = rows_of("f;c;i;r\n2026-10-13;a;-1,00;X1\n2026-10-13;a;-1,00;X1\n", &m).unwrap();
        assert_ne!(twice[0].import_ref, twice[1].import_ref);
        assert!(!twice[1].duplicate);
        // La descripción no entra en la clave con referencia.
        let other = rows_of("f;c;i;r\n2026-10-13;zzz;-1,00;X1\n", &m).unwrap();
        assert_eq!(other[0].import_ref, twice[0].import_ref);
        // Sin referencia (vacía o en blanco) se cae a la huella.
        let none = rows_of("f;c;i;r\n2026-10-14;b;-2,00;\n2026-10-14;b;-2,00; \n", &m).unwrap();
        assert!(none.iter().all(|r| r.import_ref.as_deref().unwrap().starts_with("fp:")));
        assert_ne!(none[0].import_ref, none[1].import_ref);
        // Referencia desmedida: error de fila, no una clave de índice enorme.
        let long = format!("f;c;i;r\n2026-10-13;a;-1,00;{}\n", "r".repeat(201));
        assert!(rows_of(&long, &m).unwrap()[0].error.is_some());
    }

    // --- categoría sugerida ---

    fn usage(kind: Kind, desc: &str, cat: u128, count: i64, last: NaiveDate) -> Usage {
        Usage { kind, description: desc.into(), category_id: Uuid::from_u128(cat), count, last }
    }

    #[test]
    fn suggests_the_most_used_category_for_same_kind_and_normalized_description() {
        let csv = "f;c;i\n2026-10-01;Mercadona 0042;-5,00\n2026-10-01;Mercadona;5,00\n2026-10-01;Otra cosa;-5,00\n2026-10-01;123;-5,00\n";
        let mut rows = rows_of(csv, &mapping()).unwrap();
        let day = d(2026, 9, 1);
        suggest(
            &mut rows,
            vec![
                // Dos descripciones crudas distintas que normalizan igual se suman: cat 2 = 3 usos vs cat 1 = 2.
                usage(Kind::Expense, "MERCADONA 1111", 1, 2, day),
                usage(Kind::Expense, "mercadona", 2, 2, day),
                usage(Kind::Expense, "Mercadona  9", 2, 1, day),
                // Otro tipo: no cuenta para el gasto, sí para el ingreso.
                usage(Kind::Income, "Mercadona", 3, 1, day),
                usage(Kind::Expense, "123", 4, 9, day),
            ],
        );
        assert_eq!(rows[0].category_id, Some(Uuid::from_u128(2)));
        assert_eq!(rows[1].category_id, Some(Uuid::from_u128(3)));
        assert_eq!(rows[2].category_id, None);
        // Una descripción sin letras no sugiere nada.
        assert_eq!(rows[3].category_id, None);
    }

    #[test]
    fn suggestion_ties_go_to_the_most_recent_use() {
        let csv = "f;c;i\n2026-10-01;Gym;-5,00\n";
        let mut rows = rows_of(csv, &mapping()).unwrap();
        suggest(&mut rows, vec![usage(Kind::Expense, "Gym", 1, 3, d(2026, 1, 1)), usage(Kind::Expense, "Gym", 2, 3, d(2026, 6, 1))]);
        assert_eq!(rows[0].category_id, Some(Uuid::from_u128(2)));
    }

    #[test]
    fn rows_with_errors_get_no_suggestion() {
        let csv = "f;c;i\n2026-10-01;Gym;0\n";
        let mut rows = rows_of(csv, &mapping()).unwrap();
        suggest(&mut rows, vec![usage(Kind::Expense, "Gym", 1, 3, d(2026, 1, 1))]);
        assert_eq!(rows[0].category_id, None);
    }
}
