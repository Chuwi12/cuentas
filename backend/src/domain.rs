use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Importe máximo de un movimiento: 1.000 millones de euros. No es un límite
/// de negocio sino de cordura: con él, ninguna suma de un periodo puede
/// desbordar un `BIGINT` (haría falta del orden de 10⁸ movimientos). Coincide
/// con el CHECK de la migración 0002.
pub const MAX_AMOUNT_CENTS: i64 = 100_000_000_000;

/// Rango de fechas admitido, tanto para los movimientos como para los
/// informes. Coincide con el CHECK de la migración 0002.
pub const MIN_DATE: NaiveDate = NaiveDate::from_ymd_opt(2000, 1, 1).unwrap();
pub const MAX_DATE: NaiveDate = NaiveDate::from_ymd_opt(2100, 12, 31).unwrap();

/// Ingreso o gasto.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum Kind {
    Income,
    Expense,
}

/// Los tres cubos de la regla 50/30/20.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum Bucket {
    Needs,
    Wants,
    Savings,
}

impl Bucket {
    /// Porcentaje objetivo sobre los ingresos del mes.
    pub const fn target_pct(self) -> i64 {
        match self {
            Bucket::Needs => 50,
            Bucket::Wants => 30,
            Bucket::Savings => 20,
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Kind::Income => "income",
            Kind::Expense => "expense",
        })
    }
}

impl fmt::Display for Bucket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Bucket::Needs => "needs",
            Bucket::Wants => "wants",
            Bucket::Savings => "savings",
        })
    }
}

impl FromStr for Kind {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "income" => Ok(Kind::Income),
            "expense" => Ok(Kind::Expense),
            _ => Err(()),
        }
    }
}

impl FromStr for Bucket {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "needs" => Ok(Bucket::Needs),
            "wants" => Ok(Bucket::Wants),
            "savings" => Ok(Bucket::Savings),
            _ => Err(()),
        }
    }
}

/// Fila de `categories`. Compartida por los módulos de categorías,
/// transacciones (se incrusta en cada movimiento) y resumen.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Category {
    pub id: uuid::Uuid,
    pub name: String,
    pub kind: Kind,
    pub bucket: Option<Bucket>,
    pub color: String,
    pub icon: String,
    pub is_archived: bool,
    pub sort_order: i32,
}

/// Columnas de `Category` como literal, para usar dentro de `concat!()`.
/// sqlx 0.9 solo acepta `&'static str` en `query*()`, así que un `format!()`
/// no compila: `concat!("SELECT ", category_columns!(), " FROM categories")` sí.
#[macro_export]
macro_rules! category_columns {
    () => {
        "id, name, kind, bucket, color, icon, is_archived, sort_order"
    };
}
