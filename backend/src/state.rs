use crate::asesor::AsesorClient;
use crate::config::Config;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub db: PgPool,
    pub config: Config,
    pub asesor: AsesorClient,
}

impl AppState {
    pub fn new(db: PgPool, config: Config, asesor: AsesorClient) -> Self {
        Self(Arc::new(Inner { db, config, asesor }))
    }
    pub fn db(&self) -> &PgPool {
        &self.0.db
    }
    pub fn config(&self) -> &Config {
        &self.0.config
    }
    pub fn asesor(&self) -> &AsesorClient {
        &self.0.asesor
    }
}
