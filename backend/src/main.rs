mod auth;
mod categories;
mod config;
mod domain;
mod error;
mod state;
mod summary;
mod transactions;

use axum::Router;
use axum::body::to_bytes;
use axum::http::{StatusCode, header};
use axum::middleware::map_response;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use config::Config;
use sqlx::postgres::PgPoolOptions;
use state::AppState;
use std::time::Duration;
use tower_cookies::CookieManagerLayer;
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,finanzas_backend=debug".into()),
        )
        .init();

    if let Err(e) = run().await {
        tracing::error!("fallo al arrancar: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;

    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;

    // Las migraciones se aplican al arrancar: no hace falta sqlx-cli para
    // levantar el proyecto desde cero.
    sqlx::migrate!("./migrations").run(&db).await?;
    tracing::info!("migraciones aplicadas");

    let bind_addr = config.bind_addr.clone();
    let state = AppState::new(db, config);

    let api = Router::new()
        .nest("/auth", auth::routes())
        .nest("/categories", categories::routes())
        .nest("/transactions", transactions::routes())
        .nest("/summary", summary::routes())
        .route("/health", get(|| async { "ok" }));

    let app = Router::new()
        .nest("/api", api)
        .layer(map_response(rejection_to_json))
        .layer(TraceLayer::new_for_http())
        .layer(CookieManagerLayer::new())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("escuchando en http://{bind_addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Los rechazos de los extractores de axum (JSON mal formado, query o ruta
/// inválidas) salen en texto plano y en inglés. Aquí se reescriben al formato
/// de error del contrato para que el frontend siempre reciba
/// `{"error": {"code", "message"}}`.
async fn rejection_to_json(res: Response) -> Response {
    let status = res.status();
    let is_text = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/plain"));
    if !status.is_client_error() || !is_text {
        return res;
    }
    let detail = to_bytes(res.into_body(), 4096)
        .await
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let (code, message) = match status {
        StatusCode::NOT_FOUND => ("not_found", "No encontrado".to_string()),
        StatusCode::METHOD_NOT_ALLOWED => ("not_found", "Método no permitido".to_string()),
        _ => ("validation", format!("Datos no válidos: {detail}")),
    };
    let body = serde_json::json!({"error": {"code": code, "message": message}});
    (status, axum::Json(body)).into_response()
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("apagando");
}
