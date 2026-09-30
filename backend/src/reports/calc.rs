//! Lógica pura de los informes: periodos, validación de parámetros, reparto
//! por cubos, reglas de `insights` y formato de dinero en español. Sin BD ni
//! reloj (la fecha de hoy entra como parámetro), para poder testearlo todo.

use crate::domain::{Bucket, Kind};
use crate::error::{AppError, AppResult};
use crate::summary::calc::split_targets;
use chrono::{Datelike, Days, NaiveDate};
use serde::Serialize;
use uuid::Uuid;

pub const MIN_DATE: NaiveDate = NaiveDate::from_ymd_opt(2000, 1, 1).unwrap();
pub const MAX_DATE: NaiveDate = NaiveDate::from_ymd_opt(2100, 12, 31).unwrap();

pub const UNCATEGORIZED_NAME: &str = "Sin categoría";
pub const UNCATEGORIZED_COLOR: &str = "#9ca3af";

/// Umbral de `expense_change` y objetivo de ahorro, en puntos básicos.
const CHANGE_THRESHOLD_BP: i64 = 1500;
const SAVINGS_GOAL_BP: i64 = 2000;

// ---- Parámetros y periodos ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PeriodKind {
    Week,
    Month,
    Year,
}

impl PeriodKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PeriodKind::Week => "week",
            PeriodKind::Month => "month",
            PeriodKind::Year => "year",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Expenses,
    Income,
    All,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Expenses => "expenses",
            Scope::Income => "income",
            Scope::All => "all",
        }
    }

    pub fn includes(self, kind: Kind) -> bool {
        matches!(
            (self, kind),
            (Scope::All, _) | (Scope::Expenses, Kind::Expense) | (Scope::Income, Kind::Income)
        )
    }

    /// Filtro de `kind` para SQL: `None` = sin filtro.
    pub fn kind_filter(self) -> Option<Kind> {
        match self {
            Scope::Expenses => Some(Kind::Expense),
            Scope::Income => Some(Kind::Income),
            Scope::All => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    Transactions,
    Categories,
}

/// Periodo con `to` INCLUSIVO.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Period {
    pub kind: PeriodKind,
    pub from: NaiveDate,
    pub to: NaiveDate,
}

impl Period {
    pub fn days(&self) -> i64 {
        (self.to - self.from).num_days() + 1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub period: Period,
    pub scope: Scope,
}

pub fn parse_period_kind(raw: Option<&str>) -> AppResult<PeriodKind> {
    match raw {
        None => Ok(PeriodKind::Month),
        Some("week") => Ok(PeriodKind::Week),
        Some("month") => Ok(PeriodKind::Month),
        Some("year") => Ok(PeriodKind::Year),
        Some(other) => Err(AppError::Validation(format!(
            "period inválido: «{other}», debe ser week, month o year"
        ))),
    }
}

pub fn parse_scope(raw: Option<&str>) -> AppResult<Scope> {
    match raw {
        None => Ok(Scope::All),
        Some("expenses") => Ok(Scope::Expenses),
        Some("income") => Ok(Scope::Income),
        Some("all") => Ok(Scope::All),
        Some(other) => Err(AppError::Validation(format!(
            "scope inválido: «{other}», debe ser expenses, income o all"
        ))),
    }
}

pub fn parse_detail(raw: Option<&str>) -> AppResult<Detail> {
    match raw {
        None | Some("transactions") => Ok(Detail::Transactions),
        Some("categories") => Ok(Detail::Categories),
        Some(other) => Err(AppError::Validation(format!(
            "detail inválido: «{other}», debe ser transactions o categories"
        ))),
    }
}

/// Fecha estricta `YYYY-MM-DD` dentro del rango admitido.
pub fn parse_date(raw: &str) -> AppResult<NaiveDate> {
    let well_formed = raw.len() == 10
        && raw.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    let date = well_formed
        .then(|| NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok())
        .flatten()
        .ok_or_else(|| {
            AppError::Validation(format!("date inválida: «{raw}», usa el formato AAAA-MM-DD"))
        })?;
    if !(MIN_DATE..=MAX_DATE).contains(&date) {
        return Err(AppError::Validation(
            "date fuera de rango: debe estar entre 2000-01-01 y 2100-12-31".to_string(),
        ));
    }
    Ok(date)
}

/// Resuelve y valida los parámetros comunes. `today` se inyecta para que sea pura.
pub fn resolve_params(
    period: Option<&str>,
    date: Option<&str>,
    scope: Option<&str>,
    today: NaiveDate,
) -> AppResult<Params> {
    let kind = parse_period_kind(period)?;
    let scope = parse_scope(scope)?;
    let date = match date {
        Some(raw) => parse_date(raw)?,
        None => today.clamp(MIN_DATE, MAX_DATE),
    };
    Ok(Params { period: period_for(kind, date), scope })
}

/// Periodo que contiene a `date`: semana ISO (lunes-domingo), mes o año natural.
pub fn period_for(kind: PeriodKind, date: NaiveDate) -> Period {
    let (from, to) = match kind {
        PeriodKind::Week => {
            let monday = date - Days::new(date.weekday().num_days_from_monday() as u64);
            (monday, monday + Days::new(6))
        }
        PeriodKind::Month => {
            let first = date.with_day(1).expect("el día 1 siempre existe");
            let next = if date.month() == 12 {
                NaiveDate::from_ymd_opt(date.year() + 1, 1, 1)
            } else {
                NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1)
            }
            .expect("mes siguiente válido");
            (first, next.pred_opt().expect("fecha anterior válida"))
        }
        PeriodKind::Year => (
            NaiveDate::from_ymd_opt(date.year(), 1, 1).expect("1 de enero válido"),
            NaiveDate::from_ymd_opt(date.year(), 12, 31).expect("31 de diciembre válido"),
        ),
    };
    Period { kind, from, to }
}

/// Mismo tipo de periodo, inmediatamente anterior.
pub fn previous_period(p: &Period) -> Period {
    period_for(p.kind, p.from.pred_opt().expect("fecha anterior válida"))
}

// ---- Totales ----

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Totals {
    pub income_cents: i64,
    pub expense_cents: i64,
    pub net_cents: i64,
    pub transaction_count: i64,
    /// net / income en puntos básicos; `None` si no hay ingresos.
    pub savings_rate_bp: Option<i64>,
}

pub fn make_totals(income_cents: i64, expense_cents: i64, transaction_count: i64) -> Totals {
    let net_cents = income_cents - expense_cents;
    Totals {
        income_cents,
        expense_cents,
        net_cents,
        transaction_count,
        savings_rate_bp: ratio_bp(net_cents, income_cents),
    }
}

/// División entera redondeada al más cercano (mitades alejándose de 0).
/// `den` debe ser > 0.
pub fn round_div(num: i64, den: i64) -> i64 {
    let (num, den) = (num as i128, den as i128);
    let half = den / 2;
    let q = if num >= 0 { (num + half) / den } else { -((-num + half) / den) };
    q as i64
}

/// `part / whole` en puntos básicos; `None` si `whole` es 0.
pub fn ratio_bp(part: i64, whole: i64) -> Option<i64> {
    if whole <= 0 {
        return None;
    }
    let scaled = part as i128 * 10_000;
    let half = whole as i128 / 2;
    let q = if scaled >= 0 {
        (scaled + half) / whole as i128
    } else {
        -((-scaled + half) / whole as i128)
    };
    Some(q as i64)
}

/// Puntos básicos → porcentaje entero redondeado.
fn pct_int(bp: i64) -> i64 {
    round_div(bp, 100)
}

// ---- Categorías y cubos ----

/// Fila agregada tal como sale de SQL (una por categoría y tipo).
#[derive(Debug, Clone)]
pub struct CategoryAgg {
    pub category_id: Option<Uuid>,
    pub name: Option<String>,
    pub color: Option<String>,
    pub kind: Kind,
    pub bucket: Option<Bucket>,
    pub amount_cents: i64,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CategoryEntry {
    pub category_id: Option<Uuid>,
    pub name: String,
    pub color: String,
    pub kind: Kind,
    pub bucket: Option<Bucket>,
    pub amount_cents: i64,
    pub count: i64,
    pub share_bp: i64,
}

/// Todas las categorías con su peso sobre el total de SU tipo, ordenadas por
/// importe descendente (desempate por nombre para que sea determinista).
pub fn build_categories(rows: Vec<CategoryAgg>) -> Vec<CategoryEntry> {
    let total_of = |kind: Kind| -> i64 {
        rows.iter().filter(|r| r.kind == kind).map(|r| r.amount_cents).sum()
    };
    let (income_total, expense_total) = (total_of(Kind::Income), total_of(Kind::Expense));
    let mut out: Vec<CategoryEntry> = rows
        .into_iter()
        .map(|r| {
            let total = if r.kind == Kind::Income { income_total } else { expense_total };
            CategoryEntry {
                share_bp: ratio_bp(r.amount_cents, total).unwrap_or(0),
                category_id: r.category_id,
                name: r.name.unwrap_or_else(|| UNCATEGORIZED_NAME.to_string()),
                color: r.color.unwrap_or_else(|| UNCATEGORIZED_COLOR.to_string()),
                kind: r.kind,
                bucket: r.bucket,
                amount_cents: r.amount_cents,
                count: r.count,
            }
        })
        .collect();
    out.sort_by(|a, b| b.amount_cents.cmp(&a.amount_cents).then_with(|| a.name.cmp(&b.name)));
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BucketRow {
    pub bucket: Option<Bucket>,
    pub amount_cents: i64,
    pub target_cents: Option<i64>,
    pub income_share_bp: Option<i64>,
}

/// Siempre 4 filas: needs, wants, savings y gasto sin categoría (`bucket: null`).
/// Objetivos con la misma regla de reparto que `/api/summary`.
pub fn build_buckets(categories: &[CategoryEntry], income_cents: i64) -> Vec<BucketRow> {
    let amount_of = |bucket: Option<Bucket>| -> i64 {
        categories
            .iter()
            .filter(|c| c.kind == Kind::Expense && c.bucket == bucket)
            .map(|c| c.amount_cents)
            .sum()
    };
    let targets = (income_cents > 0).then(|| split_targets(income_cents));
    let row = |bucket: Option<Bucket>, target: Option<i64>| {
        let amount_cents = amount_of(bucket);
        BucketRow {
            bucket,
            amount_cents,
            target_cents: target.filter(|_| targets.is_some()),
            income_share_bp: ratio_bp(amount_cents, income_cents),
        }
    };
    let (needs, wants, savings) = targets.unwrap_or((0, 0, 0));
    vec![
        row(Some(Bucket::Needs), Some(needs)),
        row(Some(Bucket::Wants), Some(wants)),
        row(Some(Bucket::Savings), Some(savings)),
        row(None, None),
    ]
}

// ---- Serie y movimientos destacados ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SeriesPoint {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub income_cents: i64,
    pub expense_cents: i64,
}

impl SeriesPoint {
    /// Con `scope` limitado, la parte que queda fuera se pone a 0.
    pub fn apply_scope(mut self, scope: Scope) -> Self {
        if !scope.includes(Kind::Income) {
            self.income_cents = 0;
        }
        if !scope.includes(Kind::Expense) {
            self.expense_cents = 0;
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TopTransaction {
    pub id: Uuid,
    pub occurred_on: NaiveDate,
    pub kind: Kind,
    pub amount_cents: i64,
    pub description: Option<String>,
    pub category_name: Option<String>,
    pub category_color: Option<String>,
}

// ---- Respuesta ----

#[derive(Debug, Serialize)]
pub struct PreviousPeriod {
    pub period: Period,
    pub totals: Totals,
}

#[derive(Debug, Serialize)]
pub struct ReportResponse {
    pub period: Period,
    pub scope: Scope,
    pub totals: Totals,
    pub previous: PreviousPeriod,
    pub series: Vec<SeriesPoint>,
    pub by_category: Vec<CategoryEntry>,
    pub buckets: Vec<BucketRow>,
    pub top_transactions: Vec<TopTransaction>,
    pub insights: Vec<Insight>,
}

// ---- Insights ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Good,
    Info,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Insight {
    pub code: &'static str,
    pub level: Level,
    pub message: String,
}

fn insight(code: &'static str, level: Level, message: String) -> Insight {
    Insight { code, level, message }
}

pub struct InsightInput<'a> {
    pub period: &'a Period,
    pub totals: &'a Totals,
    pub previous: &'a Totals,
    /// Todas las categorías (ingreso y gasto), ordenadas por importe desc,
    /// sin filtrar por `scope`: los insights describen el periodo entero.
    pub categories: &'a [CategoryEntry],
    pub buckets: &'a [BucketRow],
    pub largest_expense: Option<&'a TopTransaction>,
}

pub fn build_insights(i: &InsightInput) -> Vec<Insight> {
    let t = i.totals;
    if t.transaction_count == 0 {
        return vec![insight("empty", Level::Info, "No hay movimientos en este periodo.".into())];
    }
    let mut out = Vec::new();

    if t.net_cents < 0 {
        out.push(insight(
            "negative_net",
            Level::Warning,
            format!("Has gastado {} más de lo que has ingresado.", format_money(-t.net_cents)),
        ));
    }

    if let (Some(bp), true) = (t.savings_rate_bp, t.net_cents >= 0) {
        let level = if bp >= SAVINGS_GOAL_BP { Level::Good } else { Level::Info };
        out.push(insight(
            "savings_rate",
            level,
            format!("Has ahorrado el {} % de tus ingresos (objetivo: 20 %).", pct_int(bp)),
        ));
    }

    if let Some(change_bp) = ratio_bp(t.expense_cents - i.previous.expense_cents, i.previous.expense_cents)
        && change_bp.abs() >= CHANGE_THRESHOLD_BP
    {
        let (level, verb) =
            if change_bp > 0 { (Level::Warning, "sube") } else { (Level::Good, "baja") };
        out.push(insight(
            "expense_change",
            level,
            format!(
                "El gasto {verb} un {} % respecto al periodo anterior ({} → {}).",
                pct_int(change_bp.abs()),
                format_money(i.previous.expense_cents),
                format_money(t.expense_cents),
            ),
        ));
    }

    if let Some(top) = i.categories.iter().find(|c| c.kind == Kind::Expense) {
        out.push(insight(
            "top_category",
            Level::Info,
            format!(
                "{} concentra el {} % del gasto ({}).",
                top.name,
                pct_int(top.share_bp),
                format_money(top.amount_cents)
            ),
        ));
    }

    if i.period.kind != PeriodKind::Week && t.income_cents > 0 {
        for (bucket, label) in [(Bucket::Needs, "Necesidades"), (Bucket::Wants, "Deseos")] {
            let Some(row) = i.buckets.iter().find(|r| r.bucket == Some(bucket)) else {
                continue;
            };
            if let (Some(target), Some(share)) = (row.target_cents, row.income_share_bp)
                && row.amount_cents > target
            {
                out.push(insight(
                    "bucket_over",
                    Level::Warning,
                    format!(
                        "{label}: {} % de los ingresos (objetivo {} %).",
                        pct_int(share),
                        bucket.target_pct()
                    ),
                ));
            }
        }
    }

    if let Some(tx) = i.largest_expense {
        let what = tx
            .description
            .as_deref()
            .or(tx.category_name.as_deref())
            .unwrap_or(UNCATEGORIZED_NAME);
        out.push(insight(
            "largest_expense",
            Level::Info,
            format!(
                "El mayor gasto fue {} ({what}, {}).",
                format_money(tx.amount_cents),
                format_date_es(tx.occurred_on)
            ),
        ));
    }

    // Se divide entre los días del periodo entero, no entre los transcurridos:
    // en el periodo en curso la media queda por debajo de la real hasta que acaba.
    if t.expense_cents > 0 {
        out.push(insight(
            "daily_average",
            Level::Info,
            format!(
                "Gasto medio diario: {}.",
                format_money(round_div(t.expense_cents, i.period.days()))
            ),
        ));
    }

    if let Some(row) = i.buckets.iter().find(|r| r.bucket.is_none())
        && row.amount_cents > 0
    {
        out.push(insight(
            "uncategorized",
            Level::Info,
            format!("Hay {} en gastos sin categoría.", format_money(row.amount_cents)),
        ));
    }

    out
}

// ---- Formato ----

/// Céntimos → "1.234,56 €" (negativos: "-1.234,56 €").
pub fn format_money(cents: i64) -> String {
    let abs = cents.unsigned_abs();
    let (units, rest) = (abs / 100, abs % 100);
    let digits = units.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push('.');
        }
        grouped.push(ch);
    }
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}{grouped},{rest:02} €")
}

/// Céntimos → "-12,50": decimales con coma, sin miles ni moneda (para el CSV).
pub fn format_decimal(cents: i64) -> String {
    let abs = cents.unsigned_abs();
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}{},{:02}", abs / 100, abs % 100)
}

/// Puntos básicos → "36,00" (para el CSV).
pub fn format_bp(bp: i64) -> String {
    format_decimal(bp)
}

pub fn format_date_es(d: NaiveDate) -> String {
    d.format("%d/%m/%Y").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    // ---- periodos ----

    #[test]
    fn week_is_monday_to_sunday() {
        // 2026-09-30 es miércoles.
        let p = period_for(PeriodKind::Week, d(2026, 9, 30));
        assert_eq!((p.from, p.to), (d(2026, 9, 28), d(2026, 10, 4)));
        assert_eq!(p.days(), 7);
        // Lunes y domingo pertenecen a la misma semana.
        assert_eq!(period_for(PeriodKind::Week, d(2026, 9, 28)), p);
        assert_eq!(period_for(PeriodKind::Week, d(2026, 10, 4)), p);
    }

    #[test]
    fn week_crossing_year() {
        // 2026-01-01 es jueves: la semana empieza en 2025.
        let p = period_for(PeriodKind::Week, d(2026, 1, 1));
        assert_eq!((p.from, p.to), (d(2025, 12, 29), d(2026, 1, 4)));
        let prev = previous_period(&p);
        assert_eq!((prev.from, prev.to), (d(2025, 12, 22), d(2025, 12, 28)));
    }

    #[test]
    fn month_lengths_and_leap_year() {
        let feb = period_for(PeriodKind::Month, d(2024, 2, 10));
        assert_eq!((feb.from, feb.to), (d(2024, 2, 1), d(2024, 2, 29)));
        assert_eq!(feb.days(), 29);
        let feb = period_for(PeriodKind::Month, d(2100, 2, 28)); // 2100 no es bisiesto
        assert_eq!(feb.to, d(2100, 2, 28));
        let dec = period_for(PeriodKind::Month, d(2026, 12, 15));
        assert_eq!((dec.from, dec.to), (d(2026, 12, 1), d(2026, 12, 31)));
    }

    #[test]
    fn year_bounds_and_leap_days() {
        let y = period_for(PeriodKind::Year, d(2024, 6, 15));
        assert_eq!((y.from, y.to), (d(2024, 1, 1), d(2024, 12, 31)));
        assert_eq!(y.days(), 366);
        assert_eq!(period_for(PeriodKind::Year, d(2025, 6, 15)).days(), 365);
    }

    #[test]
    fn previous_period_of_each_kind() {
        let m = period_for(PeriodKind::Month, d(2026, 3, 5));
        let pm = previous_period(&m);
        assert_eq!((pm.from, pm.to), (d(2026, 2, 1), d(2026, 2, 28)));
        let jan = period_for(PeriodKind::Month, d(2026, 1, 5));
        let pj = previous_period(&jan);
        assert_eq!((pj.from, pj.to), (d(2025, 12, 1), d(2025, 12, 31)));
        let y = previous_period(&period_for(PeriodKind::Year, d(2025, 6, 1)));
        assert_eq!((y.from, y.to), (d(2024, 1, 1), d(2024, 12, 31)));
        // Tras febrero bisiesto.
        let mar = previous_period(&period_for(PeriodKind::Month, d(2024, 3, 1)));
        assert_eq!(mar.to, d(2024, 2, 29));
    }

    #[test]
    fn extremes_of_valid_range_do_not_panic() {
        let first = period_for(PeriodKind::Week, MIN_DATE);
        assert_eq!(first.from, d(1999, 12, 27));
        previous_period(&first);
        let last = period_for(PeriodKind::Week, MAX_DATE);
        assert_eq!(last.to, d(2101, 1, 2));
        previous_period(&period_for(PeriodKind::Year, MIN_DATE));
        previous_period(&period_for(PeriodKind::Month, MAX_DATE));
    }

    // ---- parámetros ----

    #[test]
    fn params_defaults() {
        let p = resolve_params(None, None, None, d(2026, 9, 30)).unwrap();
        assert_eq!(p.scope, Scope::All);
        assert_eq!(p.period.kind, PeriodKind::Month);
        assert_eq!((p.period.from, p.period.to), (d(2026, 9, 1), d(2026, 9, 30)));
    }

    #[test]
    fn params_normalize_date_to_period() {
        let p = resolve_params(Some("year"), Some("2024-07-04"), Some("expenses"), d(2026, 1, 1)).unwrap();
        assert_eq!((p.period.from, p.period.to), (d(2024, 1, 1), d(2024, 12, 31)));
        assert_eq!(p.scope, Scope::Expenses);
    }

    #[test]
    fn params_reject_invalid_values() {
        let today = d(2026, 9, 30);
        assert!(resolve_params(Some("day"), None, None, today).is_err());
        assert!(resolve_params(Some(""), None, None, today).is_err());
        assert!(resolve_params(None, None, Some("todo"), today).is_err());
        for bad in ["2026-13-01", "2026-02-30", "2026-9-1", "26-09-01", "", "2026/09/01", "2026-09-01 ", "+026-09-01"] {
            assert!(resolve_params(None, Some(bad), None, today).is_err(), "{bad}");
        }
        assert!(resolve_params(None, Some("1999-12-31"), None, today).is_err());
        assert!(resolve_params(None, Some("2101-01-01"), None, today).is_err());
        assert!(resolve_params(None, Some("2000-01-01"), None, today).is_ok());
        assert!(resolve_params(None, Some("2100-12-31"), None, today).is_ok());
    }

    #[test]
    fn today_out_of_range_is_clamped() {
        let p = resolve_params(None, None, None, d(2150, 1, 1)).unwrap();
        assert_eq!(p.period.from, d(2100, 12, 1));
    }

    #[test]
    fn detail_parsing() {
        assert_eq!(parse_detail(None).unwrap(), Detail::Transactions);
        assert_eq!(parse_detail(Some("categories")).unwrap(), Detail::Categories);
        assert!(parse_detail(Some("x")).is_err());
    }

    // ---- aritmética ----

    #[test]
    fn ratios_round_half_away_from_zero() {
        assert_eq!(ratio_bp(70_000, 250_000), Some(2_800));
        assert_eq!(ratio_bp(1, 3), Some(3_333));
        assert_eq!(ratio_bp(2, 3), Some(6_667));
        assert_eq!(ratio_bp(-1, 3), Some(-3_333));
        assert_eq!(ratio_bp(5, 0), None);
        assert_eq!(round_div(5, 2), 3);
        assert_eq!(round_div(-5, 2), -3);
        assert_eq!(round_div(7, 3), 2);
    }

    #[test]
    fn totals_savings_rate() {
        let t = make_totals(250_000, 180_000, 42);
        assert_eq!((t.net_cents, t.savings_rate_bp), (70_000, Some(2_800)));
        assert_eq!(make_totals(0, 500, 1).savings_rate_bp, None);
        assert_eq!(make_totals(1_000, 1_500, 2).savings_rate_bp, Some(-5_000));
    }

    // ---- categorías y cubos ----

    fn agg(name: Option<&str>, kind: Kind, bucket: Option<Bucket>, amount: i64, count: i64) -> CategoryAgg {
        CategoryAgg {
            category_id: name.map(|_| Uuid::nil()),
            name: name.map(String::from),
            color: name.map(|_| "#112233".to_string()),
            kind,
            bucket,
            amount_cents: amount,
            count,
        }
    }

    #[test]
    fn categories_sorted_with_share_per_kind_and_uncategorized_defaults() {
        let cats = build_categories(vec![
            agg(Some("Ocio"), Kind::Expense, Some(Bucket::Wants), 2500, 1),
            agg(None, Kind::Expense, None, 2500, 2),
            agg(Some("Alquiler"), Kind::Expense, Some(Bucket::Needs), 5000, 1),
            agg(Some("Nómina"), Kind::Income, None, 10000, 1),
        ]);
        let names: Vec<_> = cats.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Nómina", "Alquiler", "Ocio", "Sin categoría"]);
        assert_eq!(cats[0].share_bp, 10_000); // 100 % de los ingresos
        assert_eq!(cats[1].share_bp, 5_000);
        let unc = &cats[3];
        assert_eq!((unc.category_id, unc.color.as_str(), unc.bucket), (None, "#9ca3af", None));
    }

    #[test]
    fn buckets_always_four_rows_with_targets() {
        let cats = build_categories(vec![
            agg(Some("Alquiler"), Kind::Expense, Some(Bucket::Needs), 90_000, 1),
            agg(Some("Ocio"), Kind::Expense, Some(Bucket::Wants), 60_000, 1),
            agg(Some("Inversión"), Kind::Expense, Some(Bucket::Savings), 20_000, 1),
            agg(None, Kind::Expense, None, 10_000, 1),
        ]);
        let b = build_buckets(&cats, 250_000);
        assert_eq!(b.len(), 4);
        assert_eq!(
            b[0],
            BucketRow { bucket: Some(Bucket::Needs), amount_cents: 90_000, target_cents: Some(125_000), income_share_bp: Some(3_600) }
        );
        assert_eq!(b[1].target_cents, Some(75_000));
        assert_eq!(b[2].target_cents, Some(50_000));
        assert_eq!(b[2].income_share_bp, Some(800));
        assert_eq!(
            b[3],
            BucketRow { bucket: None, amount_cents: 10_000, target_cents: None, income_share_bp: Some(400) }
        );
    }

    #[test]
    fn buckets_without_income_have_null_targets_and_shares() {
        let b = build_buckets(&[], 0);
        assert_eq!(b.len(), 4);
        assert!(b.iter().all(|r| r.amount_cents == 0 && r.target_cents.is_none() && r.income_share_bp.is_none()));
    }

    #[test]
    fn series_point_scope_zeroes_other_side() {
        let p = SeriesPoint { from: d(2026, 1, 1), to: d(2026, 1, 1), income_cents: 5, expense_cents: 7 };
        assert_eq!(p.clone().apply_scope(Scope::Expenses).income_cents, 0);
        assert_eq!(p.clone().apply_scope(Scope::Income).expense_cents, 0);
        assert_eq!(p.clone().apply_scope(Scope::All), p);
    }

    // ---- dinero ----

    #[test]
    fn money_format() {
        assert_eq!(format_money(0), "0,00 €");
        assert_eq!(format_money(5), "0,05 €");
        assert_eq!(format_money(99), "0,99 €");
        assert_eq!(format_money(100), "1,00 €");
        assert_eq!(format_money(123_456), "1.234,56 €");
        assert_eq!(format_money(100_000_000), "1.000.000,00 €");
        assert_eq!(format_money(99_999), "999,99 €");
        assert_eq!(format_money(-1_250), "-12,50 €");
        assert_eq!(format_money(-123_456), "-1.234,56 €");
        assert_eq!(format_money(i64::MIN), "-92.233.720.368.547.758,08 €");
    }

    #[test]
    fn decimal_and_bp_format() {
        assert_eq!(format_decimal(-1_250), "-12,50");
        assert_eq!(format_decimal(5), "0,05");
        assert_eq!(format_decimal(123_456), "1234,56");
        assert_eq!(format_bp(3_600), "36,00");
        assert_eq!(format_bp(2_333), "23,33");
        assert_eq!(format_date_es(d(2026, 9, 3)), "03/09/2026");
    }

    // ---- insights ----

    struct Case {
        period: Period,
        totals: Totals,
        previous: Totals,
        categories: Vec<CategoryEntry>,
        buckets: Vec<BucketRow>,
        largest: Option<TopTransaction>,
    }

    impl Case {
        fn run(&self) -> Vec<Insight> {
            build_insights(&InsightInput {
                period: &self.period,
                totals: &self.totals,
                previous: &self.previous,
                categories: &self.categories,
                buckets: &self.buckets,
                largest_expense: self.largest.as_ref(),
            })
        }
        fn codes(&self) -> Vec<&'static str> {
            self.run().iter().map(|i| i.code).collect()
        }
        fn find(&self, code: &str) -> Option<Insight> {
            self.run().into_iter().find(|i| i.code == code)
        }
    }

    /// Ingresos 2.500 €, gasto 1.800 € (mes de 30 días), anterior: gasto 1.800 €.
    fn case(rows: Vec<CategoryAgg>) -> Case {
        let categories = build_categories(rows);
        let income: i64 = categories.iter().filter(|c| c.kind == Kind::Income).map(|c| c.amount_cents).sum();
        let expense: i64 = categories.iter().filter(|c| c.kind == Kind::Expense).map(|c| c.amount_cents).sum();
        let count: i64 = categories.iter().map(|c| c.count).sum();
        Case {
            period: period_for(PeriodKind::Month, d(2026, 9, 10)),
            totals: make_totals(income, expense, count),
            previous: make_totals(income, expense, 5),
            buckets: build_buckets(&categories, income),
            categories,
            largest: None,
        }
    }

    fn base_rows() -> Vec<CategoryAgg> {
        vec![
            agg(Some("Nómina"), Kind::Income, None, 250_000, 1),
            agg(Some("Vivienda"), Kind::Expense, Some(Bucket::Needs), 65_000, 1),
            agg(Some("Ocio"), Kind::Expense, Some(Bucket::Wants), 20_000, 3),
        ]
    }

    #[test]
    fn insights_empty_is_alone() {
        let mut c = case(vec![]);
        c.previous = make_totals(10_000, 5_000, 3);
        let out = c.run();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].code, "empty");
        assert_eq!(out[0].level, Level::Info);
        assert_eq!(out[0].message, "No hay movimientos en este periodo.");
    }

    #[test]
    fn insights_negative_net_and_no_savings_rate() {
        let c = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 100_000, 1),
            agg(Some("Vivienda"), Kind::Expense, Some(Bucket::Needs), 150_000, 1),
        ]);
        let i = c.find("negative_net").unwrap();
        assert_eq!(i.level, Level::Warning);
        assert_eq!(i.message, "Has gastado 500,00 € más de lo que has ingresado.");
        assert!(c.find("savings_rate").is_none());
    }

    #[test]
    fn insights_savings_rate_levels() {
        // 2.500 ingresados, 850 gastados -> 66 %.
        let c = case(base_rows());
        let i = c.find("savings_rate").unwrap();
        assert_eq!(i.level, Level::Good);
        assert_eq!(i.message, "Has ahorrado el 66 % de tus ingresos (objetivo: 20 %).");

        // Justo 20 % = good; 19,99 % = info.
        let mut exact = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 10_000, 1),
            agg(Some("X"), Kind::Expense, Some(Bucket::Needs), 8_000, 1),
        ]);
        assert_eq!(exact.find("savings_rate").unwrap().level, Level::Good);
        exact.totals = make_totals(10_000, 8_001, 2);
        assert_eq!(exact.find("savings_rate").unwrap().level, Level::Info);

        // Ahorro 0 % (net == 0): se muestra como info.
        let zero = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 10_000, 1),
            agg(Some("X"), Kind::Expense, Some(Bucket::Needs), 10_000, 1),
        ]);
        let z = zero.find("savings_rate").unwrap();
        assert_eq!(z.level, Level::Info);
        assert!(z.message.starts_with("Has ahorrado el 0 %"));
    }

    #[test]
    fn insights_income_zero_omits_rate_and_bucket_rules() {
        let c = case(vec![agg(Some("Vivienda"), Kind::Expense, Some(Bucket::Needs), 50_000, 1)]);
        assert_eq!(c.totals.income_cents, 0);
        let codes = c.codes();
        assert!(codes.contains(&"negative_net"));
        assert!(!codes.contains(&"savings_rate"));
        assert!(!codes.contains(&"bucket_over"));
    }

    #[test]
    fn insights_expense_change_thresholds() {
        let mut c = case(base_rows()); // gasto actual 850 €
        // Anterior 0: se omite.
        c.previous = make_totals(0, 0, 0);
        assert!(c.find("expense_change").is_none());
        // Anterior 700: +21 % -> warning.
        c.previous = make_totals(0, 70_000, 1);
        let up = c.find("expense_change").unwrap();
        assert_eq!(up.level, Level::Warning);
        assert_eq!(up.message, "El gasto sube un 21 % respecto al periodo anterior (700,00 € → 850,00 €).");
        // Anterior 1.000: -15 % exacto -> good.
        c.previous = make_totals(0, 100_000, 1);
        let down = c.find("expense_change").unwrap();
        assert_eq!(down.level, Level::Good);
        assert!(down.message.starts_with("El gasto baja un 15 %"));
        // Anterior 900: -5,6 % -> omitida. Anterior 739,13: +15 % justo.
        c.previous = make_totals(0, 90_000, 1);
        assert!(c.find("expense_change").is_none());
        c.previous = make_totals(0, 73_913, 1); // 85.000 / 73.913 = +15,0001 %
        assert_eq!(c.find("expense_change").unwrap().level, Level::Warning);
        c.previous = make_totals(0, 73_914, 1); // +14,9999 % -> 1500 bp tras redondeo
        assert!(c.find("expense_change").is_some());
        c.previous = make_totals(0, 74_000, 1); // +14,86 %
        assert!(c.find("expense_change").is_none());
    }

    #[test]
    fn insights_top_category_includes_uncategorized() {
        let c = case(base_rows());
        let i = c.find("top_category").unwrap();
        assert_eq!(i.message, "Vivienda concentra el 76 % del gasto (650,00 €).");

        let c = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 100_000, 1),
            agg(None, Kind::Expense, None, 9_000, 2),
            agg(Some("Ocio"), Kind::Expense, Some(Bucket::Wants), 1_000, 1),
        ]);
        assert!(c.find("top_category").unwrap().message.starts_with("Sin categoría concentra el 90 %"));
    }

    #[test]
    fn insights_bucket_over() {
        // Ingresos 2.500: necesidades 1.300 (52 %) > 1.250; deseos 800 (32 %) > 750.
        let c = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 250_000, 1),
            agg(Some("Vivienda"), Kind::Expense, Some(Bucket::Needs), 130_000, 1),
            agg(Some("Ocio"), Kind::Expense, Some(Bucket::Wants), 80_000, 1),
        ]);
        let over: Vec<_> = c.run().into_iter().filter(|i| i.code == "bucket_over").collect();
        assert_eq!(over.len(), 2);
        assert_eq!(over[0].message, "Necesidades: 52 % de los ingresos (objetivo 50 %).");
        assert_eq!(over[1].message, "Deseos: 32 % de los ingresos (objetivo 30 %).");
        assert!(over.iter().all(|i| i.level == Level::Warning));

        // Justo en el objetivo: no salta. El ahorro nunca salta.
        let exact = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 250_000, 1),
            agg(Some("Vivienda"), Kind::Expense, Some(Bucket::Needs), 125_000, 1),
            agg(Some("Inv"), Kind::Expense, Some(Bucket::Savings), 200_000, 1),
        ]);
        assert!(exact.find("bucket_over").is_none());

        // En semanas no aplica.
        let mut week = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 250_000, 1),
            agg(Some("Vivienda"), Kind::Expense, Some(Bucket::Needs), 130_000, 1),
        ]);
        week.period = period_for(PeriodKind::Week, d(2026, 9, 10));
        assert!(week.find("bucket_over").is_none());
        // En año sí.
        week.period = period_for(PeriodKind::Year, d(2026, 9, 10));
        assert!(week.find("bucket_over").is_some());
    }

    #[test]
    fn insights_largest_expense_label() {
        let mut c = case(base_rows());
        let tx = TopTransaction {
            id: Uuid::nil(),
            occurred_on: d(2026, 9, 3),
            kind: Kind::Expense,
            amount_cents: 65_000,
            description: Some("Alquiler".into()),
            category_name: Some("Vivienda".into()),
            category_color: None,
        };
        c.largest = Some(tx.clone());
        assert_eq!(
            c.find("largest_expense").unwrap().message,
            "El mayor gasto fue 650,00 € (Alquiler, 03/09/2026)."
        );
        c.largest = Some(TopTransaction { description: None, ..tx.clone() });
        assert!(c.find("largest_expense").unwrap().message.contains("(Vivienda, "));
        c.largest = Some(TopTransaction { description: None, category_name: None, ..tx });
        assert!(c.find("largest_expense").unwrap().message.contains("(Sin categoría, "));
    }

    #[test]
    fn insights_daily_average_uses_period_days() {
        let c = case(base_rows()); // 850 € en 30 días -> 28,33
        assert_eq!(c.find("daily_average").unwrap().message, "Gasto medio diario: 28,33 €.");
        // Sin gastos no se emite.
        let income_only = case(vec![agg(Some("Nómina"), Kind::Income, None, 10_000, 1)]);
        assert!(income_only.find("daily_average").is_none());
        assert!(income_only.find("top_category").is_none());
    }

    #[test]
    fn insights_uncategorized() {
        let c = case(base_rows());
        assert!(c.find("uncategorized").is_none());
        let c = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 100_000, 1),
            agg(None, Kind::Expense, None, 123_456, 1),
        ]);
        assert_eq!(c.find("uncategorized").unwrap().message, "Hay 1.234,56 € en gastos sin categoría.");
    }

    #[test]
    fn insights_order_is_the_documented_one() {
        let mut c = case(vec![
            agg(Some("Nómina"), Kind::Income, None, 100_000, 1),
            agg(Some("Vivienda"), Kind::Expense, Some(Bucket::Needs), 70_000, 1),
            agg(None, Kind::Expense, None, 10_000, 1),
        ]);
        c.previous = make_totals(0, 40_000, 1);
        c.largest = Some(TopTransaction {
            id: Uuid::nil(),
            occurred_on: d(2026, 9, 3),
            kind: Kind::Expense,
            amount_cents: 70_000,
            description: None,
            category_name: Some("Vivienda".into()),
            category_color: None,
        });
        assert_eq!(
            c.codes(),
            ["savings_rate", "expense_change", "top_category", "bucket_over", "largest_expense", "daily_average", "uncategorized"]
        );
    }
}
