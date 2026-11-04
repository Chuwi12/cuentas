use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Error de aplicación. Se serializa al formato del contrato:
/// `{"error": {"code": "...", "message": "..."}}`
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("no autenticado")]
    Unauthorized,
    #[error("credenciales incorrectas")]
    InvalidCredentials,
    #[error("el registro está cerrado: ya existe un usuario")]
    RegistrationClosed,
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Conflict(String),
    /// La importación CSV no puede deducir el formato de las fechas: el cliente debe pedir
    /// que se elija. Código propio para no reconocerlo por el texto del mensaje.
    #[error("{0}")]
    AmbiguousDate(String),
    #[error("no encontrado")]
    NotFound,
    /// El asesor (o Ollama detrás) no responde, o no está configurado.
    #[error("{0}")]
    AsesorUnavailable(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    fn parts(&self) -> (StatusCode, &'static str, String) {
        use AppError::*;
        match self {
            Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", self.to_string()),
            InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "Email o contraseña incorrectos".into(),
            ),
            RegistrationClosed => (StatusCode::FORBIDDEN, "registration_closed", self.to_string()),
            Validation(m) => (StatusCode::UNPROCESSABLE_ENTITY, "validation", m.clone()),
            Conflict(m) => (StatusCode::CONFLICT, "conflict", m.clone()),
            AmbiguousDate(m) => (StatusCode::UNPROCESSABLE_ENTITY, "ambiguous_date", m.clone()),
            NotFound => (StatusCode::NOT_FOUND, "not_found", self.to_string()),
            AsesorUnavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, "asesor_unavailable", m.clone()),
            Database(sqlx::Error::RowNotFound) => {
                (StatusCode::NOT_FOUND, "not_found", "No encontrado".into())
            }
            // Los detalles internos se registran, nunca se filtran al cliente.
            Database(_) | Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Error interno del servidor".into(),
            ),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = self.parts();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %self, "error interno");
        }
        (status, axum::Json(json!({"error": {"code": code, "message": message}}))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ambiguous_date_is_a_422_with_its_own_code() {
        let res = AppError::AmbiguousDate("elige el formato".into()).into_response();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"]["code"], "ambiguous_date");
        assert_eq!(json["error"]["message"], "elige el formato");
    }
}
