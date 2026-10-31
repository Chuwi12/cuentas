//! API pública del asesor financiero (`/api/asesor/*`, contrato en
//! `docs/ASESOR.md`). Aquí se valida, se calculan los datos y se pone el
//! `user_id` de la sesión; el texto lo genera el servicio del asesor.

mod client;
mod facts;
#[cfg(test)]
mod tests;

pub use client::AsesorClient;

use crate::auth::AuthUser;
use crate::domain::{MAX_DATE, MIN_DATE};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::summary::calc::{format_month, parse_month, ymd_to_month};
use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::Method;
use axum::response::Response;
use axum::routing::{delete, get, post};
use chrono::{Datelike, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_QUESTION_CHARS: usize = 1000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/analisis", get(get_analisis).post(post_analisis))
        .route("/preguntas", post(post_pregunta))
        .route("/memorias", get(list_memorias))
        .route("/memorias/{id}", delete(delete_memoria))
}

#[derive(Debug, Deserialize)]
struct MonthQuery {
    month: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnalisisBody {
    month: String,
}

#[derive(Debug, Deserialize)]
struct PreguntaBody {
    question: String,
    month: Option<String>,
}

/// Lo que recibe el asesor para analizar o responder; `user_id` sale de la sesión.
#[derive(Serialize)]
struct AnalisisReq<'a> {
    user_id: Uuid,
    month: &'a str,
    facts: &'a facts::Facts,
}

#[derive(Serialize)]
struct PreguntaReq<'a> {
    user_id: Uuid,
    question: &'a str,
    facts: &'a facts::Facts,
}

async fn get_analisis(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<MonthQuery>,
) -> AppResult<Response> {
    let (year, month) = resolve_month(q.month.as_deref(), Local::now().date_naive())?;
    let month = format_month(year, month);
    state
        .asesor()
        .call(Method::GET, "/analisis", user.id, &[("month", &month)])
        .await
}

async fn post_analisis(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<AnalisisBody>,
) -> AppResult<Response> {
    let today = Local::now().date_naive();
    let (year, month) = resolve_month(Some(&body.month), today)?;
    let facts = facts::build(state.db(), user.id, (year, month), today).await?;
    let month = format_month(year, month);
    state
        .asesor()
        .stream(
            "/analisis",
            &AnalisisReq {
                user_id: user.id,
                month: &month,
                facts: &facts,
            },
        )
        .await
}

async fn post_pregunta(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<PreguntaBody>,
) -> AppResult<Response> {
    let question = validate_question(&body.question)?;
    let today = Local::now().date_naive();
    let ym = resolve_month(body.month.as_deref(), today)?;
    let facts = facts::build(state.db(), user.id, ym, today).await?;
    state
        .asesor()
        .stream(
            "/preguntas",
            &PreguntaReq {
                user_id: user.id,
                question,
                facts: &facts,
            },
        )
        .await
}

async fn list_memorias(State(state): State<AppState>, user: AuthUser) -> AppResult<Response> {
    state
        .asesor()
        .call(Method::GET, "/memorias", user.id, &[])
        .await
}

async fn delete_memoria(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    state
        .asesor()
        .call(Method::DELETE, &format!("/memorias/{id}"), user.id, &[])
        .await
}

/// Mes pedido (o el actual) con el formato de `/api/summary`. Además se exige
/// el rango de años de los informes, porque el informe del mes va en los datos.
fn resolve_month(raw: Option<&str>, today: NaiveDate) -> AppResult<(i32, u32)> {
    let (year, month) = match raw {
        Some(s) => parse_month(s)?,
        None => ymd_to_month(today),
    };
    if !(MIN_DATE.year()..=MAX_DATE.year()).contains(&year) {
        return Err(AppError::Validation(format!(
            "mes fuera de rango: debe estar entre {}-01 y {}-12",
            MIN_DATE.year(),
            MAX_DATE.year()
        )));
    }
    Ok((year, month))
}

/// Pregunta recortada, de 1 a 1000 caracteres (no bytes).
fn validate_question(raw: &str) -> AppResult<&str> {
    let question = raw.trim();
    match question.chars().count() {
        0 => Err(AppError::Validation(
            "la pregunta no puede estar vacía".into(),
        )),
        n if n > MAX_QUESTION_CHARS => Err(AppError::Validation(format!(
            "la pregunta no puede pasar de {MAX_QUESTION_CHARS} caracteres"
        ))),
        _ => Ok(question),
    }
}

#[cfg(test)]
mod tests_validacion {
    use super::*;

    fn hoy() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 31).unwrap()
    }

    #[test]
    fn month_como_en_summary_y_actual_por_defecto() {
        assert_eq!(resolve_month(Some("2026-09"), hoy()).unwrap(), (2026, 9));
        assert_eq!(resolve_month(None, hoy()).unwrap(), (2026, 10));
        for malo in ["2026-13", "2026-9", "basura", "", "2026-09-01"] {
            assert!(resolve_month(Some(malo), hoy()).is_err(), "{malo}");
        }
    }

    #[test]
    fn month_fuera_del_rango_de_los_informes() {
        assert!(resolve_month(Some("2000-01"), hoy()).is_ok());
        assert!(resolve_month(Some("2100-12"), hoy()).is_ok());
        assert!(resolve_month(Some("1999-12"), hoy()).is_err());
        assert!(resolve_month(Some("2101-01"), hoy()).is_err());
    }

    #[test]
    fn pregunta_se_recorta_y_cuenta_caracteres() {
        assert_eq!(
            validate_question("  ¿Cuánto gasté?  \n").unwrap(),
            "¿Cuánto gasté?"
        );
        assert!(validate_question("").is_err());
        assert!(validate_question(" \t\n ").is_err());
        assert!(validate_question("a").is_ok());
        assert!(validate_question(&"a".repeat(1000)).is_ok());
        assert!(validate_question(&"a".repeat(1001)).is_err());
        // 1000 caracteres de 2 bytes: pasa aunque ocupe 2000 bytes.
        assert!(validate_question(&"ñ".repeat(1000)).is_ok());
        assert!(validate_question(&"ñ".repeat(1001)).is_err());
        // Los espacios de los extremos no cuentan.
        assert!(validate_question(&format!("  {}  ", "a".repeat(1000))).is_ok());
    }
}
