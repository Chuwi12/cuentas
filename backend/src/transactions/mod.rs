use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, patch};
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::domain::{Bucket, Category, Kind};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", patch(update).delete(delete))
}

/// Movimiento tal como viaja en la API (contrato: `docs/API.md`).
#[derive(Debug, Serialize)]
struct Transaction {
    id: Uuid,
    kind: Kind,
    amount_cents: i64,
    category_id: Option<Uuid>,
    category: Option<Category>,
    occurred_on: NaiveDate,
    description: Option<String>,
    created_at: DateTime<Utc>,
}

/// Fila plana de una query que hace `LEFT JOIN categories c ON c.id = t.category_id`.
/// Las columnas de la categoría van aliasadas `c_*`; si `c_id` es `NULL` el
/// movimiento no tiene categoría y `category` es `None`. Cuando `c_id` no es
/// `NULL`, el resto de columnas `c_*` tampoco lo son (misma fila de `categories`),
/// así que `unwrap_or_default`/`unwrap_or` son solo una red de seguridad.
#[derive(Debug, sqlx::FromRow)]
struct TxCols {
    id: Uuid,
    kind: Kind,
    amount_cents: i64,
    category_id: Option<Uuid>,
    occurred_on: NaiveDate,
    description: Option<String>,
    created_at: DateTime<Utc>,
    c_id: Option<Uuid>,
    c_name: Option<String>,
    c_kind: Option<Kind>,
    c_bucket: Option<Bucket>,
    c_color: Option<String>,
    c_icon: Option<String>,
    c_is_archived: Option<bool>,
    c_sort_order: Option<i32>,
}

impl From<TxCols> for Transaction {
    fn from(r: TxCols) -> Self {
        let TxCols {
            id,
            kind,
            amount_cents,
            category_id,
            occurred_on,
            description,
            created_at,
            c_id,
            c_name,
            c_kind,
            c_bucket,
            c_color,
            c_icon,
            c_is_archived,
            c_sort_order,
        } = r;

        let category = c_id.map(|cid| Category {
            id: cid,
            name: c_name.unwrap_or_default(),
            kind: c_kind.unwrap_or(kind),
            bucket: c_bucket,
            color: c_color.unwrap_or_default(),
            icon: c_icon.unwrap_or_default(),
            is_archived: c_is_archived.unwrap_or(false),
            sort_order: c_sort_order.unwrap_or(0),
        });

        Transaction {
            id,
            kind,
            amount_cents,
            category_id,
            category,
            occurred_on,
            description,
            created_at,
        }
    }
}

/// Igual que `TxCols` pero con el total de filas de la consulta (antes de
/// `LIMIT`/`OFFSET`), vía `COUNT(*) OVER()`. Implementado a mano en vez de con
/// `#[derive(FromRow)]` + `#[sqlx(flatten)]` para no depender de si esa
/// combinación existe tal cual en sqlx 0.9 (no hay red para comprobarlo sin BD).
struct TxColsWithTotal {
    tx: TxCols,
    total: i64,
}

impl<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow> for TxColsWithTotal {
    fn from_row(row: &'r sqlx::postgres::PgRow) -> sqlx::Result<Self> {
        Ok(Self {
            tx: TxCols::from_row(row)?,
            total: row.try_get("total")?,
        })
    }
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    kind: Option<Kind>,
    category_id: Option<Uuid>,
    bucket: Option<Bucket>,
    q: Option<String>,
    page: Option<i64>,
    per_page: Option<i64>,
}

#[derive(Debug, Serialize)]
struct TransactionsPage {
    items: Vec<Transaction>,
    total: i64,
    page: i64,
    per_page: i64,
}

/// `page` siempre >= 1; `per_page` acotado a 1..=200 (por defecto 50).
fn clamp_pagination(page: Option<i64>, per_page: Option<i64>) -> (i64, i64) {
    let page = page.unwrap_or(1).max(1);
    let per_page = per_page.unwrap_or(50).clamp(1, 200);
    (page, per_page)
}

/// Escapa `%` y `_` (comodines de LIKE/ILIKE) y `\` (el carácter de escape),
/// para que una búsqueda de texto libre no interprete comodines del usuario.
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

async fn list(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<TransactionsPage>> {
    let (page, per_page) = clamp_pagination(q.page, q.per_page);
    let offset = (page - 1) * per_page;
    let like_pattern = q.q.as_deref().map(|raw| format!("%{}%", escape_like(raw)));

    let sql: &'static str = concat!(
        "SELECT t.id, t.kind, t.amount_cents, t.category_id, t.occurred_on, t.description, t.created_at, ",
        "c.id AS c_id, c.name AS c_name, c.kind AS c_kind, c.bucket AS c_bucket, ",
        "c.color AS c_color, c.icon AS c_icon, c.is_archived AS c_is_archived, c.sort_order AS c_sort_order, ",
        "COUNT(*) OVER() AS total ",
        "FROM transactions t ",
        "LEFT JOIN categories c ON c.id = t.category_id ",
        "WHERE t.user_id = $1 ",
        "AND ($2::date IS NULL OR t.occurred_on >= $2) ",
        "AND ($3::date IS NULL OR t.occurred_on <= $3) ",
        "AND ($4::text IS NULL OR t.kind = $4) ",
        "AND ($5::uuid IS NULL OR t.category_id = $5) ",
        "AND ($6::text IS NULL OR c.bucket = $6) ",
        "AND ($7::text IS NULL OR t.description ILIKE $7 ESCAPE '\\') ",
        "ORDER BY t.occurred_on DESC, t.created_at DESC ",
        "LIMIT $8 OFFSET $9"
    );
    let rows = sqlx::query_as::<_, TxColsWithTotal>(sql)
        .bind(auth.id)
        .bind(q.from)
        .bind(q.to)
        .bind(q.kind)
        .bind(q.category_id)
        .bind(q.bucket)
        .bind(&like_pattern)
        .bind(per_page)
        .bind(offset)
        .fetch_all(state.db())
        .await?;

    let total = rows.first().map(|r| r.total).unwrap_or(0);
    let items = rows.into_iter().map(|r| r.tx.into()).collect();

    Ok(Json(TransactionsPage {
        items,
        total,
        page,
        per_page,
    }))
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    kind: Kind,
    amount_cents: i64,
    category_id: Option<Uuid>,
    occurred_on: NaiveDate,
    description: Option<String>,
}

fn validate_amount(amount_cents: i64) -> AppResult<()> {
    if amount_cents <= 0 {
        return Err(AppError::Validation(
            "El importe debe ser mayor que 0".into(),
        ));
    }
    Ok(())
}

/// Recorta la descripción; una cadena vacía tras recortar se guarda como
/// `null`. Límite de 500 caracteres (coincide con el CHECK de la migración).
fn normalize_description(raw: Option<String>) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(s) => {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                Ok(None)
            } else if trimmed.chars().count() > 500 {
                Err(AppError::Validation(
                    "La descripción no puede superar los 500 caracteres".into(),
                ))
            } else {
                Ok(Some(trimmed))
            }
        }
    }
}

/// Si se referencia una categoría, debe existir, ser del usuario y su `kind`
/// debe coincidir con el del movimiento.
async fn validate_category(
    db: &PgPool,
    user_id: Uuid,
    category_id: Option<Uuid>,
    kind: Kind,
) -> AppResult<()> {
    let Some(category_id) = category_id else {
        return Ok(());
    };

    let row: Option<(Kind,)> =
        sqlx::query_as("SELECT kind FROM categories WHERE id = $1 AND user_id = $2")
            .bind(category_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;

    match row {
        None => Err(AppError::Validation(
            "La categoría indicada no existe".into(),
        )),
        Some((cat_kind,)) if cat_kind != kind => Err(AppError::Validation(
            "El tipo del movimiento no coincide con el de la categoría".into(),
        )),
        Some(_) => Ok(()),
    }
}

async fn create(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateBody>,
) -> AppResult<(StatusCode, Json<Transaction>)> {
    validate_amount(body.amount_cents)?;
    let description = normalize_description(body.description)?;
    validate_category(state.db(), auth.id, body.category_id, body.kind).await?;

    let sql: &'static str = concat!(
        "WITH inserted AS (",
        "INSERT INTO transactions (user_id, category_id, kind, amount_cents, occurred_on, description) ",
        "VALUES ($1, $2, $3, $4, $5, $6) ",
        "RETURNING id, kind, amount_cents, category_id, occurred_on, description, created_at",
        ") ",
        "SELECT inserted.id, inserted.kind, inserted.amount_cents, inserted.category_id, ",
        "inserted.occurred_on, inserted.description, inserted.created_at, ",
        "c.id AS c_id, c.name AS c_name, c.kind AS c_kind, c.bucket AS c_bucket, ",
        "c.color AS c_color, c.icon AS c_icon, c.is_archived AS c_is_archived, c.sort_order AS c_sort_order ",
        "FROM inserted LEFT JOIN categories c ON c.id = inserted.category_id"
    );

    let row = sqlx::query_as::<_, TxCols>(sql)
        .bind(auth.id)
        .bind(body.category_id)
        .bind(body.kind)
        .bind(body.amount_cents)
        .bind(body.occurred_on)
        .bind(&description)
        .fetch_one(state.db())
        .await?;

    Ok((StatusCode::CREATED, Json(row.into())))
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    kind: Option<Kind>,
    amount_cents: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    category_id: Option<Option<Uuid>>,
    occurred_on: Option<NaiveDate>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
}

/// Distingue "campo ausente" (no tocar) de "campo presente con `null`"
/// (poner a NULL). Ver el mismo patrón en `categories::mod` para `bucket`.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

/// Estado mutable de un movimiento mientras se aplica un parche parcial.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
struct TxDraft {
    kind: Kind,
    amount_cents: i64,
    category_id: Option<Uuid>,
    occurred_on: NaiveDate,
    description: Option<String>,
}

/// Aplica el parche en Rust (leer, mutar, validar, UPDATE completo) en vez de
/// SQL dinámico: sqlx 0.9 exige `&'static str` en `query*()`.
fn apply_patch(mut draft: TxDraft, patch: UpdateBody) -> AppResult<TxDraft> {
    if let Some(kind) = patch.kind {
        draft.kind = kind;
    }
    if let Some(amount_cents) = patch.amount_cents {
        draft.amount_cents = amount_cents;
    }
    if let Some(category_id) = patch.category_id {
        draft.category_id = category_id;
    }
    if let Some(occurred_on) = patch.occurred_on {
        draft.occurred_on = occurred_on;
    }
    if let Some(description) = patch.description {
        draft.description = normalize_description(description)?;
    }
    validate_amount(draft.amount_cents)?;
    Ok(draft)
}

async fn update(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateBody>,
) -> AppResult<Json<Transaction>> {
    let existing = sqlx::query_as::<_, TxDraft>(
        "SELECT kind, amount_cents, category_id, occurred_on, description \
         FROM transactions WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(auth.id)
    .fetch_optional(state.db())
    .await?
    .ok_or(AppError::NotFound)?;

    let updated = apply_patch(existing, body)?;
    validate_category(state.db(), auth.id, updated.category_id, updated.kind).await?;

    let sql: &'static str = concat!(
        "WITH u AS (",
        "UPDATE transactions SET kind = $1, amount_cents = $2, category_id = $3, ",
        "occurred_on = $4, description = $5, updated_at = now() ",
        "WHERE id = $6 AND user_id = $7 ",
        "RETURNING id, kind, amount_cents, category_id, occurred_on, description, created_at",
        ") ",
        "SELECT u.id, u.kind, u.amount_cents, u.category_id, u.occurred_on, u.description, u.created_at, ",
        "c.id AS c_id, c.name AS c_name, c.kind AS c_kind, c.bucket AS c_bucket, ",
        "c.color AS c_color, c.icon AS c_icon, c.is_archived AS c_is_archived, c.sort_order AS c_sort_order ",
        "FROM u LEFT JOIN categories c ON c.id = u.category_id"
    );

    let row = sqlx::query_as::<_, TxCols>(sql)
        .bind(updated.kind)
        .bind(updated.amount_cents)
        .bind(updated.category_id)
        .bind(updated.occurred_on)
        .bind(&updated.description)
        .bind(id)
        .bind(auth.id)
        .fetch_one(state.db())
        .await?;

    Ok(Json(row.into()))
}

async fn delete(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<impl IntoResponse> {
    let result = sqlx::query("DELETE FROM transactions WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.id)
        .execute(state.db())
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_amount_requires_positive() {
        assert!(validate_amount(1).is_ok());
        assert!(validate_amount(0).is_err());
        assert!(validate_amount(-100).is_err());
    }

    #[test]
    fn normalize_description_trims_and_blanks_to_null() {
        assert_eq!(
            normalize_description(Some("  hola  ".into())).unwrap(),
            Some("hola".into())
        );
        assert_eq!(normalize_description(Some("   ".into())).unwrap(), None);
        assert_eq!(normalize_description(None).unwrap(), None);
        assert!(normalize_description(Some("a".repeat(501))).is_err());
        assert!(normalize_description(Some("a".repeat(500))).is_ok());
    }

    #[test]
    fn escape_like_escapes_wildcards_and_backslash() {
        assert_eq!(escape_like("50%"), "50\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("a\\b"), "a\\\\b");
        assert_eq!(escape_like("normal"), "normal");
    }

    #[test]
    fn clamp_pagination_defaults_and_bounds() {
        assert_eq!(clamp_pagination(None, None), (1, 50));
        assert_eq!(clamp_pagination(Some(0), Some(0)), (1, 1));
        assert_eq!(clamp_pagination(Some(-5), Some(9999)), (1, 200));
        assert_eq!(clamp_pagination(Some(3), Some(20)), (3, 20));
    }

    fn sample_draft() -> TxDraft {
        TxDraft {
            kind: Kind::Expense,
            amount_cents: 1000,
            category_id: Some(Uuid::nil()),
            occurred_on: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            description: Some("original".into()),
        }
    }

    #[test]
    fn patch_absent_fields_do_not_change() {
        let draft = sample_draft();
        let patch = UpdateBody {
            kind: None,
            amount_cents: None,
            category_id: None,
            occurred_on: None,
            description: None,
        };
        let updated = apply_patch(draft.clone(), patch).unwrap();
        assert_eq!(updated, draft);
    }

    #[test]
    fn patch_explicit_null_category_clears_it() {
        let draft = sample_draft();
        let patch = UpdateBody {
            kind: None,
            amount_cents: None,
            category_id: Some(None),
            occurred_on: None,
            description: None,
        };
        let updated = apply_patch(draft, patch).unwrap();
        assert_eq!(updated.category_id, None);
    }

    #[test]
    fn patch_explicit_null_description_clears_it() {
        let draft = sample_draft();
        let patch = UpdateBody {
            kind: None,
            amount_cents: None,
            category_id: None,
            occurred_on: None,
            description: Some(None),
        };
        let updated = apply_patch(draft, patch).unwrap();
        assert_eq!(updated.description, None);
    }

    #[test]
    fn patch_rejects_non_positive_amount() {
        let draft = sample_draft();
        let patch = UpdateBody {
            kind: None,
            amount_cents: Some(0),
            category_id: None,
            occurred_on: None,
            description: None,
        };
        assert!(apply_patch(draft, patch).is_err());
    }

    #[test]
    fn patch_can_change_kind() {
        let draft = sample_draft();
        let patch = UpdateBody {
            kind: Some(Kind::Income),
            amount_cents: None,
            category_id: None,
            occurred_on: None,
            description: None,
        };
        let updated = apply_patch(draft, patch).unwrap();
        assert_eq!(updated.kind, Kind::Income);
    }
}
