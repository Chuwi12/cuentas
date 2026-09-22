mod calc;
mod handlers;

use crate::state::AppState;
use axum::Router;

pub fn routes() -> Router<AppState> {
    handlers::routes()
}
