# Cuentas

Finanzas personales con la **regla 50/30/20**, para instalar en tu propio equipo. Apuntas o importas
lo que entra y lo que sale, y la app calcula cómo se reparte tu dinero entre **necesidades (50 %)**,
**deseos (30 %)** y **ahorro (20 %)**, y te avisa cuando una parte se pasa de su objetivo. Si quieres,
un LLM local analiza cada mes y responde preguntas sobre tus datos.

[Contrato de la API](docs/API.md) · [Asesor](docs/ASESOR.md) · [Conexión con el banco](docs/BANCO.md)

![Resumen del mes: reparto 50/30/20, detalle por cubo y evolución](docs/capturas/resumen.png)

<sub>Todas las capturas usan una cuenta y unos datos de demostración ficticios.</sub>

## Qué hace

- **Reparto del mes.** Tus ingresos se dibujan como una barra dividida con las marcas del objetivo
  50/30/20, y encima lo que realmente destinaste a cada parte. Si una parte se pasa, el exceso sale
  rayado y con una anotación a mano en rojo, como una corrección en una libreta.
- **Detalle por cubo.** Cuánto llevas frente a lo previsto, cuánto te queda o cuánto te has pasado, y
  en qué categorías se va el dinero.
- **Evolución.** Los últimos meses en barras apiladas, con la línea de ingresos encima.
- **Movimientos.** Alta rápida (escribes `12,50`, eliges una categoría y pulsas Enter), filtros por
  mes, tipo, cubo, categoría y texto, y una lista agrupada por días con subtotales.
- **Importar desde el banco.** Subes el CSV de tu banco, eliges qué columna es cada dato y revisas los
  movimientos antes de confirmar. Reimportar un extracto que se solapa con otro no duplica nada, y la
  categoría se sugiere a partir de cómo categorizaste antes los movimientos con la misma descripción.
- **Informes.** Por semana, mes o año, con comparación con el periodo anterior, cubos frente a su
  objetivo, desglose por categoría, mayores movimientos y avisos automáticos. Se exportan a PDF y CSV.
- **Categorías editables.** Vienen de serie alquiler, comida, suministros, transporte, gym, ropa, ocio
  e inversión, además de nómina y extras como ingresos. Puedes cambiar el cubo de cualquiera en el
  sitio (¿el gym es una necesidad o un deseo? lo decides tú), crear nuevas con su icono y color, y
  archivar o borrar.
- **Asesor con IA local (opcional).** Analiza cada mes, responde preguntas y recuerda sus consejos para
  comprobar después si funcionaron.
- **Un solo usuario.** La primera cuenta que se registra es la única; después, el registro se cierra.
- **Adaptada a móvil.** Barra de navegación inferior, alta de movimientos a un toque y filtros plegables.

| Informes | Importar desde el banco | Asesor |
|---|---|---|
| ![Informe mensual con indicadores, evolución por día, gastos por categoría y reparto por cubos](docs/capturas/informes.png) | ![Revisión de una importación con categorías sugeridas y una fila con error](docs/capturas/importar.png) | ![Análisis mensual generado por el modelo local](docs/capturas/asesor.png) |

| Movimientos | Añadir un movimiento | Categorías |
|---|---|---|
| ![Lista de movimientos](docs/capturas/movimientos.png) | ![Diálogo de alta](docs/capturas/nuevo-movimiento.png) | ![Categorías por cubo](docs/capturas/categorias.png) |

| Acceso | Móvil: resumen | Móvil: movimientos |
|---|---|---|
| ![Pantalla de acceso](docs/capturas/acceso.png) | ![Resumen en móvil](docs/capturas/movil-resumen.png) | ![Movimientos en móvil](docs/capturas/movil-movimientos.png) |

<sub>El análisis del asesor es la salida real del modelo de 4B, sin retocar, y se ven sus límites: dice que la
inversión bajó cuando fue la misma que el mes anterior.</sub>

## Cómo se calcula el 50/30/20

- La base son los **ingresos del mes**. Los tres objetivos se calculan en céntimos enteros y suman
  exactamente el ingreso: si ingresas 10,01 €, los objetivos son 5,00 € + 3,00 € + 2,01 €.
- Cada gasto va al cubo de su categoría.
- **El ahorro incluye lo que no gastas**:
  `ahorro = gastos en categorías de ahorro (inversión…) + max(0, ingresos − todos los gastos)`.
  Si solo contara lo que apuntas como inversión, alguien que ahorra sin registrarlo aparecería con un
  0 % de ahorro, y eso sería falso. En el mes en curso la app avisa de que esta cifra irá bajando
  hasta fin de mes.
- Los gastos sin categoría no cuentan en ningún cubo, pero sí reducen el ahorro.
- Resumen e informes usan la misma fórmula (`summary::calc::savings_cents`), así que dan la misma cifra
  para el mismo mes, y muestran aparte la parte no gastada.

## Importar extractos del banco

Cada banco exporta un CSV distinto: cambian las columnas, el formato de las fechas, el separador decimal y
cómo se marca un cargo. La importación no depende de un formato concreto:

- **Cuatro pasos.** Fichero, columnas, revisión y resultado. El fichero se lee como UTF-8 y, si no lo es,
  como windows-1252, la codificación habitual de muchos bancos españoles. El servidor detecta el separador
  y muestra una muestra de filas para elegir qué columna es la fecha, el importe, la descripción y, si hay,
  la referencia. Ese mapeo se recuerda en el navegador para los ficheros con las mismas cabeceras, sin
  guardar ningún movimiento. Al confirmar, todo se inserta en una sola transacción.
- **Sin duplicados al reimportar.** Cada movimiento importado guarda una huella (`import_ref`) de fecha,
  importe, tipo y referencia del banco (o, si no hay, la descripción normalizada), más su número de
  aparición en el fichero. Si importas tres meses cuando ya tenías los dos primeros, solo entran los nuevos,
  y dos cafés idénticos el mismo día siguen siendo dos. La referencia sola no basta: la de un recibo
  domiciliado se repite cada mes.
- **Fechas ambiguas.** `03/04/2026` puede ser 3 de abril o 4 de marzo. Si las dos lecturas valen para todo el
  fichero, la app solo decide por día/mes (su formato) y solo cuando esa lectura abarca menos de la mitad de
  tiempo que la otra: un extracto es un periodo seguido. En cualquier otro caso responde `422 ambiguous_date` y te pide
  que elijas el formato en vez de guardar fechas equivocadas.
- **Importes de cualquier banco.** Coma o punto decimal, miles con punto o con espacio, y un solo signo
  delante (`-12,50`), detrás (`12,50-`) o como paréntesis contables (`(12,50)`). El importe va en una sola
  columna con signo, que se puede invertir para los bancos que exportan los cargos en positivo. Se admite
  un símbolo o código de moneda junto a la cifra (`€`, `$`, `£`, `EUR`, `USD`, `GBP`), pero no se convierte:
  la app trabaja con una sola moneda.
- **Categoría sugerida.** La más usada en tus movimientos anteriores del mismo tipo con la misma descripción
  normalizada (minúsculas, sin cifras ni espacios repetidos). Lo que categorizas hoy mejora las sugerencias
  de mañana.
- **Filas con error a la vista.** Una fila que no se puede leer, como el «Saldo final» de muchos extractos,
  se marca con su motivo y no se importa, sin bloquear el resto.
- **Ficheros hostiles.** Como máximo 2 MB y 5.000 filas, con conteo previo de separadores, un fichero a la
  vez y fuera del runtime async (`spawn_blocking`): un CSV malicioso no dispara la memoria ni bloquea el
  servidor. Las descripciones pierden los caracteres de control e invisibles de formato.

## Asesor con IA local

**El código calcula y el modelo explica.** Rust obtiene las cifras exactas (resumen, informe, evolución)
y se las pasa al modelo, al que el prompt prohíbe usar cifras que no estén en esos datos.

- **Memoria con RAG.** Cada análisis y cada conversación se guardan con su embedding en pgvector. Al
  analizar un mes, el prompt incluye el análisis del mes anterior y las memorias más parecidas, y el
  modelo debe decir si seguiste sus consejos. Puedes ver y borrar cualquier recuerdo.
- **Aislado.** El servicio escucha solo en `127.0.0.1` con un token propio, no tiene acceso a la BD de
  finanzas y no dispone de herramientas que escriban. El `user_id` lo pone Rust a partir de la sesión.
- **Texto no fiable tratado como tal.** Las descripciones de los movimientos pueden venir de un banco o
  de terceros: van delimitadas como datos y el prompt ordena ignorar cualquier instrucción dentro.
- **Datos sensibles fuera.** IBAN, URL, correos, teléfonos y direcciones cripto se sustituyen por
  `[dato omitido]` en las descripciones que recibe el modelo y en todo lo que se guarda en la memoria.
- **Tus datos no salen.** Se usa Ollama en tu máquina. `OLLAMA_URL` solo admite esta máquina o `https`, y
  el servicio no arranca si detecta activadas las trazas de LangChain hacia LangSmith.
- **Para hardware modesto.** Un modelo de 4B cuantizado (unos 3,3 GB de memoria), una generación a la vez
  y análisis guardados en vez de recalculados. Un análisis tarda unos 90 s en una CPU moderna limitada a
  4 hilos y entre 8 y 13 s con una GPU dedicada de gama media. Si detienes la generación o cierras la
  página, también se cancela en Ollama, incluso antes del primer token, y no se guarda nada.

Límite conocido: un modelo tan pequeño recibe cifras exactas, pero a veces las interpreta mal; por ejemplo,
confunde "% del gasto" con "% de los ingresos". Sus conclusiones son las de un asistente, no las de un informe.
Arquitectura, contrato interno y mediciones en [`docs/ASESOR.md`](docs/ASESOR.md).

## Arquitectura

```
navegador ──/api (proxy de Vite)──▶ backend Rust :8080 ──▶ PostgreSQL :5433
                                        │ cifras exactas y user_id de la sesión
                                        ▼ Bearer ASESOR_TOKEN
                                    asesor Node :8090 ──▶ Ollama :11434
                                        └───────────────▶ PostgreSQL + pgvector :5435
```

| Parte    | Tecnología |
|----------|------------|
| Frontend | Vite 8, React 19, TypeScript, Tailwind CSS v4, TanStack Query, Recharts, jsPDF |
| Backend  | Rust, axum 0.8, sqlx 0.9, tokio |
| Datos    | PostgreSQL 18 en contenedores de podman; las migraciones se aplican al arrancar |
| Sesión   | JWT en cookie `httpOnly` + `SameSite=Lax`; contraseñas con Argon2id |
| Asesor   | Node, TypeScript, LangChain.js, Ollama, pgvector |

## Decisiones técnicas

- **Dinero en enteros de céntimos.** Nunca en coma flotante, para que no haya errores de redondeo.
- **Mismo origen gracias al proxy.** Para el navegador, frontend y API son el mismo origen: la cookie de
  sesión funciona sin CORS y el token nunca está al alcance de JavaScript.
- **CSV exportados sin fórmulas.** En las exportaciones de movimientos y por categoría, el texto que empieza
  por `=`, `+`, `-`, `@`, tabulador o retorno de carro lleva delante una comilla simple, para que Excel o
  LibreOffice no lo ejecuten como fórmula.
- **PDF en el navegador y bajo demanda.** jsPDF dibuja el informe con primitivas vectoriales en el cliente.
  La librería solo se descarga al pulsar «Descargar PDF», y la página de informes va en su propio chunk.
- **Arranque de desarrollo sin procesos huérfanos.** `dev.sh` lanza backend, frontend y asesor cada uno en su
  grupo de procesos (`setsid`). Con Ctrl+C manda SIGTERM a cada grupo, espera hasta 10 s y solo entonces
  fuerza SIGKILL, para no dejar puertos ocupados.

### Fallos que solo salieron probándolo de verdad

- La librería de JWT compilaba sin avisos, pero **hacía panic al firmar el primer token** porque le faltaba el
  backend criptográfico.
- Enter no enviaba el formulario de alta, porque el botón quedaba fuera del `<form>`.
- Los colores de Necesidades y Deseos eran **casi indistinguibles con protanopía** (ΔE 3,0). La paleta se rehízo
  y se validó (ΔE ≥ 11), y el texto se separó en variantes con contraste AA.
- La evolución dibujaba **una caída falsa a 0 €** en los meses anteriores al primer movimiento.
- La fuente separaba la coma decimal de las cifras ("2100 , 00 €").
- **Dos importes enormes en un mes desbordaban `SUM(...)::BIGINT`**, y el resumen y los informes de ese mes
  respondían 500 hasta borrarlos. Ahora el importe tiene un tope de 1.000 millones de euros y la fecha va de
  2000 a 2100, el mismo rango que aceptan los informes. Se valida en el formulario, en la API y con `CHECK`
  en la BD.
- **Postgres entraba en `PANIC` al apagar el equipo.** Mientras la BD dependía de una terminal, el apagado
  desmontaba el almacenamiento del contenedor (`fuse-overlayfs`) en mitad del checkpoint y podía corromper el
  clúster. Ahora es un servicio Quadlet de systemd: recibe SIGINT (apagado rápido y limpio) y systemd espera
  hasta 60 s a que termine antes de desmontar nada.
- **Tres cifras de ahorro distintas para el mismo mes.** Con 2.000 € de ingresos, 1.400 € gastados en
  necesidades y deseos y 400 € invertidos, el resumen daba un 30 % (lo invertido más lo no gastado), la tasa de ahorro de informes un 10 %
  (solo el neto) y el cubo de ahorro un 20 % (solo lo invertido). Ahora hay una sola fórmula para todo.
- **Un carácter NUL en una descripción daba 500** al guardarla en PostgreSQL. Ahora las descripciones, también
  las del alta manual, se limpian de caracteres de control e invisibles antes de llegar a la BD.

## Arrancar en local

Requisitos: Rust ≥ 1.94, Node 20.19+ o 22.12+ y podman con systemd. Para el asesor, además, Node ≥ 24.2 y
[Ollama](https://ollama.com).

```bash
git clone https://github.com/Chuwi12/cuentas.git && cd cuentas
cp .env.example .env
openssl rand -base64 48     # pega el resultado en JWT_SECRET dentro de .env
./scripts/db.sh install     # una sola vez: registra la BD como servicio de usuario de systemd
./scripts/dev.sh            # asegura la BD y arranca backend (:8080) y frontend (:5173)
```

Abre http://localhost:5173 y crea tu cuenta. Ctrl+C para backend y frontend a la vez; la BD sigue en marcha y
se para con `./scripts/db.sh down` (o sola, en orden, al apagar el equipo).

Para activar el asesor, pon en `ASESOR_TOKEN` (dentro de `.env`) la salida de otro `openssl rand -base64 48` y
ejecuta lo siguiente; desde entonces, `dev.sh` arranca también su BD y el servicio:

```bash
ollama pull qwen3.5:4b
ollama pull embeddinggemma:300m-qat-q8_0
./scripts/db.sh asesor install
```

`./scripts/db.sh [asesor] {install|uninstall|up|down|status|logs|psql|reset}` gestiona cada BD.

## Pruebas

| Comando | Qué comprueba |
|---|---|
| `cd backend && cargo test` | 149 tests unitarios |
| `python3 scripts/e2e.py` | 170 comprobaciones de la API con el backend en marcha, con las cifras del 50/30/20, de los informes y de la importación calculadas a mano. Se niega a correr si la BD ya tiene un usuario |
| `cd asesor && npm test && npm run check` | 57 tests y tipos. Los 3 de integración se saltan solos sin Postgres con pgvector y Ollama |
| `cd frontend && npx tsc -b && npx oxlint src` | Tipos y lint |

## Seguridad

- Contraseñas con Argon2id, de 12 caracteres como mínimo.
- La sesión va en una cookie `httpOnly`, así que un script inyectado no puede leerla.
- Toda consulta se filtra por usuario; un recurso ajeno responde 404, no 403.
- Tras 10 intentos fallidos con un mismo email, ese email se bloquea 15 minutos. Consecuencia asumida: quien
  conozca tu email podría bloquearte el acceso durante ese rato.

## Estado y limitaciones

Es una app para uso local o en una red de confianza, y todavía no está preparada para exponerla a internet:

- **No hay despliegue.** El backend solo sirve la API, así que el frontend necesita Vite.
- **Hace falta HTTPS delante y `COOKIE_SECURE=true`.** Sin HTTPS, la contraseña y la cookie viajarían en claro.
- **Las sesiones no se revocan.** Cerrar sesión borra la cookie, pero el token sigue siendo válido hasta que
  caduca (30 días por defecto, `SESSION_HOURS`).
- **Argon2 no tiene límite de concurrencia.** Muchos intentos de acceso simultáneos podrían agotar la memoria.
- **Sin recuperación de contraseña.** Si la olvidas, hay que cambiar su hash en la BD a mano.
- **Una sola moneda.** Los importes no llevan divisa ni hay conversión entre monedas.
- **El banco solo entra por CSV, y sin distinguir cuentas.** El mismo movimiento (fecha, importe y descripción)
  en dos cuentas cuenta como duplicado. La sincronización automática está analizada en
  [`docs/BANCO.md`](docs/BANCO.md), pero sin implementar.
- **Sin CI y sin tests automáticos en el frontend.** Las pruebas de la tabla anterior se lanzan a mano.

## Estructura

```
backend/
  src/auth/          registro, login, sesión, límite de intentos
  src/categories/    CRUD de categorías
  src/transactions/  CRUD de movimientos con filtros y paginación
  src/summary/       cálculo 50/30/20 (lógica pura en calc.rs) y consultas
  src/reports/       informes y exportación CSV
  src/import/        importación de CSV (el análisis del fichero, sin BD, en parse.rs)
  src/asesor/        API del asesor: datos exactos y proxy al servicio
  migrations/        esquema SQL
asesor/              servicio del asesor: Node + LangChain.js + Ollama + pgvector
frontend/
  src/pages/         una carpeta por pantalla
  src/components/    primitivas de UI compartidas
  src/lib/           cliente de API, dinero, fechas, cubos, iconos, sesión
  src/styles/        tokens de diseño
deploy/              servicios Quadlet de las dos BD
docs/                contrato de API, asesor, análisis del banco y capturas
scripts/             base de datos, arranque y prueba de punta a punta
```
