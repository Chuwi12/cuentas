// Configuración por variables de entorno (tabla de docs/ASESOR.md). Falla al arrancar si es inválida.

export interface Config {
  token: string;
  port: number;
  databaseUrl: string;
  ollamaUrl: string;
  model: string;
  embedModel: string;
  numCtx: number;
  keepAlive: string | number;
}

type Env = Record<string, string | undefined>;

// LangChain activa LangSmith con cualquiera de estas variables y enviaría prompts y respuestas (datos financieros) a su nube.
const TRAZAS = ["LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING", "LANGCHAIN_TRACING"];
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const KEEP_ALIVE = /^(-?\d+|(\d+(\.\d+)?(ms|s|m|h))+)$/; // segundos o duración de Go: "300", "5m", "1h30m"

export function loadConfig(env: Env = process.env): Config {
  const errors: string[] = [];
  const int = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${name} debe ser un entero entre ${min} y ${max}`);
      return def;
    }
    return n;
  };
  const text = (name: string, def: string): string => env[name]?.trim() || def;

  const token = env.ASESOR_TOKEN ?? "";
  if (token.length < 32) errors.push("ASESOR_TOKEN es obligatoria y debe tener al menos 32 caracteres (openssl rand -base64 48)");
  const databaseUrl = env.ASESOR_DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) errors.push("ASESOR_DATABASE_URL es obligatoria (postgres://usuario:clave@127.0.0.1:5435/asesor)");

  for (const v of TRAZAS) {
    if (env[v]?.trim().toLowerCase() === "true") errors.push(`${v}=true enviaría prompts y respuestas a LangSmith: el asesor no envía datos fuera de la máquina`);
  }

  const ollamaUrl = text("OLLAMA_URL", "http://127.0.0.1:11434").replace(/\/+$/, "");
  if (!URL.canParse(ollamaUrl)) errors.push("OLLAMA_URL no es una URL válida");
  else {
    const u = new URL(ollamaUrl);
    const seguro = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
    if (!seguro) errors.push("OLLAMA_URL debe apuntar a esta máquina (127.0.0.1, ::1 o localhost) o usar https");
  }

  const keepAliveRaw = text("ASESOR_KEEP_ALIVE", "5m");
  if (!KEEP_ALIVE.test(keepAliveRaw)) errors.push('ASESOR_KEEP_ALIVE no es una duración válida (ejemplos: "5m", "300", "1h")');

  const config: Config = {
    token,
    port: int("ASESOR_PORT", 8090, 1, 65535),
    databaseUrl,
    ollamaUrl,
    model: text("ASESOR_MODEL", "qwen3.5:4b"),
    embedModel: text("ASESOR_EMBED_MODEL", "embeddinggemma:300m-qat-q8_0"),
    numCtx: int("ASESOR_NUM_CTX", 4096, 1024, 131072),
    // Ollama rechaza "300" sin unidad: los enteros van como número (segundos).
    keepAlive: /^-?\d+$/.test(keepAliveRaw) ? Number(keepAliveRaw) : keepAliveRaw,
  };
  if (errors.length) throw new Error(`Configuración inválida:\n- ${errors.join("\n- ")}`);
  return config;
}
