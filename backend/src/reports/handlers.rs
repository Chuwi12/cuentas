//! Informes: handlers HTTP + queries SQL. Las agregaciones se hacen en
//! Postgres; `calc.rs` solo recibe totales ya sumados. Todas las queries
//! filtran por `user_id` en transacciones y en categorías (defensa en
//! profundidad, igual que `summary`).

use crate::auth::AuthUser;
use crate::domain::{Bucket, Kind};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use chrono::{Local, NaiveDate};
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use super::calc::{
    self, CategoryAgg, Detail, InsightInput, Params, Period, PeriodKind, PreviousPeriod,
    ReportResponse, SeriesPoint, TopTransaction, Totals,
};
use super::csv::{self, TxRow};

/// Tope de filas del CSV; se pide una de más para saber si se supera.
const MAX_CSV_ROWS: i64 = 100_000;
const TOP_TRANSACTIONS: i64 = 10;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(report))
        .route("/export.csv", get(export_csv))
}

/// Los parámetros llegan como texto para validarlos aquí y responder con
/// mensajes en español (el rechazo por defecto de axum es genérico).
#[derive(Debug, Deserialize)]
pub struct ReportQuery {
    period: Option<String>,
    date: Option<String>,
    scope: Option<String>,
    detail: Option<String>,
}

fn params(q: &ReportQuery) -> AppResult<Params> {
    calc::resolve_params(
        q.period.as_deref(),
        q.date.as_deref(),
        q.scope.as_deref(),
        Local::now().date_naive(),
    )
}

async fn report(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ReportQuery>,
) -> AppResult<Json<ReportResponse>> {
    let Params { period, scope } = params(&q)?;
    let previous = calc::previous_period(&period);
    let db = state.db();

    let (totals_pair, series, category_rows, top, largest) = tokio::try_join!(
        fetch_totals(db, user.id, &period, &previous),
        fetch_series(db, user.id, &period),
        fetch_categories(db, user.id, &period),
        fetch_top(db, user.id, &period, scope.kind_filter(), TOP_TRANSACTIONS),
        // El mayor gasto individual alimenta un insight aunque scope sea `income`.
        fetch_top(db, user.id, &period, Some(Kind::Expense), 1),
    )?;
    let (totals, previous_totals) = totals_pair;

    let categories = calc::build_categories(category_rows);
    let buckets = calc::build_buckets(&categories, totals.income_cents);
    let insights = calc::build_insights(&InsightInput {
        period: &period,
        totals: &totals,
        previous: &previous_totals,
        categories: &categories,
        buckets: &buckets,
        largest_expense: largest.first(),
    });

    Ok(Json(ReportResponse {
        period,
        scope,
        totals,
        previous: PreviousPeriod { period: previous, totals: previous_totals },
        series: series.into_iter().map(|p| p.apply_scope(scope)).collect(),
        by_category: categories.into_iter().filter(|c| scope.includes(c.kind)).collect(),
        buckets,
        top_transactions: top,
        insights,
    }))
}

async fn export_csv(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ReportQuery>,
) -> AppResult<Response> {
    let Params { period, scope } = params(&q)?;
    let detail = calc::parse_detail(q.detail.as_deref())?;

    let body = match detail {
        Detail::Transactions => {
            let rows = fetch_csv_rows(state.db(), user.id, &period, scope.kind_filter()).await?;
            if rows.len() as i64 > MAX_CSV_ROWS {
                return Err(too_many_rows());
            }
            csv::transactions_csv(&rows)
        }
        Detail::Categories => {
            let rows = fetch_categories(state.db(), user.id, &period).await?;
            let categories = calc::build_categories(rows);
            let shown: Vec<_> = categories.iter().filter(|c| scope.includes(c.kind)).collect();
            csv::categories_csv(&shown)
        }
    };

    let filename = csv::safe_filename(scope.as_str(), period.kind.as_str(), period.from);
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
        .map_err(|e| AppError::Internal(format!("cabecera Content-Disposition inválida: {e}")))?;

    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("text/csv; charset=utf-8")),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        ],
        body,
    )
        .into_response())
}

fn too_many_rows() -> AppError {
    AppError::Validation("Demasiados movimientos para exportar; acota el periodo".to_string())
}

// ---- Consultas ----

#[derive(Debug, sqlx::FromRow)]
struct TotalsRow {
    cur_income: i64,
    cur_expense: i64,
    cur_count: i64,
    prev_income: i64,
    prev_expense: i64,
    prev_count: i64,
}

/// Periodo actual y anterior en una sola pasada: son contiguos, así que un
/// único rango `[prev.from, cur.to]` los cubre y `FILTER` los separa.
async fn fetch_totals(
    db: &PgPool,
    user_id: Uuid,
    cur: &Period,
    prev: &Period,
) -> AppResult<(Totals, Totals)> {
    let r = sqlx::query_as::<_, TotalsRow>(
        "SELECT \
           COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'income' AND occurred_on >= $3), 0)::BIGINT AS cur_income, \
           COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'expense' AND occurred_on >= $3), 0)::BIGINT AS cur_expense, \
           (COUNT(*) FILTER (WHERE occurred_on >= $3))::BIGINT AS cur_count, \
           COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'income' AND occurred_on < $3), 0)::BIGINT AS prev_income, \
           COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'expense' AND occurred_on < $3), 0)::BIGINT AS prev_expense, \
           (COUNT(*) FILTER (WHERE occurred_on < $3))::BIGINT AS prev_count \
         FROM transactions \
         WHERE user_id = $1 AND occurred_on >= $2 AND occurred_on <= $4",
    )
    .bind(user_id)
    .bind(prev.from)
    .bind(cur.from)
    .bind(cur.to)
    .fetch_one(db)
    .await?;
    Ok((
        calc::make_totals(r.cur_income, r.cur_expense, r.cur_count),
        calc::make_totals(r.prev_income, r.prev_expense, r.prev_count),
    ))
}

#[derive(Debug, sqlx::FromRow)]
struct SeriesRow {
    from_day: NaiveDate,
    to_day: NaiveDate,
    income_cents: i64,
    expense_cents: i64,
}

/// Serie completa con `generate_series`: días (semana, mes) o meses (año).
/// Los huecos salen a 0 gracias al `LEFT JOIN`. Se trabaja con `timestamp`
/// (sin zona) para que la aritmética de meses no dependa del huso de la sesión.
async fn fetch_series(db: &PgPool, user_id: Uuid, period: &Period) -> AppResult<Vec<SeriesPoint>> {
    let step = match period.kind {
        PeriodKind::Year => "1 month",
        PeriodKind::Week | PeriodKind::Month => "1 day",
    };
    let rows = sqlx::query_as::<_, SeriesRow>(
        "WITH slots AS ( \
           SELECT g.ts::date AS slot_from, (g.ts + $4::text::interval)::date AS slot_next \
           FROM generate_series($2::date::timestamp, $3::date::timestamp, $4::text::interval) AS g(ts) \
         ) \
         SELECT s.slot_from AS from_day, (s.slot_next - 1) AS to_day, \
                COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'income'), 0)::BIGINT AS income_cents, \
                COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'expense'), 0)::BIGINT AS expense_cents \
         FROM slots s \
         LEFT JOIN transactions t \
           ON t.user_id = $1 AND t.occurred_on >= s.slot_from AND t.occurred_on < s.slot_next \
         GROUP BY s.slot_from, s.slot_next \
         ORDER BY s.slot_from ASC",
    )
    .bind(user_id)
    .bind(period.from)
    .bind(period.to)
    .bind(step)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| SeriesPoint {
            from: r.from_day,
            to: r.to_day,
            income_cents: r.income_cents,
            expense_cents: r.expense_cents,
        })
        .collect())
}

#[derive(Debug, sqlx::FromRow)]
struct CategoryRow {
    category_id: Option<Uuid>,
    name: Option<String>,
    color: Option<String>,
    kind: Kind,
    bucket: Option<Bucket>,
    amount_cents: i64,
    count: i64,
}

/// Agregado por categoría y tipo. Se agrupa por `c.id` (no por
/// `t.category_id`) para que un movimiento cuya categoría no fuera del usuario
/// caiga en "sin categoría" en vez de filtrarse.
async fn fetch_categories(db: &PgPool, user_id: Uuid, period: &Period) -> AppResult<Vec<CategoryAgg>> {
    let rows = sqlx::query_as::<_, CategoryRow>(
        "SELECT c.id AS category_id, c.name AS name, c.color AS color, t.kind AS kind, c.bucket AS bucket, \
                SUM(t.amount_cents)::BIGINT AS amount_cents, COUNT(*)::BIGINT AS count \
         FROM transactions t \
         LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = $1 \
         WHERE t.user_id = $1 AND t.occurred_on >= $2 AND t.occurred_on <= $3 \
         GROUP BY c.id, c.name, c.color, t.kind, c.bucket",
    )
    .bind(user_id)
    .bind(period.from)
    .bind(period.to)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| CategoryAgg {
            category_id: r.category_id,
            name: r.name,
            color: r.color,
            kind: r.kind,
            bucket: r.bucket,
            amount_cents: r.amount_cents,
            count: r.count,
        })
        .collect())
}

#[derive(Debug, sqlx::FromRow)]
struct TopRow {
    id: Uuid,
    occurred_on: NaiveDate,
    kind: Kind,
    amount_cents: i64,
    description: Option<String>,
    category_name: Option<String>,
    category_color: Option<String>,
}

/// Los `limit` movimientos de mayor importe; `kind` = `None` no filtra.
async fn fetch_top(
    db: &PgPool,
    user_id: Uuid,
    period: &Period,
    kind: Option<Kind>,
    limit: i64,
) -> AppResult<Vec<TopTransaction>> {
    let rows = sqlx::query_as::<_, TopRow>(
        "SELECT t.id, t.occurred_on, t.kind, t.amount_cents, t.description, \
                c.name AS category_name, c.color AS category_color \
         FROM transactions t \
         LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = $1 \
         WHERE t.user_id = $1 AND t.occurred_on >= $2 AND t.occurred_on <= $3 \
           AND ($4::text IS NULL OR t.kind = $4) \
         ORDER BY t.amount_cents DESC, t.occurred_on DESC, t.created_at DESC, t.id \
         LIMIT $5",
    )
    .bind(user_id)
    .bind(period.from)
    .bind(period.to)
    .bind(kind)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| TopTransaction {
            id: r.id,
            occurred_on: r.occurred_on,
            kind: r.kind,
            amount_cents: r.amount_cents,
            description: r.description,
            category_name: r.category_name,
            category_color: r.category_color,
        })
        .collect())
}

#[derive(Debug, sqlx::FromRow)]
struct CsvRow {
    occurred_on: NaiveDate,
    kind: Kind,
    category_name: Option<String>,
    bucket: Option<Bucket>,
    description: Option<String>,
    amount_cents: i64,
}

async fn fetch_csv_rows(
    db: &PgPool,
    user_id: Uuid,
    period: &Period,
    kind: Option<Kind>,
) -> AppResult<Vec<TxRow>> {
    let rows = sqlx::query_as::<_, CsvRow>(
        "SELECT t.occurred_on, t.kind, c.name AS category_name, c.bucket AS bucket, \
                t.description, t.amount_cents \
         FROM transactions t \
         LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = $1 \
         WHERE t.user_id = $1 AND t.occurred_on >= $2 AND t.occurred_on <= $3 \
           AND ($4::text IS NULL OR t.kind = $4) \
         ORDER BY t.occurred_on ASC, t.created_at ASC, t.id ASC \
         LIMIT $5",
    )
    .bind(user_id)
    .bind(period.from)
    .bind(period.to)
    .bind(kind)
    .bind(MAX_CSV_ROWS + 1)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| TxRow {
            occurred_on: r.occurred_on,
            kind: r.kind,
            category_name: r.category_name,
            bucket: r.bucket,
            description: r.description,
            amount_cents: r.amount_cents,
        })
        .collect())
}
