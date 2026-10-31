//! Datos exactos que se le pasan al asesor. Los calcula Rust con las mismas
//! funciones que los endpoints de resumen e informes: el modelo solo explica.

use crate::error::AppResult;
use crate::reports::{
    self,
    calc::{Params, PeriodKind, ReportResponse, Scope, period_for},
};
use crate::summary::{
    self,
    calc::{SummaryResponse, TrendResponse, month_range, ymd_to_month},
};
use chrono::NaiveDate;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

/// Meses de evolución; el último es el analizado.
const TREND_MONTHS: u32 = 6;

#[derive(Serialize)]
pub struct Facts {
    month: String,
    today: NaiveDate,
    /// Mes en curso (o futuro): su ahorro todavía bajará.
    month_in_progress: bool,
    summary: SummaryResponse,
    report: ReportResponse,
    trend: TrendResponse,
}

pub async fn build(
    db: &PgPool,
    user_id: Uuid,
    (year, month): (i32, u32),
    today: NaiveDate,
) -> AppResult<Facts> {
    let summary = summary::build_summary(db, user_id, year, month).await?;
    // Igual que GET /api/reports?period=month&date=<month>-01 (scope all).
    let (first, _) = month_range(year, month);
    let report = reports::build_report(
        db,
        user_id,
        Params {
            period: period_for(PeriodKind::Month, first),
            scope: Scope::All,
        },
    )
    .await?;
    let trend = summary::build_trend(db, user_id, year, month, TREND_MONTHS).await?;

    Ok(Facts {
        month: summary.month.clone(),
        today,
        month_in_progress: (year, month) >= ymd_to_month(today),
        summary,
        report,
        trend,
    })
}
