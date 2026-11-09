# Asesor financiero con LLM local

Analiza tus finanzas cada mes, responde preguntas sobre tus datos y recuerda lo que te aconsejó
para comprobar después si te funcionó. Todo corre en local: ningún dato sale de la máquina.

Pensado para hardware modesto (≤ 8 GB de RAM, CPU sin GPU o Raspberry Pi 5): un modelo de 4B o
menos cuantizado a 4 bits, una sola generación a la vez y análisis guardados en vez de recalculados.

## Arquitectura

```
navegador ──cookie──▶ backend Rust (:8080, /api/asesor/*) ──▶ Postgres de finanzas (:5433, sin cambios)
                          │  calcula los datos exactos (resumen, informe, evolución)
                          │  y pone el user_id de la sesión
                          ▼  Authorization: Bearer ASESOR_TOKEN
                      asesor: Node + LangChain.js (127.0.0.1:8090)
                          │  RAG sobre la memoria + prompt + streaming
                          ├──▶ Ollama (127.0.0.1:11434): chat + embeddings
                          └──▶ Postgres del asesor con pgvector (:5435, BD propia)
```

Son dos instancias de Postgres que conviven: la de finanzas sigue igual (`postgres:18-alpine`) y la
del asesor (`pgvector/pgvector:pg18`) solo guarda su memoria. El asesor no tiene acceso a la BD de
finanzas: todo lo que sabe de tu dinero se lo pasa Rust en cada petición.

Reglas que no se negocian:

- **Los números los calcula Rust, nunca el modelo.** El asesor recibe las cifras ya calculadas y
  solo las explica y aconseja. El prompt le prohíbe usar cifras que no estén en los datos.
- **El asesor no se expone.** Escucha solo en `127.0.0.1`, exige `ASESOR_TOKEN` en cada petición
  y no confía en nada del cliente: el `user_id` lo pone Rust a partir de la sesión.
- **El modelo no tiene herramientas que escriban.** Solo lee los datos que se le pasan. Las
  descripciones de los movimientos son texto no fiable (con la conexión bancaria vendrán de
  terceros): van delimitadas como datos y el prompt ordena ignorar instrucciones dentro.
- **Una generación a la vez.** Si ya hay una en curso, `409 conflict`. Si el cliente corta la
  conexión, la generación se aborta en Ollama y no se guarda nada.

## API pública (backend Rust, sesión por cookie)

Errores con el formato habitual de `docs/API.md`. Código nuevo: `asesor_unavailable` (503) cuando
el asesor u Ollama no responden.

| Método | Ruta | Cuerpo / parámetros | Respuesta |
|---|---|---|---|
| GET | `/api/asesor/analisis` | `?month=YYYY-MM` (def. mes actual) | `200 Analisis` · `404 not_found` si aún no hay |
| POST | `/api/asesor/analisis` | `{"month": "YYYY-MM"}` | `200` stream NDJSON; al terminar reemplaza el análisis guardado de ese mes |
| POST | `/api/asesor/preguntas` | `{"question": string, "month"?: "YYYY-MM"}` | `200` stream NDJSON |
| GET | `/api/asesor/memorias` | — | `200 [Memoria]`, la más reciente primero (máx. 200) |
| DELETE | `/api/asesor/memorias/{id}` | — | `204` · `404` |

```jsonc
Analisis { "month": "2026-10", "content": string, "model": string, "created_at": rfc3339 }
Memoria  { "id": uuid, "tipo": "analisis" | "conversacion", "month": "YYYY-MM" | null,
           "content": string, "created_at": rfc3339 }
```

Validación en Rust: `month` con formato `YYYY-MM` y entre 2000-01 y 2100-12 (el rango de los
informes); `question` recortada, de 1 a 1000 caracteres. En `POST /analisis` el `month` es
obligatorio; en `/preguntas`, por defecto es el mes actual.

### Stream NDJSON

`Content-Type: application/x-ndjson`, una línea JSON por evento:

```jsonc
{"type": "delta", "text": "fragmento de texto"}
{"type": "done", "analisis": Analisis}             // en /analisis
{"type": "done"}                                   // en /preguntas
{"type": "error", "message": "texto en español"}   // si falla a mitad; cierra el stream
```

Los errores antes de empezar a generar (validación, 409, 503) son respuestas JSON normales, no stream.
Lo que se guarda (y llega en `done.analisis`, `GET /analisis` y `/memorias`) puede diferir de los
`delta` emitidos: antes de guardar se sustituyen por `[dato omitido]` IBAN, URL, correos, teléfonos
y direcciones cripto.
Si el asesor muere a mitad o pasan 10 min sin datos, el backend corta la conexión sin enviar una
línea `error` (podría quedar pegada a una línea a medias): **un stream que termina sin `done` ni
`error` es un fallo** y el cliente debe tratarlo como tal.

## Contrato interno Rust → asesor

Todas las peticiones llevan `Authorization: Bearer <ASESOR_TOKEN>` (comparación en tiempo
constante; sin él, `401`). Mismo formato de error y de stream que la API pública. El backend
reenvía el stream tal cual, y el status y el cuerpo de los errores también, salvo un `401` (solo
puede ser un `ASESOR_TOKEN` distinto en cada lado) o una respuesta que no sea JSON: esos se
convierten en `503 asesor_unavailable`, para no confundirlos con una sesión caducada.

| Método | Ruta | Cuerpo / parámetros |
|---|---|---|
| POST | `/analisis` | `{"user_id": uuid, "month": "YYYY-MM", "facts": Facts}` |
| GET | `/analisis` | `?user_id=&month=` |
| POST | `/preguntas` | `{"user_id": uuid, "question": string, "facts": Facts}` |
| GET | `/memorias` | `?user_id=` |
| DELETE | `/memorias/{id}` | `?user_id=` |
| GET | `/salud` | `200 {"ollama": bool, "modelo": bool, "db": bool}` |

El asesor vuelve a validar lo que recibe (uuid, month, longitud de la pregunta, tamaño del cuerpo
≤ 256 KB): es una frontera de confianza aunque solo hable con Rust.

### Facts (los calcula Rust)

```jsonc
{
  "month": "2026-10",
  "today": "2026-10-31",
  "month_in_progress": true,          // el ahorro de un mes en curso todavía bajará
  "summary": SummaryResponse,         // lo mismo que GET /api/summary?month=<month>
  "previous_summary": SummaryResponse, // ídem del mes anterior (enero → diciembre del año anterior)
  "report": ReportResponse,           // lo mismo que GET /api/reports?period=month&date=<month>-01
  "trend": TrendResponse              // 6 meses que TERMINAN en <month>
}
```

Todo el dinero va en céntimos, como en el resto de la API. El asesor compacta estos datos antes
de meterlos en el prompt (sin la serie diaria, categorías y movimientos recortados) para que
quepan en `ASESOR_NUM_CTX`.

`previous_summary` es opcional para el asesor (si falta, no hay sección de comparación) y su
`month` debe ser el anterior a `month`, o se rechaza con `422`. Con él, el asesor añade al final de
los datos del prompt la sección «Comparación con el mes anterior»: por cubo, el importe y el % de
ingresos de cada mes, la diferencia en € y en puntos y si este mes está dentro del tope (o por
encima del mínimo); el gasto sin categoría de los dos meses (aunque sea 0); y las 5 categorías de
gasto mayores de cualquiera de los dos meses. Toda esa aritmética y esos veredictos se calculan en
código (céntimos enteros; el % es el `actual_pct` de Rust, para que coincida con el reparto 50/30/20):
el modelo de 4B se equivocaba al deducirlos, o los sacaba de la memoria de otro mes. Casos
especiales: sin ingresos este mes no hay veredicto (el objetivo sería 0 €); en un mes en curso la
cabecera avisa de que sus importes son parciales y no hay veredicto de ahorro (los topes dicen «por
ahora»); si el mes anterior no tiene movimientos, la sección es una línea que lo dice. Si los datos
no caben en 6000 caracteres, lo primero que se recorta es esta sección: el bloque de cabecera,
gasto sin categoría y cubos entra entero o no entra, las categorías van línea a línea, y si falta
algo se añade una nota de recorte.

La sección tiene un coste: unos 1.100 caracteres más de datos en un mes con mes anterior (de 1.978 a
3.109 en las pruebas, un 32 % más de prompt). Además, con cambios a la vista el modelo leía
«¿en qué categoría gasté más?» como «¿dónde subió más?»; por eso `tareaPregunta` le indica que
ignore la sección si la pregunta no compara meses.

## Memoria (pgvector, BD propia del asesor)

El esquema es del asesor: lo aplica él al arrancar desde `asesor/schema.sql`, de forma idempotente.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS memorias (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL,   -- sin FK: los usuarios viven en la otra BD
    tipo       TEXT        NOT NULL CHECK (tipo IN ('analisis', 'conversacion')),
    month      TEXT                 CHECK (month ~ '^\d{4}-\d{2}$'),
    content    TEXT        NOT NULL CHECK (length(content) <= 8000),
    metadata   JSONB       NOT NULL DEFAULT '{}',
    embedding  vector(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Un único análisis por usuario y mes: regenerarlo reemplaza el anterior.
CREATE UNIQUE INDEX IF NOT EXISTS memorias_analisis_mes
    ON memorias (user_id, month) WHERE tipo = 'analisis';
```

768 dimensiones: las de `embeddinggemma`. Sin índice vectorial: con cientos de filas, el recorrido
secuencial es más rápido que mantener un HNSW.

Cómo aprende:

- **Cada análisis y cada conversación se guardan** con su embedding.
- **Al analizar un mes**, el prompt incluye el análisis del mes anterior (por `month`, no por
  similitud) y las 3 memorias más parecidas. El modelo debe decir si los consejos anteriores se
  siguieron, contrastándolos con la sección de comparación con el mes anterior (las cifras de la
  memoria son de otros meses y no se atribuyen al actual).
- **Al responder una pregunta**, se recuperan las 4 memorias más parecidas a la pregunta.
- Todo recuerdo lleva su fecha en el prompt, y se avisa al modelo de que lo antiguo puede estar
  desactualizado. El usuario puede ver y borrar cualquier recuerdo.

## Configuración

| Variable | Quién | Defecto | Notas |
|---|---|---|---|
| `ASESOR_URL` | Rust | `http://127.0.0.1:8090` | |
| `ASESOR_TOKEN` | Rust y asesor | — | ≥ 32 caracteres; `openssl rand -base64 48`. Obligatoria en el asesor; en Rust, si falta, la app funciona sin asesor (`503`) |
| `ASESOR_PORT` | asesor | `8090` | siempre en `127.0.0.1` |
| `ASESOR_DATABASE_URL` | asesor | — (obligatoria) | en desarrollo `postgres://asesor:asesor_dev@127.0.0.1:5435/asesor` (`./scripts/db.sh asesor install`) |
| `OLLAMA_URL` | asesor | `http://127.0.0.1:11434` | Ollama nunca debe escuchar fuera de localhost |
| `ASESOR_MODEL` | asesor | `qwen3.5:4b` | provisional hasta medir en CPU |
| `ASESOR_EMBED_MODEL` | asesor | `embeddinggemma:300m-qat-q8_0` | 768 dimensiones |
| `ASESOR_NUM_CTX` | asesor | `5120` | la ventana de contexto pesa en RAM: con `qwen3.5:4b`, 5120 ocupa unos 100 MiB más que 4096 (3.043 frente a 2.941 MiB). Se subió para que, con la sección de comparación, sigan entrando la memoria del mes anterior y las parecidas |
| `ASESOR_KEEP_ALIVE` | asesor | `5m` | cuánto tiempo sigue cargado el modelo en memoria tras usarlo |

## Rendimiento y despliegue

Medido con `qwen3.5:4b` (2.150 tokens de prompt, unos 550 de salida):

| Dónde | Hasta el primer token | Análisis completo |
|---|---|---|
| GPU dedicada de gama media | 0,2–3,6 s | 8–13 s |
| CPU moderna limitada a 4 hilos | unos 47 s | unos 90 s |
| i5 / Ryzen 5 antiguo o Raspberry Pi 5 | estimado: 2–3 min | estimado: 3–5 min (sin medir) |

Memoria: el modelo ocupa unos 3,3 GB mientras está cargado (`ASESOR_KEEP_ALIVE` decide cuánto
tiempo sigue cargado tras usarlo) y el servicio Node, entre 120 y 175 MB. La BD del asesor, con los
buffers al mínimo, suma unos 100 MB más a la de finanzas.

Al desplegar:

- **Ollama solo en localhost** (`OLLAMA_HOST=127.0.0.1`): su API no tiene autenticación.
- **Timeouts del proxy inverso.** El asesor no envía cabeceras hasta el primer token, que en CPU
  tarda minutos. Para `/api/asesor/` hay que subir la espera de lectura del proxy a 10 minutos o
  más y desactivar el buffering: nginx corta a los 60 s por defecto (`proxy_read_timeout`). El
  backend ya manda `X-Accel-Buffering: no`.
- **Node ≥ 24.2.** El asesor ejecuta TypeScript directamente, sin compilar.
- Las contraseñas de las dos BD de `deploy/` y `compose.yaml` son de desarrollo. Antes de exponer
  nada: contraseñas aleatorias (podman secret o un `EnvironmentFile` con permisos 600),
  `chmod 600 .env`, y para el asesor un rol sin superusuario (la extensión `vector` se crea una vez
  como administrador).
- **Servicio del asesor en producción:** una unidad systemd con usuario propio, `NoNewPrivileges`,
  `ProtectSystem=strict` e `IPAddressAllow=localhost`, para que ni por error salga nada a la red.
- **Nada sale de la máquina.** `ASESOR_URL` por http y `OLLAMA_URL` solo aceptan hosts de loopback
  (para otro host, https), y el asesor se niega a arrancar si está activada la telemetría de
  LangSmith (`LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2`…), que enviaría los prompts a la nube.

Límites conocidos del modelo de 4B, observados en pruebas: interpreta mal algunas cifras correctas,
por ejemplo atribuyendo al mes actual un dato que viene de la memoria de otro mes, o confundiendo
"% del gasto" con "% de los ingresos". La sección de comparación con el mes anterior reduce el
primer fallo, pero no lo elimina (ni el de decir que el mes está en curso cuando está cerrado). En un
mes en curso sigue presentando como «ahorro de gasto» la comparación de totales parciales con los del
mes anterior completo, aunque el prompt se lo desaconseje. Las
cifras que recibe son exactas, pero sus conclusiones hay que leerlas como las de un asistente, no
como las de un informe.
