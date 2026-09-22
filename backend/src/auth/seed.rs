//! Siembra de las 10 categorías por defecto al registrar el único usuario.
//! Valores exactos de la tabla "Categorías semilla" de `docs/API.md`.

use crate::domain::{Bucket, Kind};
use crate::error::AppResult;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

struct SeedCategory {
    name: &'static str,
    kind: Kind,
    bucket: Option<Bucket>,
    icon: &'static str,
    color: &'static str,
}

const SEED_CATEGORIES: [SeedCategory; 10] = [
    SeedCategory { name: "Nómina", kind: Kind::Income, bucket: None, icon: "wallet", color: "#2f7d5e" },
    SeedCategory { name: "Extras", kind: Kind::Income, bucket: None, icon: "circle-plus", color: "#4a9c78" },
    SeedCategory { name: "Alquiler", kind: Kind::Expense, bucket: Some(Bucket::Needs), icon: "house", color: "#c2410c" },
    SeedCategory { name: "Comida", kind: Kind::Expense, bucket: Some(Bucket::Needs), icon: "utensils", color: "#d97706" },
    SeedCategory { name: "Suministros", kind: Kind::Expense, bucket: Some(Bucket::Needs), icon: "zap", color: "#b45309" },
    SeedCategory { name: "Transporte", kind: Kind::Expense, bucket: Some(Bucket::Needs), icon: "bus", color: "#a16207" },
    SeedCategory { name: "Gym", kind: Kind::Expense, bucket: Some(Bucket::Wants), icon: "dumbbell", color: "#7c3aed" },
    SeedCategory { name: "Ropa", kind: Kind::Expense, bucket: Some(Bucket::Wants), icon: "shirt", color: "#9333ea" },
    SeedCategory { name: "Ocio", kind: Kind::Expense, bucket: Some(Bucket::Wants), icon: "party-popper", color: "#c026d3" },
    SeedCategory { name: "Inversión", kind: Kind::Expense, bucket: Some(Bucket::Savings), icon: "trending-up", color: "#0369a1" },
];

const INSERT_CATEGORY: &str = "INSERT INTO categories \
    (user_id, name, kind, bucket, color, icon, sort_order) \
    VALUES ($1, $2, $3, $4, $5, $6, $7)";

/// Inserta las 10 categorías semilla para `user_id`, con `sort_order` 0..9
/// en el orden de la tabla del contrato. Debe llamarse dentro de la misma
/// transacción que crea el usuario.
///
/// Nota sqlx 0.9: `Executor` no está implementado para `&mut Transaction`
/// (solo para `&mut PgConnection`), así que hay que desreferenciar dos
/// veces: `tx: &mut Transaction<..>` -> `*tx` es el `Transaction` -> `**tx`
/// es el `PgConnection` vía su `DerefMut`.
pub async fn seed_categories(tx: &mut Transaction<'_, Postgres>, user_id: Uuid) -> AppResult<()> {
    for (i, cat) in SEED_CATEGORIES.iter().enumerate() {
        sqlx::query(INSERT_CATEGORY)
            .bind(user_id)
            .bind(cat.name)
            .bind(cat.kind)
            .bind(cat.bucket)
            .bind(cat.color)
            .bind(cat.icon)
            .bind(i as i32)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
