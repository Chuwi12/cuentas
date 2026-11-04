//! Importación de movimientos desde CSV: `/api/import/csv`. Contrato en
//! `docs/API.md`. La interpretación del fichero está en `parse` (sin BD); aquí
//! van los handlers y las consultas.

mod parse;

use crate::auth::AuthUser;
use crate::domain::Kind;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use chrono::NaiveDate;
use parse::{Fmt, Mapping, Row, Usage};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use tokio::sync::Semaphore;
use uuid::Uuid;

/// El fichero admite 2 MB, pero llega dentro de un JSON: comillas y saltos de
/// línea se escapan (hasta el doble) y el cuerpo lleva además el mapeo, `skip`
/// y `categories`. Por encima, el límite de axum responde 413.
const BODY_LIMIT: usize = 5 * 1024 * 1024;

/// Un solo fichero a la vez: leer uno grande cuesta decenas de MB y 8 peticiones simultáneas
/// multiplicaban ese pico. Las demás esperan su turno (el cuerpo ya está leído, 5 MiB como mucho).
static PARSE_GATE: Semaphore = Semaphore::const_new(1);

/// Interpreta el fichero de uno en uno y fuera de los workers de tokio, que no deben bloquearse
/// con trabajo de CPU.
async fn gated<T: Send + 'static>(job: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let permit = PARSE_GATE
        .acquire()
        .await
        .map_err(|_| AppError::Internal("el control de importaciones está cerrado".into()))?;
    // El permiso viaja con el trabajo: si el cliente se va y se cancela esta petición, el
    // trabajo ya lanzado sigue contando como "el fichero en curso" hasta que termine.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        job()
    })
    .await
    .map_err(|e| AppError::Internal(format!("fallo al interpretar el CSV: {e}")))?
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/inspect", post(inspect))
        .route("/preview", post(preview))
        .route("/", post(confirm))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct InspectBody {
    csv: String,
}

#[derive(Debug, Serialize)]
struct InspectResponse {
    delimiter: String,
    headers: Vec<String>,
    sample: Vec<Vec<String>>,
}

async fn inspect(_auth: AuthUser, Json(body): Json<InspectBody>) -> AppResult<Json<InspectResponse>> {
    // Aún no se sabe si hay cabecera: se supone que sí, que es lo que se muestra.
    let table = gated(move || parse::read_table(&body.csv, true)).await?;
    let mut records = table.records.into_iter();
    Ok(Json(InspectResponse {
        delimiter: char::from(table.delimiter).to_string(),
        headers: records.next().unwrap_or_default(),
        sample: records.take(5).collect(),
    }))
}

// ---------------------------------------------------------------------------
// Análisis común a preview y confirmar
// ---------------------------------------------------------------------------

/// Lee el fichero, lo interpreta y le añade lo que sale de la BD: duplicados y
/// categoría sugerida (una consulta de cada, para todo el fichero).
async fn analyze(db: &PgPool, user_id: Uuid, csv: String, mapping: Mapping) -> AppResult<(Vec<Row>, Fmt)> {
    let (mut rows, date_format) = gated(move || {
        let table = parse::read_table(&csv, mapping.has_header)?;
        parse::interpret(&table, &mapping)
    })
    .await?;

    let refs: Vec<String> = rows.iter().filter_map(|r| r.import_ref.clone()).collect();
    let existing: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT import_ref FROM transactions WHERE user_id = $1 AND import_ref = ANY($2)")
            .bind(user_id)
            .bind(refs)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    for row in &mut rows {
        row.duplicate |= row.import_ref.as_ref().is_some_and(|r| existing.contains(r));
    }

    parse::suggest(&mut rows, category_usage(db, user_id).await?);
    Ok((rows, date_format))
}

/// Historial de categorías por descripción. Se trae agrupado por la descripción
/// tal cual está guardada y se normaliza en Rust, que es donde vive la regla de
/// normalización. Las categorías archivadas no se sugieren.
async fn category_usage(db: &PgPool, user_id: Uuid) -> AppResult<Vec<Usage>> {
    let rows: Vec<(Kind, String, Uuid, i64, NaiveDate)> = sqlx::query_as(
        "SELECT t.kind, t.description, t.category_id, COUNT(*), MAX(t.occurred_on) \
         FROM transactions t JOIN categories c ON c.id = t.category_id \
         WHERE t.user_id = $1 AND t.description IS NOT NULL AND NOT c.is_archived \
         GROUP BY t.kind, t.description, t.category_id",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(kind, description, category_id, count, last)| Usage { kind, description, category_id, count, last })
        .collect())
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PreviewBody {
    csv: String,
    mapping: Mapping,
}

#[derive(Debug, Serialize)]
struct ImportRow {
    index: usize,
    occurred_on: Option<NaiveDate>,
    kind: Option<Kind>,
    amount_cents: Option<i64>,
    description: Option<String>,
    category_id: Option<Uuid>,
    duplicate: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct Summary {
    total: usize,
    valid: usize,
    duplicates: usize,
    errors: usize,
}

#[derive(Debug, Serialize)]
struct PreviewResponse {
    /// Formato con el que se han leído las fechas.
    date_format: Fmt,
    rows: Vec<ImportRow>,
    summary: Summary,
}

async fn preview(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<PreviewBody>,
) -> AppResult<Json<PreviewResponse>> {
    let (rows, date_format) = analyze(state.db(), auth.id, body.csv, body.mapping).await?;
    let errors = rows.iter().filter(|r| r.error.is_some()).count();
    let duplicates = rows.iter().filter(|r| r.error.is_none() && r.duplicate).count();
    let summary = Summary { total: rows.len(), valid: rows.len() - errors - duplicates, duplicates, errors };
    let rows = rows
        .into_iter()
        .map(|r| ImportRow {
            index: r.index,
            occurred_on: r.occurred_on,
            kind: r.kind,
            amount_cents: r.amount_cents,
            description: r.description,
            category_id: r.category_id,
            // Una fila con error no se importa, así que no se marca como duplicada.
            duplicate: r.error.is_none() && r.duplicate,
            error: r.error,
        })
        .collect();
    Ok(Json(PreviewResponse { date_format, rows, summary }))
}

// ---------------------------------------------------------------------------
// confirmar
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ConfirmBody {
    csv: String,
    mapping: Mapping,
    #[serde(default)]
    skip: Vec<usize>,
    /// `{índice: uuid|null}`: sustituye la sugerencia; `null` deja la fila sin categoría.
    #[serde(default)]
    categories: HashMap<usize, Option<Uuid>>,
}

#[derive(Debug, Serialize)]
struct ConfirmResponse {
    inserted: usize,
    duplicates: usize,
    skipped: usize,
}

/// Cada categoría pedida debe ser del usuario y, si se conoce el tipo de la fila,
/// del mismo tipo. Una consulta para todas.
async fn validate_categories(
    db: &PgPool,
    user_id: Uuid,
    rows: &[Row],
    categories: &HashMap<usize, Option<Uuid>>,
) -> AppResult<()> {
    let mut ids: Vec<Uuid> = categories.values().flatten().copied().collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    let kinds: HashMap<Uuid, Kind> =
        sqlx::query_as::<_, (Uuid, Kind)>("SELECT id, kind FROM categories WHERE user_id = $1 AND id = ANY($2)")
            .bind(user_id)
            .bind(ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    for (&index, category) in categories {
        let Some(category) = category else { continue };
        let Some(&category_kind) = kinds.get(category) else {
            return Err(AppError::Validation("La categoría indicada no existe".into()));
        };
        if rows.get(index).and_then(|r| r.kind).is_some_and(|k| k != category_kind) {
            return Err(AppError::Validation(
                "El tipo del movimiento no coincide con el de la categoría".into(),
            ));
        }
    }
    Ok(())
}

/// Columnas de los movimientos a insertar, una por array de `UNNEST`.
#[derive(Default)]
struct Batch {
    categories: Vec<Option<Uuid>>,
    kinds: Vec<String>,
    amounts: Vec<i64>,
    dates: Vec<NaiveDate>,
    descriptions: Vec<Option<String>>,
    refs: Vec<String>,
}

impl Batch {
    /// Solo se llama con filas sin error, que siempre traen todos los campos.
    fn push(&mut self, row: &Row, category: Option<Uuid>) {
        let (Some(kind), Some(amount), Some(date), Some(import_ref)) =
            (row.kind, row.amount_cents, row.occurred_on, row.import_ref.clone())
        else {
            return;
        };
        self.categories.push(category);
        self.kinds.push(kind.to_string());
        self.amounts.push(amount);
        self.dates.push(date);
        self.descriptions.push(row.description.clone());
        self.refs.push(import_ref);
    }
}

async fn confirm(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<ConfirmBody>,
) -> AppResult<(StatusCode, Json<ConfirmResponse>)> {
    let (rows, _) = analyze(state.db(), auth.id, body.csv, body.mapping).await?;
    validate_categories(state.db(), auth.id, &rows, &body.categories).await?;

    // Un `skip` pesa más que "duplicada": es una decisión del usuario sobre una fila válida.
    let skip: HashSet<usize> = body.skip.into_iter().collect();
    let (mut skipped, mut duplicates) = (0, 0);
    let mut batch = Batch::default();
    for row in rows.iter().filter(|r| r.error.is_none()) {
        if skip.contains(&row.index) {
            skipped += 1;
        } else if row.duplicate {
            duplicates += 1;
        } else {
            let category = body.categories.get(&row.index).copied().unwrap_or(row.category_id);
            batch.push(row, category);
        }
    }

    let pending = batch.refs.len();
    let inserted = if pending == 0 {
        0
    } else {
        // Un solo INSERT es atómico: o entran todas o ninguna. `created_at` baja una
        // micro por fila para que la lista (ordenada por fecha y alta) respete el orden
        // del fichero y la paginación sea estable con filas del mismo día.
        // El árbitro del ON CONFLICT es el índice parcial de la migración 0003: si otra
        // importación se cuela entre el análisis y el INSERT, esa fila cuenta como duplicada.
        let result = sqlx::query(
            "INSERT INTO transactions (user_id, category_id, kind, amount_cents, occurred_on, description, import_ref, created_at) \
             SELECT $1, t.category_id, t.kind, t.amount_cents, t.occurred_on, t.description, t.import_ref, \
                    now() - t.ord * interval '1 microsecond' \
             FROM UNNEST($2::uuid[], $3::text[], $4::bigint[], $5::date[], $6::text[], $7::text[]) \
                  WITH ORDINALITY AS t(category_id, kind, amount_cents, occurred_on, description, import_ref, ord) \
             ON CONFLICT (user_id, import_ref) WHERE import_ref IS NOT NULL DO NOTHING",
        )
        .bind(auth.id)
        .bind(&batch.categories)
        .bind(&batch.kinds)
        .bind(&batch.amounts)
        .bind(&batch.dates)
        .bind(&batch.descriptions)
        .bind(&batch.refs)
        .execute(state.db())
        .await?;
        usize::try_from(result.rows_affected()).map_err(|_| AppError::Internal("recuento fuera de rango".into()))?
    };
    duplicates += pending - inserted;

    Ok((StatusCode::CREATED, Json(ConfirmResponse { inserted, duplicates, skipped })))
}
