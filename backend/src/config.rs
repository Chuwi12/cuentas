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
    pub asesor_url: String,
    /// Opcional: sin token el backend arranca y `/api/asesor/*` responde 503.
    pub asesor_token: Option<String>,
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
            asesor_url: env::var("ASESOR_URL").unwrap_or_else(|_| "http://127.0.0.1:8090".into()),
            asesor_token: asesor_token(env::var("ASESOR_TOKEN").ok())?,
        })
    }
}

/// Vacío cuenta como ausente (`ASESOR_TOKEN=` en el `.env.example`). Va en una
/// cabecera HTTP, así que solo admite ASCII visible.
fn asesor_token(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(token) = raw.filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if token.len() < 32 {
        return Err("ASESOR_TOKEN debe tener al menos 32 caracteres".into());
    }
    if !token.chars().all(|c| c.is_ascii_graphic()) {
        return Err("ASESOR_TOKEN solo admite caracteres ASCII visibles, sin espacios".into());
    }
    Ok(Some(token))
}

fn required(key: &str) -> Result<String, String> {
    env::var(key).map_err(|_| format!("falta la variable de entorno {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asesor_token_es_opcional_pero_exigente_si_esta() {
        assert_eq!(asesor_token(None), Ok(None));
        assert_eq!(asesor_token(Some(String::new())), Ok(None));
        assert!(asesor_token(Some("x".repeat(31))).is_err());
        assert_eq!(asesor_token(Some("x".repeat(32))), Ok(Some("x".repeat(32))));
        assert!(asesor_token(Some(format!("{} {}", "x".repeat(20), "y".repeat(20)))).is_err());
        assert!(asesor_token(Some(format!("{}ñ", "x".repeat(40)))).is_err());
    }
}
