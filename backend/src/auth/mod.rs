mod handlers;
pub mod jwt;
mod password;
mod rate_limit;
mod seed;

use crate::state::AppState;
use axum::Router;
use axum::routing::{get, post};

pub use jwt::AuthUser;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/status", get(handlers::status))
        .route("/register", post(handlers::register))
        .route("/login", post(handlers::login))
        .route("/logout", post(handlers::logout))
        .route("/me", get(handlers::me))
}
