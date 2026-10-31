//! Tests del proxy contra un asesor falso: un servidor HTTP mínimo sobre un
//! `TcpListener` del propio test. No necesitan red externa ni base de datos.

use super::*;
use crate::auth::jwt::{COOKIE_NAME, encode_token};
use crate::config::Config;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::timeout;
use tower::ServiceExt;
use tower_cookies::CookieManagerLayer;

const TOKEN: &str = "token-de-pruebas-de-al-menos-32-caracteres";
const SECRET: &str = "secreto-de-pruebas-de-al-menos-32-bytes-xx";
const NDJSON: &str =
    "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n";

/// Lo que el asesor falso vio llegar.
struct Recibida {
    linea: String,
    cabeceras: HashMap<String, String>,
    cuerpo: String,
}

async fn leer(sock: &mut TcpStream) -> Recibida {
    let mut buf = Vec::new();
    let fin_cabecera = loop {
        let mut tmp = [0u8; 1024];
        let n = sock.read(&mut tmp).await.unwrap();
        assert!(n > 0, "el cliente cerró antes de acabar la cabecera");
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let cabecera = String::from_utf8(buf[..fin_cabecera].to_vec()).unwrap();
    let mut lineas = cabecera.split("\r\n");
    let linea = lineas.next().unwrap().to_string();
    let cabeceras: HashMap<String, String> = lineas
        .filter_map(|l| l.split_once(": "))
        .map(|(k, v)| (k.to_lowercase(), v.to_string()))
        .collect();
    let largo: usize = cabeceras
        .get("content-length")
        .map_or(0, |v| v.parse().unwrap());
    while buf.len() < fin_cabecera + largo {
        let mut tmp = [0u8; 1024];
        let n = sock.read(&mut tmp).await.unwrap();
        assert!(n > 0, "el cliente cerró antes de acabar el cuerpo");
        buf.extend_from_slice(&tmp[..n]);
    }
    Recibida {
        linea,
        cabeceras,
        cuerpo: String::from_utf8(buf[fin_cabecera..].to_vec()).unwrap(),
    }
}

/// Asesor falso de una sola conexión: lee la petición, la entrega por el
/// canal y deja que `responder` escriba lo que quiera en el socket.
async fn asesor_falso<F, Fut>(responder: F) -> (String, oneshot::Receiver<Recibida>)
where
    F: FnOnce(TcpStream) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let _ = tx.send(leer(&mut sock).await);
        responder(sock).await;
    });
    (url, rx)
}

/// Respuesta completa de una vez.
async fn con_respuesta(
    estado: &str,
    tipo: &str,
    cuerpo: &str,
) -> (String, oneshot::Receiver<Recibida>) {
    let resp = format!(
        "HTTP/1.1 {estado}\r\nContent-Type: {tipo}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{cuerpo}",
        cuerpo.len()
    );
    asesor_falso(move |mut s| async move {
        s.write_all(resp.as_bytes()).await.unwrap();
    })
    .await
}

fn cliente(url: &str) -> AsesorClient {
    AsesorClient::new(url, Some(TOKEN.into())).unwrap()
}

async fn leer_json(resp: Response) -> (StatusCode, Value) {
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn siguiente(body: &mut Body) -> Option<String> {
    let frame = timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("el stream no avanza: ¿se está acumulando entero?")?
        .unwrap();
    Some(String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap())
}

// ---- Cliente ----

#[tokio::test]
async fn el_stream_llega_a_trozos_e_intacto_con_bearer_y_sesion() {
    let (soltar, esperar) = oneshot::channel::<()>();
    let (url, recibida) = asesor_falso(|mut s| async move {
        s.write_all(NDJSON.as_bytes()).await.unwrap();
        s.write_all(b"{\"type\":\"delta\",\"text\":\"Hola\"}\n")
            .await
            .unwrap();
        // La segunda línea no sale hasta que el test haya leído la primera.
        let _ = esperar.await;
        s.write_all(b"{\"type\":\"delta\",\"text\":\" mundo\"}\n{\"type\":\"done\"}\n")
            .await
            .unwrap();
    })
    .await;

    let sesion = Uuid::new_v4();
    let resp = cliente(&url)
        .stream(
            "/preguntas",
            &json!({"user_id": sesion, "question": "hola"}),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()[header::CONTENT_TYPE], "application/x-ndjson");
    assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(resp.headers()["x-accel-buffering"], "no");

    let mut body = resp.into_body();
    assert_eq!(
        siguiente(&mut body).await.unwrap(),
        "{\"type\":\"delta\",\"text\":\"Hola\"}\n"
    );
    soltar.send(()).unwrap();
    let mut resto = String::new();
    while let Some(trozo) = siguiente(&mut body).await {
        resto += &trozo;
    }
    assert_eq!(
        resto,
        "{\"type\":\"delta\",\"text\":\" mundo\"}\n{\"type\":\"done\"}\n"
    );

    let r = recibida.await.unwrap();
    assert_eq!(r.linea, "POST /preguntas HTTP/1.1");
    assert_eq!(r.cabeceras["authorization"], format!("Bearer {TOKEN}"));
    assert_eq!(r.cabeceras["content-type"], "application/json");
    assert_eq!(
        serde_json::from_str::<Value>(&r.cuerpo).unwrap()["user_id"],
        sesion.to_string()
    );
}

#[tokio::test]
async fn soltar_el_stream_cierra_la_conexion_con_el_asesor() {
    let (cerrada_tx, cerrada) = oneshot::channel::<()>();
    let (url, _) = asesor_falso(|mut s| async move {
        s.write_all(NDJSON.as_bytes()).await.unwrap();
        // Genera sin parar hasta que el otro lado cuelgue.
        while s
            .write_all(b"{\"type\":\"delta\",\"text\":\"x\"}\n")
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _ = cerrada_tx.send(());
    })
    .await;

    let resp = cliente(&url).stream("/analisis", &json!({})).await.unwrap();
    let mut body = resp.into_body();
    assert!(siguiente(&mut body).await.is_some());
    drop(body); // el navegador se fue

    timeout(Duration::from_secs(5), cerrada)
        .await
        .expect("el asesor sigue generando: la conexión quedó viva")
        .unwrap();
}

#[tokio::test]
async fn los_errores_del_asesor_se_reenvian_tal_cual() {
    let error = r#"{"error":{"code":"conflict","message":"Ya hay un análisis en curso"}}"#;
    let (url, _) = con_respuesta("409 Conflict", "application/json", error).await;
    let resp = cliente(&url).stream("/analisis", &json!({})).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let (_, cuerpo) = leer_json(resp).await;
    assert_eq!(cuerpo, serde_json::from_str::<Value>(error).unwrap());

    let (url, _) = con_respuesta(
        "404 Not Found",
        "application/json",
        r#"{"error":{"code":"not_found","message":"x"}}"#,
    )
    .await;
    let resp = cliente(&url)
        .call(
            Method::GET,
            "/analisis",
            Uuid::new_v4(),
            &[("month", "2026-10")],
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn lo_que_el_asesor_no_podria_haber_dicho_es_503() {
    // 401: token distinto entre servicios, no una sesión caducada.
    let (url, _) = con_respuesta(
        "401 Unauthorized",
        "application/json",
        r#"{"error":{"code":"unauthorized","message":"x"}}"#,
    )
    .await;
    // Cuerpo que no es JSON (p. ej. una página de error de otro proxy).
    let (url_html, _) = con_respuesta("502 Bad Gateway", "text/html", "<h1>Bad gateway</h1>").await;
    for u in [url, url_html] {
        let err = cliente(&u)
            .call(Method::GET, "/memorias", Uuid::new_v4(), &[])
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::AsesorUnavailable(_)), "{err:?}");
    }
}

#[tokio::test]
async fn asesor_caido_es_503_asesor_unavailable() {
    let puerto_libre = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap();
    let c = cliente(&format!("http://{puerto_libre}"));
    let err = c.stream("/analisis", &json!({})).await.unwrap_err();
    let (estado, cuerpo) = leer_json(err.into_response()).await;
    assert_eq!(estado, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(cuerpo["error"]["code"], "asesor_unavailable");
    assert!(
        cuerpo["error"]["message"]
            .as_str()
            .unwrap()
            .contains("asesor")
    );
}

#[tokio::test]
async fn sin_token_el_asesor_no_esta_configurado() {
    let c = AsesorClient::new("http://127.0.0.1:1", None).unwrap();
    let err = c
        .call(Method::GET, "/memorias", Uuid::new_v4(), &[])
        .await
        .unwrap_err();
    let (estado, cuerpo) = leer_json(err.into_response()).await;
    assert_eq!(estado, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(cuerpo["error"]["code"], "asesor_unavailable");
    assert_eq!(cuerpo["error"]["message"], "El asesor no está configurado");
}

#[test]
fn url_del_asesor_invalida_falla_al_crear_el_cliente() {
    assert!(AsesorClient::new("no es una url", None).is_err());
    assert!(AsesorClient::new("ftp://127.0.0.1:8090", None).is_err());
    assert!(AsesorClient::new("http://127.0.0.1:8090/", None).is_ok());
}

// ---- Rutas públicas: sesión, validación y user_id ----

fn app(asesor_url: &str) -> Router {
    // La BD no se toca en estos tests: la conexión perezosa nunca se abre.
    let db = PgPoolOptions::new()
        .connect_lazy("postgres://x:x@127.0.0.1:1/x")
        .unwrap();
    let config = Config {
        database_url: String::new(),
        bind_addr: String::new(),
        jwt_secret: SECRET.into(),
        session_hours: 1,
        cookie_secure: false,
        asesor_url: asesor_url.into(),
        asesor_token: Some(TOKEN.into()),
    };
    let state = AppState::new(db, config, cliente(asesor_url));
    Router::new()
        .nest("/api/asesor", routes())
        .layer(CookieManagerLayer::new())
        .with_state(state)
}

fn peticion(
    metodo: Method,
    uri: &str,
    sesion: Option<Uuid>,
    cuerpo: Option<Value>,
) -> Request<Body> {
    let mut req = Request::builder().method(metodo).uri(uri);
    if let Some(id) = sesion {
        let token = encode_token(id, SECRET.as_bytes(), 1).unwrap();
        req = req.header(header::COOKIE, format!("{COOKIE_NAME}={token}"));
    }
    match cuerpo {
        Some(v) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(v.to_string())),
        None => req.body(Body::empty()),
    }
    .unwrap()
}

#[tokio::test]
async fn sin_cookie_todas_las_rutas_dan_401() {
    let app = app("http://127.0.0.1:1");
    for (metodo, uri, cuerpo) in [
        (Method::GET, "/api/asesor/analisis", None),
        (
            Method::POST,
            "/api/asesor/analisis",
            Some(json!({"month": "2026-10"})),
        ),
        (
            Method::POST,
            "/api/asesor/preguntas",
            Some(json!({"question": "hola"})),
        ),
        (Method::GET, "/api/asesor/memorias", None),
        (
            Method::DELETE,
            &format!("/api/asesor/memorias/{}", Uuid::new_v4()),
            None,
        ),
    ] {
        let resp = app
            .clone()
            .oneshot(peticion(metodo, uri, None, cuerpo))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
}

#[tokio::test]
async fn el_user_id_es_el_de_la_sesion_aunque_el_cliente_mande_otro() {
    let sesion = Uuid::new_v4();
    let (url, recibida) = con_respuesta("200 OK", "application/json", "[]").await;
    let resp = app(&url)
        .oneshot(peticion(
            Method::GET,
            &format!("/api/asesor/memorias?user_id={}", Uuid::new_v4()),
            Some(sesion),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let r = recibida.await.unwrap();
    assert_eq!(r.linea, format!("GET /memorias?user_id={sesion} HTTP/1.1"));
    assert_eq!(r.cabeceras["authorization"], format!("Bearer {TOKEN}"));
}

#[tokio::test]
async fn borrar_una_memoria_reenvia_el_204_con_la_sesion() {
    let (sesion, id) = (Uuid::new_v4(), Uuid::new_v4());
    let (url, recibida) = con_respuesta("204 No Content", "application/json", "").await;
    let uri = format!("/api/asesor/memorias/{id}?user_id={}", Uuid::new_v4());
    let resp = app(&url)
        .oneshot(peticion(Method::DELETE, &uri, Some(sesion), None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        recibida.await.unwrap().linea,
        format!("DELETE /memorias/{id}?user_id={sesion} HTTP/1.1")
    );
}

#[tokio::test]
async fn analisis_get_normaliza_el_mes_y_lo_valida() {
    let sesion = Uuid::new_v4();
    let (url, recibida) = con_respuesta(
        "404 Not Found",
        "application/json",
        r#"{"error":{"code":"not_found","message":"No hay análisis"}}"#,
    )
    .await;
    let resp = app(&url)
        .oneshot(peticion(
            Method::GET,
            "/api/asesor/analisis?month=2026-09",
            Some(sesion),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let linea = recibida.await.unwrap().linea;
    assert_eq!(
        linea,
        format!("GET /analisis?user_id={sesion}&month=2026-09 HTTP/1.1")
    );

    let resp = app("http://127.0.0.1:1")
        .oneshot(peticion(
            Method::GET,
            "/api/asesor/analisis?month=2026-13",
            Some(sesion),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn las_peticiones_invalidas_se_rechazan_antes_de_tocar_nada() {
    let sesion = Uuid::new_v4();
    let casos = [
        ("/api/asesor/preguntas", json!({"question": "   "})),
        (
            "/api/asesor/preguntas",
            json!({"question": "a".repeat(1001)}),
        ),
        (
            "/api/asesor/preguntas",
            json!({"question": "hola", "month": "2026-00"}),
        ),
        ("/api/asesor/analisis", json!({"month": "basura"})),
        ("/api/asesor/analisis", json!({})),
    ];
    for (uri, cuerpo) in casos {
        let resp = app("http://127.0.0.1:1")
            .oneshot(peticion(
                Method::POST,
                uri,
                Some(sesion),
                Some(cuerpo.clone()),
            ))
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{uri} {cuerpo}"
        );
    }
}
