//! Escritura del CSV para Excel en español: BOM UTF-8, `;` como separador,
//! CRLF y decimales con coma. Sin crate externo: el formato es pequeño y el
//! escapado (con la defensa contra inyección de fórmulas) es lo delicado.

use super::calc::{self, CategoryEntry};
use crate::domain::{Bucket, Kind};
use chrono::NaiveDate;

const BOM: char = '\u{feff}';
const SEP: char = ';';
const EOL: &str = "\r\n";

/// Celda de texto (no fiable: viene del usuario) o numérica generada por el
/// servidor (no se toca: un importe negativo empieza por `-` legítimamente).
pub enum Cell<'a> {
    Text(&'a str),
    Number(String),
}

/// Prefija con `'` el texto que una hoja de cálculo interpretaría como fórmula.
fn neutralize_formula(text: &str) -> std::borrow::Cow<'_, str> {
    if text.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{text}").into()
    } else {
        text.into()
    }
}

/// RFC 4180: se entrecomilla si hay separador, comillas o saltos de línea.
fn quote_if_needed(text: &str) -> String {
    if text.contains([SEP, '"', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_string()
    }
}

pub fn escape_text(text: &str) -> String {
    quote_if_needed(&neutralize_formula(text))
}

pub fn write_row(out: &mut String, cells: &[Cell]) {
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            out.push(SEP);
        }
        match cell {
            Cell::Text(t) => out.push_str(&escape_text(t)),
            Cell::Number(n) => out.push_str(n),
        }
    }
    out.push_str(EOL);
}

pub fn kind_label(kind: Kind) -> &'static str {
    match kind {
        Kind::Income => "ingreso",
        Kind::Expense => "gasto",
    }
}

pub fn bucket_label(bucket: Option<Bucket>) -> &'static str {
    match bucket {
        Some(Bucket::Needs) => "necesidades",
        Some(Bucket::Wants) => "deseos",
        Some(Bucket::Savings) => "ahorro",
        None => "",
    }
}

/// Importe con signo: los gastos van en negativo.
fn signed(kind: Kind, cents: i64) -> i64 {
    if kind == Kind::Expense { -cents } else { cents }
}

/// Fila de movimiento tal como sale de SQL para el CSV.
pub struct TxRow {
    pub occurred_on: NaiveDate,
    pub kind: Kind,
    pub category_name: Option<String>,
    pub bucket: Option<Bucket>,
    pub description: Option<String>,
    pub amount_cents: i64,
}

pub fn transactions_csv(rows: &[TxRow]) -> String {
    let mut out = String::with_capacity(64 + rows.len() * 48);
    out.push(BOM);
    write_row(
        &mut out,
        &[
            Cell::Text("fecha"),
            Cell::Text("tipo"),
            Cell::Text("categoría"),
            Cell::Text("cubo"),
            Cell::Text("descripción"),
            Cell::Text("importe"),
        ],
    );
    for r in rows {
        write_row(
            &mut out,
            &[
                Cell::Number(r.occurred_on.format("%Y-%m-%d").to_string()),
                Cell::Text(kind_label(r.kind)),
                Cell::Text(r.category_name.as_deref().unwrap_or(calc::UNCATEGORIZED_NAME)),
                Cell::Text(bucket_label(r.bucket)),
                Cell::Text(r.description.as_deref().unwrap_or("")),
                Cell::Number(calc::format_decimal(signed(r.kind, r.amount_cents))),
            ],
        );
    }
    out
}

pub fn categories_csv(rows: &[&CategoryEntry]) -> String {
    let mut out = String::with_capacity(64 + rows.len() * 48);
    out.push(BOM);
    write_row(
        &mut out,
        &[
            Cell::Text("categoría"),
            Cell::Text("tipo"),
            Cell::Text("cubo"),
            Cell::Text("movimientos"),
            Cell::Text("importe"),
            Cell::Text("porcentaje"),
        ],
    );
    for c in rows {
        write_row(
            &mut out,
            &[
                Cell::Text(&c.name),
                Cell::Text(kind_label(c.kind)),
                Cell::Text(bucket_label(c.bucket)),
                Cell::Number(c.count.to_string()),
                Cell::Number(calc::format_decimal(signed(c.kind, c.amount_cents))),
                Cell::Number(calc::format_bp(c.share_bp)),
            ],
        );
    }
    out
}

/// Nombre de fichero restringido a `[a-z0-9-.]`.
pub fn safe_filename(scope: &str, period: &str, from: NaiveDate) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-' || *c == '.')
            .collect()
    };
    format!("cuentas-{}-{}-{}.csv", clean(scope), clean(period), from.format("%Y-%m-%d"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_untouched() {
        assert_eq!(escape_text("Supermercado"), "Supermercado");
        assert_eq!(escape_text(""), "");
        assert_eq!(escape_text("a-b=c+d@e"), "a-b=c+d@e");
    }

    #[test]
    fn formula_injection_is_neutralized() {
        for s in ["=1+1", "+34600", "-5", "@SUM(A1)", "\tcmd", "\rcmd"] {
            let out = escape_text(s);
            assert!(out.starts_with('\'') || out.starts_with("\"'"), "{s:?} -> {out:?}");
        }
        assert_eq!(escape_text("=1+1"), "'=1+1");
        assert_eq!(escape_text("@x"), "'@x");
        assert_eq!(escape_text("\tx"), "'\tx");
        // El \r inicial además obliga a entrecomillar.
        assert_eq!(escape_text("\rx"), "\"'\rx\"");
    }

    #[test]
    fn quotes_separators_and_newlines_are_escaped() {
        assert_eq!(escape_text("a;b"), "\"a;b\"");
        assert_eq!(escape_text("dijo \"hola\""), "\"dijo \"\"hola\"\"\"");
        assert_eq!(escape_text("l1\nl2"), "\"l1\nl2\"");
        assert_eq!(escape_text("l1\r\nl2"), "\"l1\r\nl2\"");
        // La coma no es separador aquí.
        assert_eq!(escape_text("1,5"), "1,5");
        // Fórmula con separador: se neutraliza y se entrecomilla.
        assert_eq!(escape_text("=A1;B1"), "\"'=A1;B1\"");
    }

    #[test]
    fn rows_use_semicolon_and_crlf_and_leave_numbers_alone() {
        let mut out = String::new();
        write_row(&mut out, &[Cell::Text("x"), Cell::Number("-12,50".into())]);
        assert_eq!(out, "x;-12,50\r\n");
    }

    fn tx(kind: Kind, cents: i64, desc: Option<&str>) -> TxRow {
        TxRow {
            occurred_on: NaiveDate::from_ymd_opt(2026, 9, 3).unwrap(),
            kind,
            category_name: Some("Vivienda".into()),
            bucket: Some(Bucket::Needs),
            description: desc.map(String::from),
            amount_cents: cents,
        }
    }

    #[test]
    fn transactions_csv_layout() {
        let csv = transactions_csv(&[tx(Kind::Expense, 1250, Some("=HYPERLINK(\"x\")")), tx(Kind::Income, 100_000, None)]);
        assert!(csv.starts_with("\u{feff}fecha;tipo;categoría;cubo;descripción;importe\r\n"));
        let lines: Vec<_> = csv.split("\r\n").collect();
        assert_eq!(lines[1], "2026-09-03;gasto;Vivienda;necesidades;\"'=HYPERLINK(\"\"x\"\")\";-12,50");
        assert_eq!(lines[2], "2026-09-03;ingreso;Vivienda;necesidades;;1000,00");
        assert_eq!(lines[3], "");
    }

    #[test]
    fn uncategorized_and_empty_bucket() {
        let mut row = tx(Kind::Expense, 100, None);
        row.category_name = None;
        row.bucket = None;
        let csv = transactions_csv(&[row]);
        assert!(csv.contains("2026-09-03;gasto;Sin categoría;;;-1,00\r\n"));
    }

    #[test]
    fn categories_csv_layout() {
        let e = CategoryEntry {
            category_id: None,
            name: "Comida; y cena".into(),
            color: "#000000".into(),
            kind: Kind::Expense,
            bucket: Some(Bucket::Needs),
            amount_cents: 42_000,
            count: 9,
            share_bp: 3_600,
        };
        let csv = categories_csv(&[&e]);
        assert!(csv.starts_with("\u{feff}categoría;tipo;cubo;movimientos;importe;porcentaje\r\n"));
        assert!(csv.ends_with("\"Comida; y cena\";gasto;necesidades;9;-420,00;36,00\r\n"));
    }

    #[test]
    fn filename_is_sanitized() {
        let from = NaiveDate::from_ymd_opt(2026, 9, 1).unwrap();
        assert_eq!(safe_filename("all", "month", from), "cuentas-all-month-2026-09-01.csv");
        assert_eq!(safe_filename("a\"b/../X", "m o", from), "cuentas-ab..-mo-2026-09-01.csv");
    }
}
