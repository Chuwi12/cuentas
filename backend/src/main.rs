mod auth;
mod categories;
mod config;
mod domain;
mod error;
mod state;
mod summary;
mod transactions;

use axum::Router;
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

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("apagando");
}
