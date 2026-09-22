use crate::error::AppError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use tower_cookies::{Cookie, Cookies, cookie::SameSite, cookie::time::Duration};
use uuid::Uuid;

pub const COOKIE_NAME: &str = "auth_token";

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// id del usuario
    pub sub: String,
    /// expiración (unix seconds)
    pub exp: i64,
    /// emitido en (unix seconds)
    pub iat: i64,
}

/// Usuario autenticado. Cualquier handler que lo pida en su firma queda
/// protegido: si la cookie falta o el token no valida, devuelve 401 sin
/// llegar a ejecutarse.
#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub id: Uuid,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let cookies = Cookies::from_request_parts(parts, state)
            .await
            .map_err(|_| AppError::Internal("falta la capa CookieManagerLayer".into()))?;

        let token = cookies
            .get(COOKIE_NAME)
            .map(|c| c.value().to_owned())
            .ok_or(AppError::Unauthorized)?;

        let claims = decode_token(&token, state.config().jwt_secret.as_bytes())?;
        let id = Uuid::parse_str(&claims.sub).map_err(|_| AppError::Unauthorized)?;
        Ok(AuthUser { id })
    }
}

pub fn encode_token(user_id: Uuid, secret: &[u8], hours: i64) -> Result<String, AppError> {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: user_id.to_string(),
        iat: now,
        exp: now + hours * 3600,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret))
        .map_err(|e| AppError::Internal(format!("no se pudo firmar el token: {e}")))
}

pub fn decode_token(token: &str, secret: &[u8]) -> Result<Claims, AppError> {
    // La validación de `exp` va activada por defecto en jsonwebtoken.
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret),
        &Validation::new(Algorithm::HS256),
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::Unauthorized)
}

/// Cookie de sesión: httpOnly (inalcanzable desde JS, así un XSS no roba la
/// sesión), SameSite=Lax y Secure solo cuando hay HTTPS delante.
pub fn session_cookie(token: String, hours: i64, secure: bool) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, token))
        .path("/")
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .max_age(Duration::hours(hours))
        .build()
}

pub fn clear_cookie(secure: bool) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .max_age(Duration::seconds(0))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"un-secreto-de-pruebas-de-al-menos-32-bytes";

    /// Firma y verifica de verdad: detecta que falte el backend criptográfico de
    /// jsonwebtoken (compila, pero hace panic en tiempo de ejecución).
    #[test]
    fn firma_y_verifica_un_token() {
        let id = Uuid::new_v4();
        let token = encode_token(id, SECRET, 1).unwrap();
        let claims = decode_token(&token, SECRET).unwrap();
        assert_eq!(claims.sub, id.to_string());
    }

    #[test]
    fn rechaza_token_con_otro_secreto_o_caducado() {
        let token = encode_token(Uuid::new_v4(), SECRET, 1).unwrap();
        assert!(decode_token(&token, b"otro-secreto-distinto-de-32-bytes-o-mas").is_err());
        let caducado = encode_token(Uuid::new_v4(), SECRET, -2).unwrap();
        assert!(decode_token(&caducado, SECRET).is_err());
        assert!(decode_token("basura", SECRET).is_err());
    }
}
