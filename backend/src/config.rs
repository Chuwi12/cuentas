use std::env;

/// Configuración leída del entorno al arrancar. Si algo obligatorio falta,
/// el proceso muere aquí y no a mitad de una petición.
#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub jwt_secret: String,
    pub session_hours: i64,
    pub cookie_secure: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let jwt_secret = required("JWT_SECRET")?;
        if jwt_secret.len() < 32 {
            return Err("JWT_SECRET debe tener al menos 32 caracteres".into());
        }
        Ok(Self {
            database_url: required("DATABASE_URL")?,
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into()),
            jwt_secret,
            session_hours: env::var("SESSION_HOURS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(720),
            cookie_secure: env::var("COOKIE_SECURE").map(|v| v == "true").unwrap_or(false),
        })
    }
}

fn required(key: &str) -> Result<String, String> {
    env::var(key).map_err(|_| format!("falta la variable de entorno {key}"))
}
