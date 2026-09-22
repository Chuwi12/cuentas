//! Consulta: handlers HTTP + queries SQL. Toda la aritmética vive en
//! `calc.rs`; aquí solo se agregan datos con `SUM` y se le pasan a la
//! función pura.

use crate::auth::AuthUser;
use crate::domain::{Bucket, Category, Kind};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::routing::get;
use chrono::{Local, NaiveDate};
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use super::calc::{self, BucketExpenses, SummaryResponse, TrendResponse};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(summary)).route("/trend", get(trend))
}

#[derive(Debug, Deserialize)]
pub struct SummaryQuery {
    month: Option<String>,
}

async fn summary(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<SummaryQuery>,
) -> AppResult<Json<SummaryResponse>> {
    let (year, month) = match q.month {
        Some(s) => calc::parse_month(&s)?,
        None => calc::ymd_to_month(Local::now().date_naive()),
    };
    let (from, to) = calc::month_range(year, month);

    let income_cents = fetch_income_cents(state.db(), user.id, from, to).await?;
    let bucket_expenses = fetch_bucket_expenses(state.db(), user.id, from, to).await?;
    let uncategorized_expense_cents =
        fetch_uncategorized_expense_cents(state.db(), user.id, from, to).await?;
    let category_expenses = fetch_category_expenses(state.db(), user.id, from, to).await?;

    let body = calc::compute_summary(
        calc::format_month(year, month),
        income_cents,
        bucket_expenses,
        uncategorized_expense_cents,
        category_expenses,
    );
    Ok(Json(body))
}

#[derive(Debug, Deserialize)]
pub struct TrendQuery {
    months: Option<String>,
}

async fn trend(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<TrendQuery>,
) -> AppResult<Json<TrendResponse>> {
    let months: u32 = match q.months {
        Some(s) => {
            let n: i64 = s
                .parse()
                .map_err(|_| AppError::Validation(format!("months inválido: «{s}», debe ser un entero")))?;
            if !(1..=36).contains(&n) {
                return Err(AppError::Validation(
                    "months debe estar entre 1 y 36".to_string(),
                ));
            }
            n as u32
        }
        None => 12,
    };

    let (cur_year, cur_month) = calc::ymd_to_month(Local::now().date_naive());
    let end = calc::month_start_n_back(cur_year, cur_month, 0);
    let start = calc::month_start_n_back(cur_year, cur_month, months - 1);

    let rows = fetch_trend_rows(state.db(), user.id, start, end).await?;

    let points = rows
        .into_iter()
        .map(|r| {
            let (y, m) = calc::ymd_to_month(r.month_start);
            calc::compute_trend_point(
                calc::format_month(y, m),
                r.income_cents,
                BucketExpenses {
                    needs_cents: r.needs_cents,
                    wants_cents: r.wants_cents,
                    savings_cents: r.savings_cents,
                },
                r.uncategorized_cents,
            )
        })
        .collect();

    Ok(Json(TrendResponse { points }))
}

// ---- Consultas ----
// Todas filtran por user_id (por transacción y, cuando aplica, también por
// categoría) por defensa en profundidad: un recurso de otro usuario nunca
// debe filtrarse aunque una FK quedara mal poblada.

async fn fetch_income_cents(db: &PgPool, user_id: Uuid, from: NaiveDate, to: NaiveDate) -> AppResult<i64> {
    let value = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(amount_cents), 0)::BIGINT FROM transactions \
         WHERE user_id = $1 AND kind = 'income' AND occurred_on >= $2 AND occurred_on < $3",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .fetch_one(db)
    .await?;
    Ok(value)
}

#[derive(Debug, sqlx::FromRow)]
struct BucketRow {
    bucket: Bucket,
    total_cents: i64,
}

async fn fetch_bucket_expenses(
    db: &PgPool,
    user_id: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> AppResult<BucketExpenses> {
    let rows = sqlx::query_as::<_, BucketRow>(
        "SELECT c.bucket AS bucket, COALESCE(SUM(t.amount_cents), 0)::BIGINT AS total_cents \
         FROM transactions t JOIN categories c ON c.id = t.category_id \
         WHERE t.user_id = $1 AND c.user_id = $1 AND t.kind = 'expense' \
           AND t.occurred_on >= $2 AND t.occurred_on < $3 \
         GROUP BY c.bucket",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;

    let mut out = BucketExpenses::default();
    for row in rows {
        match row.bucket {
            Bucket::Needs => out.needs_cents = row.total_cents,
            Bucket::Wants => out.wants_cents = row.total_cents,
            Bucket::Savings => out.savings_cents = row.total_cents,
        }
    }
    Ok(out)
}

async fn fetch_uncategorized_expense_cents(
    db: &PgPool,
    user_id: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> AppResult<i64> {
    let value = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(amount_cents), 0)::BIGINT FROM transactions \
         WHERE user_id = $1 AND kind = 'expense' AND category_id IS NULL \
           AND occurred_on >= $2 AND occurred_on < $3",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .fetch_one(db)
    .await?;
    Ok(value)
}

#[derive(Debug, sqlx::FromRow)]
struct CategoryAmountRow {
    id: Uuid,
    name: String,
    kind: Kind,
    bucket: Option<Bucket>,
    color: String,
    icon: String,
    is_archived: bool,
    sort_order: i32,
    amount_cents: i64,
}

async fn fetch_category_expenses(
    db: &PgPool,
    user_id: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> AppResult<Vec<(Category, i64)>> {
    let rows = sqlx::query_as::<_, CategoryAmountRow>(
        "SELECT c.id, c.name, c.kind, c.bucket, c.color, c.icon, c.is_archived, c.sort_order, \
                COALESCE(SUM(t.amount_cents), 0)::BIGINT AS amount_cents \
         FROM categories c JOIN transactions t ON t.category_id = c.id \
         WHERE c.user_id = $1 AND t.user_id = $1 AND t.kind = 'expense' \
           AND t.occurred_on >= $2 AND t.occurred_on < $3 \
         GROUP BY c.id, c.name, c.kind, c.bucket, c.color, c.icon, c.is_archived, c.sort_order",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| {
            (
                Category {
                    id: r.id,
                    name: r.name,
                    kind: r.kind,
                    bucket: r.bucket,
                    color: r.color,
                    icon: r.icon,
                    is_archived: r.is_archived,
                    sort_order: r.sort_order,
                },
                r.amount_cents,
            )
        })
        .collect())
}

#[derive(Debug, sqlx::FromRow)]
struct TrendRow {
    month_start: NaiveDate,
    income_cents: i64,
    needs_cents: i64,
    wants_cents: i64,
    savings_cents: i64,
    uncategorized_cents: i64,
}

/// Una sola query: `generate_series` sobre los meses del rango, `LEFT JOIN`
/// con `transactions`/`categories` para que los meses sin movimientos salgan
/// a 0 en vez de desaparecer.
async fn fetch_trend_rows(
    db: &PgPool,
    user_id: Uuid,
    start: NaiveDate,
    end: NaiveDate,
) -> AppResult<Vec<TrendRow>> {
    let rows = sqlx::query_as::<_, TrendRow>(
        "SELECT gs.month_start::date AS month_start, \
                COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount_cents ELSE 0 END), 0)::BIGINT AS income_cents, \
                COALESCE(SUM(CASE WHEN t.kind = 'expense' AND c.bucket = 'needs' THEN t.amount_cents ELSE 0 END), 0)::BIGINT AS needs_cents, \
                COALESCE(SUM(CASE WHEN t.kind = 'expense' AND c.bucket = 'wants' THEN t.amount_cents ELSE 0 END), 0)::BIGINT AS wants_cents, \
                COALESCE(SUM(CASE WHEN t.kind = 'expense' AND c.bucket = 'savings' THEN t.amount_cents ELSE 0 END), 0)::BIGINT AS savings_cents, \
                COALESCE(SUM(CASE WHEN t.kind = 'expense' AND t.category_id IS NULL THEN t.amount_cents ELSE 0 END), 0)::BIGINT AS uncategorized_cents \
         FROM generate_series($2::date, $3::date, interval '1 month') AS gs(month_start) \
         LEFT JOIN transactions t \
           ON t.user_id = $1 \
           AND t.occurred_on >= gs.month_start \
           AND t.occurred_on < gs.month_start + interval '1 month' \
         LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = $1 \
         GROUP BY gs.month_start \
         ORDER BY gs.month_start ASC",
    )
    .bind(user_id)
    .bind(start)
    .bind(end)
    .fetch_all(db)
    .await?;
    Ok(rows)
}
