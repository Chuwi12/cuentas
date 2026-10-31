# Conexión con Trade Republic (análisis, fase 2)

Estado a 2026-10-31. Solo vías oficiales o reguladas: las APIs privadas obtenidas por ingeniería
inversa de la app (pytr, el WebSocket interno) quedan descartadas. Las condiciones de Trade
Republic prohíben el acceso por canales que no proporciona (Kundenvereinbarung III.1.3, con
posible resolución del contrato), y además obligan a guardar las credenciales del bróker en el
servidor.

## Qué existe

| Vía | Coste | Datos | Problemas |
|---|---|---|---|
| **CSV oficial "Transaktionsexport"** (app ≥ 4.2616, desde abril de 2026: Perfil → Kontoauszüge) | 0 € | Fecha ISO, tipo y subtipo, descripción, importe, divisa, referencia; también valores, dividendos e intereses | Manual y solo desde el móvil. Columnas sin documentar, que pueden cambiar entre versiones |
| **PSD2 de TR a través de Enable Banking** ("restricted production", gratis para uso personal con cuentas propias) | 0 € | Solo cuenta de efectivo: fecha, importe y signo | Sin contraparte, concepto ni ID de transacción; paginación que repite páginas; consentimiento de 90 días; soporte de TR reciente y poco maduro |
| PSD2 directo con la API de TR (guía TPP v2.1, julio de 2026) | — | Igual que la anterior | Exige certificado eIDAS QSeal y registro AISP en la BaFin: inviable para un particular |
| GoCardless, Tink, finAPI, Yapily, Plaid, Powens, Salt Edge | — | — | Cerrados a altas nuevas, solo empresas, de pago (finAPI: 200 €/mes) o sin soporte de TR confirmado |

PSD2 no cubre la cartera de valores, los planes de ahorro ni los dividendos. Además, los
movimientos llegan sin descripción, así que no se pueden categorizar.

## Recomendación

1. **Primero, importar el CSV oficial.** Es la fuente con más datos y no depende de terceros:
   - endpoint de subida con previsualización antes de confirmar;
   - importación idempotente por la referencia de TR;
   - categorización sugerida por las reglas aprendidas y por similitud con la memoria del asesor.
   Hace falta un CSV real exportado por el usuario para fijar el parser: las columnas no están
   documentadas.
2. **Después, si compensa, sincronizar con Enable Banking** para que el efectivo entre solo
   (1–2 consultas al día):
   - deduplicar por (fecha, importe, orden en el día) y cuadrar contra el saldo, porque no hay ID
     estable;
   - cortar la paginación si una página se repite;
   - avisar de renovar el consentimiento a los 80 días;
   - la clave RSA de la aplicación de Enable Banking va fuera del repo, con permisos 600;
   - el CSV mensual sigue siendo necesario para la descripción y las inversiones.

Uso personal: leer tus propias cuentas a través de un agregador con licencia no parece requerir
registro AISP (§34 ZAG habla de prestación comercial; es una inferencia, no un criterio de la
BaFin). Los términos de Enable Banking excluyen el uso profesional: si la app se ofreciera a
terceros, haría falta contrato con ellos y probablemente licencia.

## Fuentes principales

- Guía TPP de Trade Republic: https://assets.traderepublic.com/assets/files/TPP_API_Guide_v2.pdf
- Condiciones para consumidores (9/2026): https://assets.traderepublic.com/assets/files/CA_DE-de.pdf
- Exportación CSV: https://acutic.io/blog/trade-republic-csv-export
- Enable Banking, términos y FAQ: https://enablebanking.com/terms/ · https://enablebanking.com/docs/faq
- Calidad de los datos PSD2 de TR: https://github.com/2manyvcos/enable-actual/issues/33 ·
  https://github.com/actualbudget/actual/issues/8846 · https://github.com/securo-finance/securo/issues/1049
- Proveedores en Firefly III: https://docs.firefly-iii.org/how-to/data-importer/import/third-party-providers/
- GoCardless sin altas: https://bankaccountdata.gocardless.com/new-signups-disabled
- ZAG §34: https://www.gesetze-im-internet.de/zag_2018/__34.html
