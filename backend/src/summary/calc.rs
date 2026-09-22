//! Aritmética pura del resumen 50/30/20. Nada de aquí toca la base de datos:
//! todo son `i64`/`f64` de entrada y estructuras de salida. Así se puede testear
//! exhaustivamente sin `podman` ni Postgres — y esto es lo que la persona usa
//! para decidir sobre su dinero, así que tiene que estar bien.

use crate::domain::{Bucket, Category};
use crate::error::AppError;
use chrono::{Datelike, NaiveDate};
use serde::Serialize;

/// Gasto categorizado del mes, agregado por cubo 50/30/20. Cada campo es la
/// suma de `amount_cents` de las transacciones `expense` cuya categoría tiene
/// ese `bucket`. Los gastos sin categoría NO entran aquí (ver
/// [`compute_summary`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BucketExpenses {
    pub needs_cents: i64,
    pub wants_cents: i64,
    pub savings_cents: i64,
}

impl BucketExpenses {
    fn categorized_total(&self) -> i64 {
        self.needs_cents + self.wants_cents + self.savings_cents
    }
}

#[derive(Debug, Serialize)]
pub struct SummaryResponse {
    pub month: String,
    pub income_cents: i64,
    pub expense_cents: i64,
    pub buckets: Vec<BucketSummary>,
    pub uncategorized_expense_cents: i64,
    pub by_category: Vec<CategoryAmount>,
}

#[derive(Debug, Serialize)]
pub struct BucketSummary {
    pub bucket: Bucket,
    pub target_pct: i64,
    pub target_cents: i64,
    pub actual_cents: i64,
    pub delta_cents: i64,
    pub actual_pct: f64,
}

#[derive(Debug, Serialize)]
pub struct CategoryAmount {
    pub category: Category,
    pub amount_cents: i64,
    pub pct_of_income: f64,
}

#[derive(Debug, Serialize)]
pub struct TrendResponse {
    pub points: Vec<TrendPoint>,
}

#[derive(Debug, Serialize)]
pub struct TrendPoint {
    pub month: String,
    pub income_cents: i64,
    pub needs_cents: i64,
    pub wants_cents: i64,
    pub savings_cents: i64,
}

/// Reparte `income_cents` entre los tres objetivos del 50/30/20.
///
/// Regla de redondeo elegida: `needs_target` y `wants_target` se calculan por
/// división entera truncada (`income * pct / 100`, en `i128` para no
/// desbordar en el producto intermedio); `savings_target` es el resto
/// (`income - needs_target - wants_target`), NO `income * 20 / 100`. Así los
/// tres objetivos SIEMPRE suman exactamente `income_cents`, céntimo a
/// céntimo, incluso cuando el ingreso no es divisible entre 10 (p. ej. 1001
/// céntimos → needs=500, wants=300, savings=201; el 20% "puro" de 1001 sería
/// 200,2, pero el resto se lo lleva el cubo savings para que la suma cuadre).
/// Si `income_cents` es 0, los tres objetivos son 0 sin dividir por cero.
fn split_targets(income_cents: i64) -> (i64, i64, i64) {
    let needs = target_cents(income_cents, Bucket::Needs.target_pct());
    let wants = target_cents(income_cents, Bucket::Wants.target_pct());
    let savings = income_cents - needs - wants;
    (needs, wants, savings)
}

fn target_cents(income_cents: i64, pct: i64) -> i64 {
    ((income_cents as i128 * pct as i128) / 100) as i64
}

/// Porcentaje `part / whole * 100`, redondeado a 1 decimal. 0 si `whole` es 0
/// (evita dividir por cero; así se comporta también para ingreso 0).
fn pct_1dp(part: i64, whole: i64) -> f64 {
    if whole == 0 {
        return 0.0;
    }
    let raw = (part as f64 / whole as f64) * 100.0;
    (raw * 10.0).round() / 10.0
}

/// Calcula el resumen 50/30/20 completo de un mes. Pura: sin BD, sin reloj.
///
/// `bucket_expenses`: gasto categorizado por cubo (needs/wants/savings) —
/// solo transacciones `expense` con categoría.
/// `uncategorized_expense_cents`: gasto `expense` SIN categoría. No entra en
/// ningún cubo de `buckets` (ni en `by_category`), pero sí cuenta dentro de
/// `expense_cents` y por tanto reduce el "dinero no gastado" que alimenta el
/// ahorro implícito del cubo `savings` — ver semántica abajo.
/// `category_expenses`: gasto agregado por categoría de gasto (para
/// `by_category`); se reordena aquí, no hace falta que venga ordenado.
///
/// Semántica del cubo `savings` (documentada porque no es obvia — ver
/// `docs/API.md`): `actual_cents` de `savings` = gastos categorizados como
/// `savings` **más** `max(0, income_cents - expense_cents)`, es decir el
/// dinero que simplemente no se gastó también cuenta como ahorro.
pub fn compute_summary(
    month: String,
    income_cents: i64,
    bucket_expenses: BucketExpenses,
    uncategorized_expense_cents: i64,
    category_expenses: Vec<(Category, i64)>,
) -> SummaryResponse {
    let expense_cents = bucket_expenses.categorized_total() + uncategorized_expense_cents;
    let (needs_target, wants_target, savings_target) = split_targets(income_cents);
    let leftover = (income_cents - expense_cents).max(0);
    let savings_actual = bucket_expenses.savings_cents + leftover;

    let buckets = vec![
        bucket_summary(
            Bucket::Needs,
            needs_target,
            bucket_expenses.needs_cents,
            income_cents,
        ),
        bucket_summary(
            Bucket::Wants,
            wants_target,
            bucket_expenses.wants_cents,
            income_cents,
        ),
        bucket_summary(Bucket::Savings, savings_target, savings_actual, income_cents),
    ];

    let mut by_category: Vec<CategoryAmount> = category_expenses
        .into_iter()
        .map(|(category, amount_cents)| CategoryAmount {
            pct_of_income: pct_1dp(amount_cents, income_cents),
            category,
            amount_cents,
        })
        .collect();
    // Orden descendente por importe.
    by_category.sort_by(|a, b| b.amount_cents.cmp(&a.amount_cents));

    SummaryResponse {
        month,
        income_cents,
        expense_cents,
        buckets,
        uncategorized_expense_cents,
        by_category,
    }
}

fn bucket_summary(bucket: Bucket, target_cents: i64, actual_cents: i64, income_cents: i64) -> BucketSummary {
    BucketSummary {
        bucket,
        target_pct: bucket.target_pct(),
        target_cents,
        actual_cents,
        delta_cents: actual_cents - target_cents,
        actual_pct: pct_1dp(actual_cents, income_cents),
    }
}

/// Un punto de la serie temporal, con LA MISMA semántica que
/// [`compute_summary`] (se apoya en ella: mismo cálculo de objetivos, mismo
/// ahorro implícito). `by_category` no aplica aquí, así que se descarta.
pub fn compute_trend_point(
    month: String,
    income_cents: i64,
    bucket_expenses: BucketExpenses,
    uncategorized_expense_cents: i64,
) -> TrendPoint {
    let summary = compute_summary(
        month.clone(),
        income_cents,
        bucket_expenses,
        uncategorized_expense_cents,
        Vec::new(),
    );
    TrendPoint {
        month,
        income_cents: summary.income_cents,
        needs_cents: summary.buckets[0].actual_cents,
        wants_cents: summary.buckets[1].actual_cents,
        savings_cents: summary.buckets[2].actual_cents,
    }
}

/// Parsea `YYYY-MM` a `(año, mes)`. Mes mal formado (separador raro, mes
/// fuera de 1..=12, año no numérico, basura) → `AppError::Validation` con
/// mensaje en español.
pub fn parse_month(s: &str) -> Result<(i32, u32), AppError> {
    let invalid = || AppError::Validation(format!("mes inválido: «{s}», usa el formato AAAA-MM"));

    let (y, m) = s.split_once('-').ok_or_else(invalid)?;
    if y.len() != 4 || m.len() != 2 {
        return Err(invalid());
    }
    let year: i32 = y.parse().map_err(|_| invalid())?;
    let month: u32 = m.parse().map_err(|_| invalid())?;
    if !(1..=12).contains(&month) {
        return Err(invalid());
    }
    Ok((year, month))
}

/// Rango `[primer día del mes, primer día del mes siguiente)` para usar en
/// `occurred_on >= $1 AND occurred_on < $2`. Maneja diciembre → enero del
/// año siguiente.
pub fn month_range(year: i32, month: u32) -> (NaiveDate, NaiveDate) {
    let from = NaiveDate::from_ymd_opt(year, month, 1).expect("año/mes validados por parse_month");
    let to = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .expect("año/mes validados por parse_month");
    (from, to)
}

/// Primer día del mes que empieza `n` meses (0..) antes de `(year, month)`.
/// Usado por `/trend` para construir el límite inferior de `generate_series`.
pub fn month_start_n_back(year: i32, month: u32, n: u32) -> NaiveDate {
    let start = NaiveDate::from_ymd_opt(year, month, 1).expect("año/mes validados por parse_month");
    start
        .checked_sub_months(chrono::Months::new(n))
        .expect("rango de fechas representable")
}

/// Formatea `(año, mes)` como `AAAA-MM`.
pub fn format_month(year: i32, month: u32) -> String {
    format!("{year:04}-{month:02}")
}

pub fn ymd_to_month(date: NaiveDate) -> (i32, u32) {
    (date.year(), date.month())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(name: &str, bucket: Option<Bucket>) -> Category {
        Category {
            id: uuid::Uuid::nil(),
            name: name.to_string(),
            kind: if bucket.is_some() {
                crate::domain::Kind::Expense
            } else {
                crate::domain::Kind::Income
            },
            bucket,
            color: "#000000".to_string(),
            icon: "circle".to_string(),
            is_archived: false,
            sort_order: 0,
        }
    }

    // ---- compute_summary ----

    #[test]
    fn income_zero_todo_a_cero() {
        let s = compute_summary("2026-01".into(), 0, BucketExpenses::default(), 0, vec![]);
        assert_eq!(s.income_cents, 0);
        assert_eq!(s.expense_cents, 0);
        for b in &s.buckets {
            assert_eq!(b.target_cents, 0);
            assert_eq!(b.actual_cents, 0);
            assert_eq!(b.delta_cents, 0);
            assert_eq!(b.actual_pct, 0.0);
        }
        assert_eq!(s.uncategorized_expense_cents, 0);
        assert!(s.by_category.is_empty());
    }

    #[test]
    fn sin_gastos_ahorro_actual_es_el_ingreso_entero() {
        let s = compute_summary("2026-01".into(), 200_000, BucketExpenses::default(), 0, vec![]);
        assert_eq!(s.expense_cents, 0);
        let savings = s.buckets.iter().find(|b| b.bucket == Bucket::Savings).unwrap();
        assert_eq!(savings.target_cents, 40_000); // 20% de 200000
        assert_eq!(savings.actual_cents, 200_000); // nada gastado => todo ahorrado
        assert_eq!(savings.delta_cents, 160_000);
        assert_eq!(savings.actual_pct, 100.0);

        let needs = s.buckets.iter().find(|b| b.bucket == Bucket::Needs).unwrap();
        assert_eq!(needs.actual_cents, 0);
        assert_eq!(needs.delta_cents, -needs.target_cents);
    }

    #[test]
    fn gastos_superan_ingreso_ahorro_implicito_con_suelo_en_cero() {
        // Ingreso 100000, needs 80000, wants 40000 categorizados (total 120000 > ingreso).
        let bucket_expenses = BucketExpenses {
            needs_cents: 80_000,
            wants_cents: 40_000,
            savings_cents: 0,
        };
        let s = compute_summary("2026-01".into(), 100_000, bucket_expenses, 0, vec![]);
        assert_eq!(s.expense_cents, 120_000);

        let savings = s.buckets.iter().find(|b| b.bucket == Bucket::Savings).unwrap();
        // leftover = max(0, 100000 - 120000) = 0; savings actual = 0 (categorizado) + 0
        assert_eq!(savings.actual_cents, 0);
        assert_eq!(savings.target_cents, 20_000);
        assert_eq!(savings.delta_cents, -20_000);

        let needs = s.buckets.iter().find(|b| b.bucket == Bucket::Needs).unwrap();
        assert_eq!(needs.target_cents, 50_000);
        assert_eq!(needs.actual_cents, 80_000);
        assert_eq!(needs.delta_cents, 30_000); // por encima del objetivo

        let wants = s.buckets.iter().find(|b| b.bucket == Bucket::Wants).unwrap();
        assert_eq!(wants.target_cents, 30_000);
        assert_eq!(wants.actual_cents, 40_000);
        assert_eq!(wants.delta_cents, 10_000);
    }

    #[test]
    fn ingreso_impar_los_tres_targets_suman_el_ingreso() {
        let s = compute_summary("2026-01".into(), 1001, BucketExpenses::default(), 0, vec![]);
        let sum: i64 = s.buckets.iter().map(|b| b.target_cents).sum();
        assert_eq!(sum, 1001);
        let needs = s.buckets.iter().find(|b| b.bucket == Bucket::Needs).unwrap();
        let wants = s.buckets.iter().find(|b| b.bucket == Bucket::Wants).unwrap();
        let savings = s.buckets.iter().find(|b| b.bucket == Bucket::Savings).unwrap();
        assert_eq!(needs.target_cents, 500);
        assert_eq!(wants.target_cents, 300);
        assert_eq!(savings.target_cents, 201); // se lleva el resto del redondeo
    }

    #[test]
    fn gastos_sin_categoria_no_entran_en_ningun_cubo_pero_reducen_ahorro_implicito() {
        let bucket_expenses = BucketExpenses {
            needs_cents: 10_000,
            wants_cents: 0,
            savings_cents: 0,
        };
        let s = compute_summary("2026-01".into(), 100_000, bucket_expenses, 20_000, vec![]);
        assert_eq!(s.uncategorized_expense_cents, 20_000);
        assert_eq!(s.expense_cents, 30_000); // 10000 needs + 20000 sin categoría

        let needs = s.buckets.iter().find(|b| b.bucket == Bucket::Needs).unwrap();
        assert_eq!(needs.actual_cents, 10_000); // sin categoría no cuenta aquí

        let savings = s.buckets.iter().find(|b| b.bucket == Bucket::Savings).unwrap();
        // leftover = 100000 - 30000 = 70000; sin gasto categorizado en savings
        assert_eq!(savings.actual_cents, 70_000);

        assert!(s.by_category.is_empty()); // no aparece como categoría
    }

    #[test]
    fn by_category_orden_descendente_y_porcentaje_1_decimal() {
        let entries = vec![
            (cat("Comida", Some(Bucket::Needs)), 3_333),
            (cat("Ocio", Some(Bucket::Wants)), 10_000),
            (cat("Gym", Some(Bucket::Wants)), 1),
        ];
        let s = compute_summary("2026-01".into(), 100_000, BucketExpenses::default(), 0, entries);
        assert_eq!(s.by_category.len(), 3);
        assert_eq!(s.by_category[0].category.name, "Ocio");
        assert_eq!(s.by_category[0].amount_cents, 10_000);
        assert_eq!(s.by_category[0].pct_of_income, 10.0);
        assert_eq!(s.by_category[1].category.name, "Comida");
        assert_eq!(s.by_category[1].amount_cents, 3_333);
        assert_eq!(s.by_category[1].pct_of_income, 3.3); // 3.333% -> 3.3
        assert_eq!(s.by_category[2].category.name, "Gym");
        assert_eq!(s.by_category[2].pct_of_income, 0.0); // 0.001% -> 0.0
    }

    #[test]
    fn pct_1dp_redondea_correctamente() {
        assert_eq!(pct_1dp(1, 3), 33.3); // 33.333...
        assert_eq!(pct_1dp(2, 3), 66.7); // 66.666...
        assert_eq!(pct_1dp(0, 0), 0.0);
        assert_eq!(pct_1dp(50, 0), 0.0);
    }

    // ---- compute_trend_point reutiliza compute_summary ----

    #[test]
    fn trend_point_misma_semantica_que_summary() {
        let bucket_expenses = BucketExpenses {
            needs_cents: 40_000,
            wants_cents: 10_000,
            savings_cents: 5_000,
        };
        let point = compute_trend_point("2026-03".into(), 100_000, bucket_expenses, 0);
        assert_eq!(point.month, "2026-03");
        assert_eq!(point.income_cents, 100_000);
        assert_eq!(point.needs_cents, 40_000);
        assert_eq!(point.wants_cents, 10_000);
        // leftover = 100000 - 55000 = 45000; savings = 5000 + 45000
        assert_eq!(point.savings_cents, 50_000);
    }

    // ---- parse_month ----

    #[test]
    fn parse_month_valido() {
        assert_eq!(parse_month("2026-09").unwrap(), (2026, 9));
        assert_eq!(parse_month("2026-12").unwrap(), (2026, 12));
        assert_eq!(parse_month("2026-01").unwrap(), (2026, 1));
    }

    #[test]
    fn parse_month_mes_fuera_de_rango() {
        assert!(parse_month("2026-13").is_err());
        assert!(parse_month("2026-00").is_err());
    }

    #[test]
    fn parse_month_mes_sin_cero_relleno() {
        // "2026-9" no cumple el formato AAAA-MM exigido (mes a 2 dígitos).
        assert!(parse_month("2026-9").is_err());
    }

    #[test]
    fn parse_month_basura() {
        assert!(parse_month("basura").is_err());
        assert!(parse_month("").is_err());
        assert!(parse_month("2026/09").is_err());
        assert!(parse_month("26-09").is_err());
        assert!(parse_month("2026-09-01").is_err());
    }

    // ---- month_range ----

    #[test]
    fn month_range_normal() {
        let (from, to) = month_range(2026, 6);
        assert_eq!(from, NaiveDate::from_ymd_opt(2026, 6, 1).unwrap());
        assert_eq!(to, NaiveDate::from_ymd_opt(2026, 7, 1).unwrap());
    }

    #[test]
    fn month_range_diciembre_cruza_a_enero_del_ano_siguiente() {
        let (from, to) = month_range(2026, 12);
        assert_eq!(from, NaiveDate::from_ymd_opt(2026, 12, 1).unwrap());
        assert_eq!(to, NaiveDate::from_ymd_opt(2027, 1, 1).unwrap());
    }

    #[test]
    fn month_start_n_back_cruza_anos() {
        // 2 meses antes de enero de 2026 es noviembre de 2025.
        let d = month_start_n_back(2026, 1, 2);
        assert_eq!(d, NaiveDate::from_ymd_opt(2025, 11, 1).unwrap());
        // 0 meses atrás es el propio mes.
        let d0 = month_start_n_back(2026, 1, 0);
        assert_eq!(d0, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap());
    }
}
