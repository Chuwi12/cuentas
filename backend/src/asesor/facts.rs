//! Datos exactos que se le pasan al asesor. Los calcula Rust con las mismas
//! funciones que los endpoints de resumen e informes: el modelo solo explica.

use crate::error::AppResult;
use crate::reports::{
    self,
    calc::{Params, PeriodKind, ReportResponse, Scope, period_for},
};
use crate::summary::{
    self,
    calc::{SummaryResponse, TrendResponse, month_range, month_start_n_back, ymd_to_month},
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
    /// Resumen del mes anterior (enero → diciembre del año anterior): el asesor
    /// calcula con él las comparaciones para que el modelo no las deduzca.
    previous_summary: SummaryResponse,
    report: ReportResponse,
    trend: TrendResponse,
}

/// Mes natural anterior; enero pasa a diciembre del año anterior.
fn previous_month(year: i32, month: u32) -> (i32, u32) {
    ymd_to_month(month_start_n_back(year, month, 1))
}

pub async fn build(
    db: &PgPool,
    user_id: Uuid,
    (year, month): (i32, u32),
    today: NaiveDate,
) -> AppResult<Facts> {
    let summary = summary::build_summary(db, user_id, year, month).await?;
    let (prev_year, prev_month) = previous_month(year, month);
    let previous_summary = summary::build_summary(db, user_id, prev_year, prev_month).await?;
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
        previous_summary,
        report,
        trend,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_mes_anterior_cruza_el_cambio_de_ano() {
        assert_eq!(previous_month(2026, 1), (2025, 12));
        assert_eq!(previous_month(2026, 2), (2026, 1));
        assert_eq!(previous_month(2026, 12), (2026, 11));
        // El mínimo aceptado por la API (2000-01) tiene anterior: 1999-12.
        assert_eq!(previous_month(2000, 1), (1999, 12));
    }
}
