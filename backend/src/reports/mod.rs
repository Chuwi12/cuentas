pub(crate) mod calc;
mod csv;
mod handlers;

pub(crate) use handlers::build_report;

use crate::state::AppState;
use axum::Router;

pub fn routes() -> Router<AppState> {
    handlers::routes()
}
