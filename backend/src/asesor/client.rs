//! Cliente HTTP del servicio del asesor (contrato interno de `docs/ASESOR.md`).
//! Pone el Bearer, el `user_id` de la sesión y reenvía la respuesta al navegador.

use crate::error::{AppError, AppResult};
use axum::body::Body;
use axum::http::{HeaderName, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use reqwest::Url;
use serde::Serialize;
use serde::de::IgnoredAny;
use std::fmt::Display;
use std::time::Duration;
use uuid::Uuid;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Entre dos lecturas, no total. Holgado porque el asesor no manda las
/// cabeceras hasta el primer token, y en una CPU modesta procesar el prompt
/// tarda minutos. El asesor corta solo a los 15 min, así que nada queda colgado.
const READ_TIMEOUT: Duration = Duration::from_secs(600);
/// Listar o borrar recuerdos no genera nada: si tarda tanto, algo falla.
const SHORT_TIMEOUT: Duration = Duration::from_secs(15);

const UNREACHABLE: &str =
    "El asesor no responde; comprueba que el servicio y Ollama están en marcha";
const NOT_CONFIGURED: &str = "El asesor no está configurado";

pub struct AsesorClient {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl AsesorClient {
    /// Sin token el cliente se crea igual: cada llamada responde 503.
    pub fn new(url: &str, token: Option<String>) -> Result<Self, String> {
        let parsed =
            Url::parse(url).map_err(|e| format!("ASESOR_URL no es una URL válida: {e}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("ASESOR_URL debe empezar por http:// o https://".into());
        }
        // Por http el token y las cifras viajarían en claro: solo a esta máquina.
        let host = parsed.host_str().unwrap_or("").trim_matches(['[', ']']);
        let local = host == "localhost"
            || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
        if parsed.scheme() == "http" && !local {
            return Err(
                "ASESOR_URL por http solo puede apuntar a esta máquina (127.0.0.1, ::1 o localhost); para otro host usa https"
                    .into(),
            );
        }
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            // El asesor es local: ni proxies del entorno ni redirecciones que
            // lleven el token a otro sitio.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("no se pudo crear el cliente del asesor: {e}"))?;
        Ok(Self {
            http,
            base: url.trim_end_matches('/').to_string(),
            token,
        })
    }

    fn request(&self, method: Method, path: &str) -> AppResult<reqwest::RequestBuilder> {
        let token = self
            .token
            .as_deref()
            .ok_or_else(|| AppError::AsesorUnavailable(NOT_CONFIGURED.into()))?;
        Ok(self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token))
    }

    /// GET/DELETE. `user_id` es el de la sesión y se añade aquí: la query del
    /// cliente nunca llega al asesor.
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        user_id: Uuid,
        query: &[(&str, &str)],
    ) -> AppResult<Response> {
        let resp = self
            .request(method, path)?
            .query(&[("user_id", user_id.to_string())])
            .query(query)
            .timeout(SHORT_TIMEOUT)
            .send()
            .await
            .map_err(unavailable)?;
        finish(resp, false).await
    }

    /// POST cuya respuesta es un stream NDJSON. El cuerpo lleva el `user_id`
    /// de la sesión (lo pone el handler al construirlo).
    pub async fn stream(&self, path: &str, body: &impl Serialize) -> AppResult<Response> {
        let resp = self
            .request(Method::POST, path)?
            .json(body)
            .send()
            .await
            .map_err(unavailable)?;
        finish(resp, true).await
    }
}

fn unavailable(e: impl Display) -> AppError {
    tracing::warn!(error = %e, "el asesor no responde");
    AppError::AsesorUnavailable(UNREACHABLE.into())
}

/// Convierte la respuesta del asesor en la nuestra. Estados y cuerpos de error
/// pasan tal cual, salvo lo que no podría haber dicho el asesor (401, no JSON).
async fn finish(resp: reqwest::Response, stream: bool) -> AppResult<Response> {
    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED {
        // Ya tenemos sesión válida: un 401 aquí es un token distinto entre los
        // dos servicios, no un usuario sin iniciar sesión.
        return Err(unavailable("el asesor rechaza ASESOR_TOKEN"));
    }
    if !(status.is_success() || status.is_client_error() || status.is_server_error()) {
        return Err(unavailable(format!("estado inesperado {status}")));
    }
    if stream && status.is_success() {
        // Soltar el cuerpo (el navegador se fue) cierra la conexión con el
        // asesor, que aborta la generación en Ollama.
        return Ok((
            status,
            [
                (header::CONTENT_TYPE, "application/x-ndjson"),
                (header::CACHE_CONTROL, "no-store"),
                (HeaderName::from_static("x-accel-buffering"), "no"),
            ],
            Body::from_stream(resp.bytes_stream()),
        )
            .into_response());
    }
    let bytes = resp.bytes().await.map_err(unavailable)?;
    if bytes.is_empty() {
        return Ok(status.into_response());
    }
    if serde_json::from_slice::<IgnoredAny>(&bytes).is_err() {
        return Err(unavailable(format!(
            "el asesor respondió {status} con un cuerpo que no es JSON"
        )));
    }
    Ok((status, [(header::CONTENT_TYPE, "application/json")], bytes).into_response())
}

#[cfg(test)]
mod tests_url {
    use super::AsesorClient;

    #[test]
    fn por_http_solo_loopback() {
        for ok in ["http://127.0.0.1:8090", "http://localhost:8090", "http://[::1]:8090", "https://asesor.example.com"] {
            assert!(AsesorClient::new(ok, None).is_ok(), "{ok}");
        }
        for mal in ["http://192.168.1.10:8090", "http://asesor.example.com", "ftp://127.0.0.1", "127.0.0.1:8090"] {
            assert!(AsesorClient::new(mal, None).is_err(), "{mal}");
        }
    }
}
