pub mod jwt;

use crate::state::AppState;
use axum::Router;

pub use jwt::AuthUser;

pub fn routes() -> Router<AppState> {
    Router::new()
}
