use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, response::IntoResponse};
use serde::Deserialize;
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

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    include_archived: bool,
}

async fn list(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Category>>> {
    let categories = if q.include_archived {
        sqlx::query_as::<_, Category>(concat!(
            "SELECT ",
            crate::category_columns!(),
            " FROM categories WHERE user_id = $1 ORDER BY sort_order, name"
        ))
        .bind(auth.id)
        .fetch_all(state.db())
        .await?
    } else {
        sqlx::query_as::<_, Category>(concat!(
            "SELECT ",
            crate::category_columns!(),
            " FROM categories WHERE user_id = $1 AND is_archived = false ORDER BY sort_order, name"
        ))
        .bind(auth.id)
        .fetch_all(state.db())
        .await?
    };
    Ok(Json(categories))
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    name: String,
    kind: Kind,
    bucket: Option<Bucket>,
    color: Option<String>,
    icon: Option<String>,
}

/// Nombre normalizado: recorta espacios y comprueba longitud 1..=60.
fn validate_name(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 60 {
        return Err(AppError::Validation(
            "El nombre debe tener entre 1 y 60 caracteres".into(),
        ));
    }
    Ok(trimmed)
}

/// Color hex `#rrggbb` (minúsculas o mayúsculas, exactamente 6 dígitos).
fn validate_color(raw: &str) -> AppResult<String> {
    let bytes = raw.as_bytes();
    let ok = bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|b| b.is_ascii_hexdigit());
    if !ok {
        return Err(AppError::Validation(
            "El color debe tener el formato #rrggbb".into(),
        ));
    }
    Ok(raw.to_string())
}

/// Icono: cadena no vacía (tras recortar) de como mucho 40 caracteres.
fn validate_icon(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 40 {
        return Err(AppError::Validation(
            "El icono debe tener entre 1 y 40 caracteres".into(),
        ));
    }
    Ok(trimmed)
}

/// Regla dura del dominio: gasto exige bucket, ingreso lo prohíbe.
fn validate_bucket_matches_kind(kind: Kind, bucket: Option<Bucket>) -> AppResult<()> {
    match (kind, bucket) {
        (Kind::Expense, None) => Err(AppError::Validation(
            "Una categoría de gasto necesita un cubo (needs, wants o savings)".into(),
        )),
        (Kind::Income, Some(_)) => Err(AppError::Validation(
            "Una categoría de ingreso no puede tener cubo".into(),
        )),
        _ => Ok(()),
    }
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(
        err,
        sqlx::Error::Database(db_err) if db_err.code().as_deref() == Some("23505")
    )
}

async fn create(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateBody>,
) -> AppResult<(StatusCode, Json<Category>)> {
    let name = validate_name(&body.name)?;
    validate_bucket_matches_kind(body.kind, body.bucket)?;
    let color = match body.color {
        Some(c) => validate_color(&c)?,
        None => "#6b7280".to_string(),
    };
    let icon = match body.icon {
        Some(i) => validate_icon(&i)?,
        None => "circle".to_string(),
    };

    let next_sort_order: i32 = sqlx::query_scalar::<_, Option<i32>>(
        "SELECT MAX(sort_order) FROM categories WHERE user_id = $1",
    )
    .bind(auth.id)
    .fetch_one(state.db())
    .await?
    .map(|max| max + 1)
    .unwrap_or(0);

    let result = sqlx::query_as::<_, Category>(concat!(
        "INSERT INTO categories (user_id, name, kind, bucket, color, icon, sort_order) ",
        "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ",
        crate::category_columns!()
    ))
    .bind(auth.id)
    .bind(&name)
    .bind(body.kind)
    .bind(body.bucket)
    .bind(&color)
    .bind(&icon)
    .bind(next_sort_order)
    .fetch_one(state.db())
    .await;

    match result {
        Ok(category) => Ok((StatusCode::CREATED, Json(category))),
        Err(e) if is_unique_violation(&e) => Err(AppError::Conflict(
            "Ya tienes una categoría con ese nombre".into(),
        )),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    bucket: Option<Option<Bucket>>,
    color: Option<String>,
    icon: Option<String>,
    is_archived: Option<bool>,
    sort_order: Option<i32>,
}

/// Distingue "campo ausente" (no tocar) de "campo presente con valor null"
/// (poner a NULL). `Option<Option<T>>` con este deserializador: si la clave
/// falta, serde nunca lo invoca y el campo por defecto es `None` (ausente);
/// si la clave está presente, este deserializador produce `Some(None)` (json
/// null) o `Some(Some(v))` (valor).
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

/// Aplica el parche a la fila leída, validando el resultado. Se hace en Rust
/// (leer, mutar, validar, UPDATE completo) en vez de SQL dinámico: sqlx 0.9
/// solo acepta `&'static str` en `query*()`, así que construir el SQL a mano
/// según qué campos vinieron obligaría a `format!()` (prohibido) o a un
/// generador de consultas mucho más complejo para un beneficio marginal.
fn apply_patch(mut category: Category, patch: UpdateBody) -> AppResult<Category> {
    if let Some(name) = patch.name {
        category.name = validate_name(&name)?;
    }
    if let Some(bucket) = patch.bucket {
        // `bucket` puede venir ausente (no tocar). Si viene, puede ser
        // `null` o un valor; la regla dura se revalida abajo.
        category.bucket = bucket;
    }
    if let Some(color) = patch.color {
        category.color = validate_color(&color)?;
    }
    if let Some(icon) = patch.icon {
        category.icon = validate_icon(&icon)?;
    }
    if let Some(is_archived) = patch.is_archived {
        category.is_archived = is_archived;
    }
    if let Some(sort_order) = patch.sort_order {
        category.sort_order = sort_order;
    }
    validate_bucket_matches_kind(category.kind, category.bucket)?;
    Ok(category)
}

async fn update(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateBody>,
) -> AppResult<Json<Category>> {
    let existing = sqlx::query_as::<_, Category>(concat!(
        "SELECT ",
        crate::category_columns!(),
        " FROM categories WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(auth.id)
    .fetch_optional(state.db())
    .await?
    .ok_or(AppError::NotFound)?;

    let updated = apply_patch(existing, body)?;

    let result = sqlx::query_as::<_, Category>(concat!(
        "UPDATE categories SET name = $1, bucket = $2, color = $3, icon = $4, ",
        "is_archived = $5, sort_order = $6 WHERE id = $7 AND user_id = $8 RETURNING ",
        crate::category_columns!()
    ))
    .bind(&updated.name)
    .bind(updated.bucket)
    .bind(&updated.color)
    .bind(&updated.icon)
    .bind(updated.is_archived)
    .bind(updated.sort_order)
    .bind(id)
    .bind(auth.id)
    .fetch_one(state.db())
    .await;

    match result {
        Ok(category) => Ok(Json(category)),
        Err(e) if is_unique_violation(&e) => Err(AppError::Conflict(
            "Ya tienes una categoría con ese nombre".into(),
        )),
        Err(e) => Err(e.into()),
    }
}

async fn delete(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<impl IntoResponse> {
    let result = sqlx::query("DELETE FROM categories WHERE id = $1 AND user_id = $2")
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
    fn validate_name_trims_and_checks_len() {
        assert_eq!(validate_name("  Comida  ").unwrap(), "Comida");
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"a".repeat(60)).is_ok());
        assert!(validate_name(&"a".repeat(61)).is_err());
    }

    #[test]
    fn validate_color_requires_hex() {
        assert!(validate_color("#6b7280").is_ok());
        assert!(validate_color("#ABCDEF").is_ok());
        assert!(validate_color("6b7280").is_err());
        assert!(validate_color("#6b728").is_err());
        assert!(validate_color("#6b72gg").is_err());
    }

    #[test]
    fn validate_icon_requires_non_empty_bounded() {
        assert!(validate_icon("circle").is_ok());
        assert!(validate_icon("  ").is_err());
        assert!(validate_icon(&"a".repeat(40)).is_ok());
        assert!(validate_icon(&"a".repeat(41)).is_err());
    }

    #[test]
    fn bucket_matches_kind_rules() {
        assert!(validate_bucket_matches_kind(Kind::Expense, None).is_err());
        assert!(validate_bucket_matches_kind(Kind::Expense, Some(Bucket::Needs)).is_ok());
        assert!(validate_bucket_matches_kind(Kind::Income, Some(Bucket::Needs)).is_err());
        assert!(validate_bucket_matches_kind(Kind::Income, None).is_ok());
    }

    fn sample_category(kind: Kind, bucket: Option<Bucket>) -> Category {
        Category {
            id: Uuid::nil(),
            name: "Original".into(),
            kind,
            bucket,
            color: "#6b7280".into(),
            icon: "circle".into(),
            is_archived: false,
            sort_order: 0,
        }
    }

    #[test]
    fn patch_absent_bucket_does_not_touch_it() {
        let category = sample_category(Kind::Expense, Some(Bucket::Needs));
        let patch = UpdateBody {
            name: Some("Nueva".into()),
            bucket: None,
            color: None,
            icon: None,
            is_archived: None,
            sort_order: None,
        };
        let updated = apply_patch(category, patch).unwrap();
        assert_eq!(updated.name, "Nueva");
        assert_eq!(updated.bucket, Some(Bucket::Needs));
    }

    #[test]
    fn patch_expense_bucket_to_null_is_rejected() {
        let category = sample_category(Kind::Expense, Some(Bucket::Needs));
        let patch = UpdateBody {
            name: None,
            bucket: Some(None),
            color: None,
            icon: None,
            is_archived: None,
            sort_order: None,
        };
        assert!(apply_patch(category, patch).is_err());
    }

    #[test]
    fn patch_can_change_bucket_value_for_expense() {
        let category = sample_category(Kind::Expense, Some(Bucket::Needs));
        let patch = UpdateBody {
            name: None,
            bucket: Some(Some(Bucket::Wants)),
            color: None,
            icon: None,
            is_archived: None,
            sort_order: None,
        };
        let updated = apply_patch(category, patch).unwrap();
        assert_eq!(updated.bucket, Some(Bucket::Wants));
    }

    #[test]
    fn patch_invalid_color_is_rejected() {
        let category = sample_category(Kind::Income, None);
        let patch = UpdateBody {
            name: None,
            bucket: None,
            color: Some("not-a-color".into()),
            icon: None,
            is_archived: None,
            sort_order: None,
        };
        assert!(apply_patch(category, patch).is_err());
    }
}
