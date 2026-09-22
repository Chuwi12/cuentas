//! Límite de intentos simple para `/login` y `/register`.
//!
//! `main.rs` no monta el servicio con `into_make_service_with_connect_info`
//! (no lo puedo tocar), así que no hay IP disponible en los extractores.
//! En su lugar se limita GLOBALMENTE por email: máximo [`MAX_ATTEMPTS`]
//! intentos fallidos en una ventana de [`WINDOW`] por cada clave
//! `"login:<email>"` / `"register:<email>"`.
//!
//! Es deliberadamente simple (un `Mutex<HashMap>` en memoria, se pierde al
//! reiniciar el proceso). Para una app de un solo usuario es suficiente
//! como freno a fuerza bruta; no pretende ser un rate limiter de producción
//! multi-instancia.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const MAX_ATTEMPTS: usize = 10;
const WINDOW: Duration = Duration::from_secs(15 * 60);

static ATTEMPTS: LazyLock<Mutex<HashMap<String, Vec<Instant>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Descarta los intentos fuera de la ventana. Se asume el lock ya tomado.
fn prune(entry: &mut Vec<Instant>, now: Instant) {
    entry.retain(|t| now.duration_since(*t) < WINDOW);
}

/// `true` si `key` todavía tiene intentos disponibles.
pub fn is_allowed(key: &str) -> bool {
    let mut map = ATTEMPTS.lock().expect("el mutex de rate_limit está envenenado");
    let now = Instant::now();
    match map.get_mut(key) {
        Some(entry) => {
            prune(entry, now);
            let allowed = entry.len() < MAX_ATTEMPTS;
            if entry.is_empty() {
                map.remove(key);
            }
            allowed
        }
        None => true,
    }
}

/// Registra un intento fallido para `key`.
pub fn record_failure(key: &str) {
    let mut map = ATTEMPTS.lock().expect("el mutex de rate_limit está envenenado");
    let now = Instant::now();
    let entry = map.entry(key.to_string()).or_default();
    prune(entry, now);
    entry.push(now);
}

/// Limpia los intentos de `key` (se llama tras un login/registro exitoso).
pub fn clear(key: &str) {
    let mut map = ATTEMPTS.lock().expect("el mutex de rate_limit está envenenado");
    map.remove(key);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Claves únicas por test: el estado es un `static` compartido entre
    // tests que corren en paralelo.
    #[test]
    fn allows_up_to_max_attempts_then_blocks() {
        let key = "test:allows_up_to_max_attempts_then_blocks";
        for _ in 0..MAX_ATTEMPTS {
            assert!(is_allowed(key));
            record_failure(key);
        }
        assert!(!is_allowed(key));
        clear(key);
        assert!(is_allowed(key));
    }

    #[test]
    fn unknown_key_is_allowed() {
        assert!(is_allowed("test:unknown_key_is_allowed"));
    }
}
