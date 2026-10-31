pub(crate) mod calc;
mod handlers;

pub(crate) use handlers::{build_summary, build_trend};

use crate::state::AppState;
use axum::Router;

pub fn routes() -> Router<AppState> {
    handlers::routes()
}
