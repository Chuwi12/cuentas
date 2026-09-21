use crate::config::Config;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub db: PgPool,
    pub config: Config,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        Self(Arc::new(Inner { db, config }))
    }
    pub fn db(&self) -> &PgPool {
        &self.0.db
    }
    pub fn config(&self) -> &Config {
        &self.0.config
    }
}
