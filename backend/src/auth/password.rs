//! Validación de email/contraseña y hashing Argon2id.
//!
//! Ojo con la API de `argon2` 0.6 (cambió respecto a 0.5): `hash_password`
//! genera la sal aleatoriamente él solo (no se le pasa `SaltString`), y
//! `Argon2` implementa `PasswordVerifier<str>`, así que se puede verificar
//! directamente contra el PHC string guardado sin parsearlo antes.

use crate::error::AppError;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use std::sync::LazyLock;

pub const MIN_PASSWORD_LEN: usize = 12;
pub const MAX_PASSWORD_LEN: usize = 256;

/// Hash Argon2id ficticio, precalculado una sola vez. Se usa en `/login`
/// cuando el email no existe, para que el tiempo de respuesta sea el mismo
/// que si el email existiera pero la contraseña fuera incorrecta (evita que
/// un atacante distinga "usuario no existe" de "contraseña incorrecta" por
/// temporización).
pub static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    hash_password("contraseña-de-relleno-para-igualar-tiempos-de-respuesta")
        .expect("el hash ficticio debe poder generarse")
});

/// Calcula el hash Argon2id de una contraseña. CPU-bound: llamar siempre
/// desde `tokio::task::spawn_blocking`.
pub fn hash_password(password: &str) -> Result<String, AppError> {
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes())
        .map_err(|e| AppError::Internal(format!("no se pudo generar el hash de contraseña: {e}")))?;
    Ok(hash.to_string())
}

/// Verifica una contraseña contra un hash PHC almacenado. CPU-bound: llamar
/// siempre desde `tokio::task::spawn_blocking`. Cualquier fallo (hash
/// corrupto, contraseña incorrecta, algoritmo no soportado) se trata como
/// "no coincide", nunca como error de sistema: quien llama no debe poder
/// distinguir esos casos.
pub fn verify_password(password: &str, hash: &str) -> bool {
    Argon2::default()
        .verify_password(password.as_bytes(), hash)
        .is_ok()
}

/// Normaliza (trim + minúsculas) y valida el formato básico de un email.
/// No pretende ser RFC 5322 completo: solo descarta entradas claramente
/// inválidas antes de tocar la base de datos.
pub fn normalize_email(raw: &str) -> Result<String, AppError> {
    let email = raw.trim().to_lowercase();

    if email.is_empty() || email.len() > 254 {
        return Err(AppError::Validation("El email no es válido.".into()));
    }
    if email.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::Validation("El email no es válido.".into()));
    }

    let mut parts = email.split('@');
    let (local, domain) = match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => (local, domain),
        _ => return Err(AppError::Validation("El email no es válido.".into())),
    };

    if local.is_empty() || domain.is_empty() {
        return Err(AppError::Validation("El email no es válido.".into()));
    }
    if !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return Err(AppError::Validation("El email no es válido.".into()));
    }
    if domain.starts_with('-') || domain.ends_with('-') {
        return Err(AppError::Validation("El email no es válido.".into()));
    }

    Ok(email)
}

/// Valida la longitud de la contraseña (el contrato exige mínimo 12; se pone
/// un tope de 256 para no dejar que alguien mande megabytes al hasher).
pub fn validate_password(password: &str) -> Result<(), AppError> {
    let len = password.chars().count();
    if len < MIN_PASSWORD_LEN || len > MAX_PASSWORD_LEN {
        return Err(AppError::Validation(format!(
            "La contraseña debe tener entre {MIN_PASSWORD_LEN} y {MAX_PASSWORD_LEN} caracteres."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_email_trims_and_lowercases() {
        assert_eq!(
            normalize_email("  Foo.Bar@Example.COM  ").unwrap(),
            "foo.bar@example.com"
        );
    }

    #[test]
    fn normalize_email_rejects_missing_at() {
        assert!(normalize_email("no-es-un-email").is_err());
    }

    #[test]
    fn normalize_email_rejects_multiple_at() {
        assert!(normalize_email("a@b@c.com").is_err());
    }

    #[test]
    fn normalize_email_rejects_empty_local_or_domain() {
        assert!(normalize_email("@example.com").is_err());
        assert!(normalize_email("foo@").is_err());
    }

    #[test]
    fn normalize_email_rejects_domain_without_dot() {
        assert!(normalize_email("foo@localhost").is_err());
    }

    #[test]
    fn normalize_email_rejects_whitespace_inside() {
        assert!(normalize_email("foo bar@example.com").is_err());
    }

    #[test]
    fn normalize_email_rejects_empty() {
        assert!(normalize_email("   ").is_err());
    }

    #[test]
    fn validate_password_rejects_short() {
        assert!(validate_password("corta1234567").is_ok()); // 12 chars, válida
        assert!(validate_password("corta12345").is_err()); // 10 chars, inválida
    }

    #[test]
    fn validate_password_rejects_too_long() {
        let too_long = "a".repeat(257);
        assert!(validate_password(&too_long).is_err());
    }

    #[test]
    fn validate_password_accepts_boundary_lengths() {
        assert!(validate_password(&"a".repeat(12)).is_ok());
        assert!(validate_password(&"a".repeat(256)).is_ok());
        assert!(validate_password(&"a".repeat(11)).is_err());
        assert!(validate_password(&"a".repeat(257)).is_err());
    }

    #[test]
    fn hash_and_verify_roundtrip() {
        let hash = hash_password("contraseña-de-prueba-123").unwrap();
        assert!(verify_password("contraseña-de-prueba-123", &hash));
        assert!(!verify_password("otra-contraseña-distinta", &hash));
    }

    #[test]
    fn hash_is_not_plaintext_and_is_argon2id() {
        let hash = hash_password("contraseña-de-prueba-123").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert_ne!(hash, "contraseña-de-prueba-123");
    }

    #[test]
    fn dummy_hash_verifies_like_a_normal_hash_but_never_matches_real_passwords() {
        assert!(!verify_password("cualquier-cosa", &DUMMY_HASH));
    }
}
