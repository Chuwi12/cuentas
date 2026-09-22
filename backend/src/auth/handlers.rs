//! Handlers de `/api/auth`. Ver `docs/API.md` para el contrato exacto.

use super::jwt::{self, AuthUser};
use super::{password, rate_limit, seed};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use tower_cookies::Cookies;
use uuid::Uuid;

/// Clave arbitraria para `pg_advisory_xact_lock`. Cualquier `bigint` sirve;
/// esta identifica el candado de "solo puede registrarse un usuario" y no
/// colisiona con nada más en esta app (no hay otros advisory locks).
const REGISTRATION_LOCK_KEY: i64 = 7_264_918_305;

/// `User` tal y como viaja en el JSON del contrato: nunca lleva
/// `password_hash`. Es un tipo distinto de la fila de BD a propósito, para
/// que sea imposible serializar el hash por descuido.
#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub created_at: DateTime<Utc>,
}

impl From<UserRow> for User {
    fn from(row: UserRow) -> Self {
        User {
            id: row.id,
            email: row.email,
            created_at: row.created_at,
        }
    }
}

/// Fila cruda de `users`. Solo se usa dentro de este módulo.
#[derive(Debug, Clone, sqlx::FromRow)]
struct UserRow {
    id: Uuid,
    email: String,
    password_hash: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub user: User,
}

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub registration_open: bool,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

const SELECT_USER_BY_EMAIL: &str =
    "SELECT id, email, password_hash, created_at FROM users WHERE email = $1";
const SELECT_USER_BY_ID: &str =
    "SELECT id, email, password_hash, created_at FROM users WHERE id = $1";
const COUNT_USERS: &str = "SELECT count(*) FROM users";
const INSERT_USER: &str = "INSERT INTO users (email, password_hash) VALUES ($1, $2) \
     RETURNING id, email, password_hash, created_at";

/// `GET /api/auth/status` — `registration_open` es `true` mientras la tabla
/// `users` esté vacía (app de un solo usuario).
pub async fn status(State(state): State<AppState>) -> AppResult<Json<StatusResponse>> {
    let count: i64 = sqlx::query_scalar(COUNT_USERS).fetch_one(state.db()).await?;
    Ok(Json(StatusResponse {
        registration_open: count == 0,
    }))
}

/// `POST /api/auth/register` — solo funciona si no existe ningún usuario.
/// La comprobación y la creación van en la misma transacción, protegida por
/// un advisory lock, para que dos registros concurrentes no cuelen dos
/// usuarios (la tabla no tiene ninguna otra forma de impedirlo: no hay
/// columna que limite a una sola fila).
pub async fn register(
    State(state): State<AppState>,
    cookies: Cookies,
    Json(body): Json<RegisterRequest>,
) -> AppResult<(StatusCode, Json<UserResponse>)> {
    let email = password::normalize_email(&body.email)?;
    password::validate_password(&body.password)?;

    let rate_key = format!("register:{email}");
    if !rate_limit::is_allowed(&rate_key) {
        return Err(AppError::Validation(
            "Demasiados intentos. Espera unos minutos.".into(),
        ));
    }

    // Argon2 es CPU-bound: no bloquear el executor de tokio.
    let raw_password = body.password.clone();
    let hash = tokio::task::spawn_blocking(move || password::hash_password(&raw_password))
        .await
        .map_err(|e| AppError::Internal(format!("la tarea de hashing falló: {e}")))??;

    let mut tx: Transaction<'_, Postgres> = state.db().begin().await?;

    // El advisory lock serializa a los registros concurrentes: el segundo
    // espera aquí hasta que el primero haga commit/rollback, y para
    // entonces ya verá `count > 0`.
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(REGISTRATION_LOCK_KEY)
        .execute(&mut *tx)
        .await?;

    let count: i64 = sqlx::query_scalar(COUNT_USERS).fetch_one(&mut *tx).await?;
    if count > 0 {
        rate_limit::record_failure(&rate_key);
        return Err(AppError::RegistrationClosed);
    }

    let row: UserRow = sqlx::query_as(INSERT_USER)
        .bind(&email)
        .bind(&hash)
        .fetch_one(&mut *tx)
        .await?;

    seed::seed_categories(&mut tx, row.id).await?;

    tx.commit().await?;
    rate_limit::clear(&rate_key);

    let token = jwt::encode_token(
        row.id,
        state.config().jwt_secret.as_bytes(),
        state.config().session_hours,
    )?;
    cookies.add(jwt::session_cookie(
        token,
        state.config().session_hours,
        state.config().cookie_secure,
    ));

    Ok((StatusCode::CREATED, Json(UserResponse { user: row.into() })))
}

/// `POST /api/auth/login` — mismo error tanto si el email no existe como si
/// la contraseña no cuadra, y mismo coste temporal en ambos casos (se
/// verifica contra un hash ficticio cuando el email no existe).
pub async fn login(
    State(state): State<AppState>,
    cookies: Cookies,
    Json(body): Json<LoginRequest>,
) -> AppResult<(StatusCode, Json<UserResponse>)> {
    let email = body.email.trim().to_lowercase();

    let rate_key = format!("login:{email}");
    if !rate_limit::is_allowed(&rate_key) {
        return Err(AppError::Validation(
            "Demasiados intentos. Espera unos minutos.".into(),
        ));
    }

    let found: Option<UserRow> = sqlx::query_as(SELECT_USER_BY_EMAIL)
        .bind(&email)
        .fetch_optional(state.db())
        .await?;

    let raw_password = body.password.clone();
    let (matched, found) = match found {
        Some(row) => {
            let stored_hash = row.password_hash.clone();
            let ok = tokio::task::spawn_blocking(move || {
                password::verify_password(&raw_password, &stored_hash)
            })
            .await
            .map_err(|e| AppError::Internal(format!("la tarea de verificación falló: {e}")))?;
            (ok, Some(row))
        }
        None => {
            // No existe el usuario: igual se gasta el mismo tiempo de CPU
            // verificando contra un hash ficticio, para que la respuesta no
            // llegue antes que en el caso "email correcto, password mala".
            let dummy_hash = password::DUMMY_HASH.clone();
            tokio::task::spawn_blocking(move || {
                password::verify_password(&raw_password, &dummy_hash)
            })
            .await
            .map_err(|e| AppError::Internal(format!("la tarea de verificación falló: {e}")))?;
            (false, None)
        }
    };

    let row = match (matched, found) {
        (true, Some(row)) => row,
        _ => {
            rate_limit::record_failure(&rate_key);
            return Err(AppError::InvalidCredentials);
        }
    };

    rate_limit::clear(&rate_key);

    let token = jwt::encode_token(
        row.id,
        state.config().jwt_secret.as_bytes(),
        state.config().session_hours,
    )?;
    cookies.add(jwt::session_cookie(
        token,
        state.config().session_hours,
        state.config().cookie_secure,
    ));

    Ok((StatusCode::OK, Json(UserResponse { user: row.into() })))
}

/// `POST /api/auth/logout` — siempre vacía la cookie, haya o no sesión.
pub async fn logout(State(state): State<AppState>, cookies: Cookies) -> StatusCode {
    cookies.add(jwt::clear_cookie(state.config().cookie_secure));
    StatusCode::NO_CONTENT
}

/// `GET /api/auth/me` — si el usuario del token ya no existe en BD (p. ej.
/// se borró a mano), la sesión se trata como inválida.
pub async fn me(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<UserResponse>> {
    let row: Option<UserRow> = sqlx::query_as(SELECT_USER_BY_ID)
        .bind(user.id)
        .fetch_optional(state.db())
        .await?;

    let row = row.ok_or(AppError::Unauthorized)?;
    Ok(Json(UserResponse { user: row.into() }))
}
