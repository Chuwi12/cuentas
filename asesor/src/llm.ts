// LangChain.js: ChatOllama + OllamaEmbeddings y la cadena LCEL prompt | modelo.
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import type { Config } from "./config.ts";
import { HUMAN, NUM_PREDICT, SYSTEM, type PromptVars } from "./prompts.ts";

/** Texto generado, en trozos. */
export interface Generacion extends AsyncIterable<string> {
  /** `done_reason` de Ollama al terminar: "stop" si acabó solo, "length" si se quedó sin tokens y la respuesta está cortada. */
  motivo?: string;
}

export interface Llm {
  /**
   * Abre la generación. Cancelar `signal` cierra la conexión con Ollama, también antes de que mande la primera cabecera.
   * Lanza (en la llamada o en el primer trozo) si Ollama no responde o el prompt no cabe en el contexto.
   */
  stream(vars: PromptVars, signal: AbortSignal): Promise<Generacion>;
  /** Ollama responde y tiene el modelo de chat y el de embeddings (sin descargar nada). */
  salud(): Promise<{ ollama: boolean; modelo: boolean }>;
}

export function createEmbeddings(cfg: Config): OllamaEmbeddings {
  return new OllamaEmbeddings({
    baseUrl: cfg.ollamaUrl,
    model: cfg.embedModel,
    keepAlive: cfg.keepAlive,
    maxRetries: 1, // el defecto de LangChain (6, con espera exponencial) tarda minutos en dar un 503 si Ollama está caído
    // Los embeddings no son streaming: sin esto una Ollama colgada dejaría la petición esperando para siempre.
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(120_000) }),
  });
}

export function createLlm(cfg: Config): Llm {
  // El asesor hace una generación a la vez (candado en server.ts): la señal de la que está en curso vive aquí.
  let actual: AbortSignal | undefined;
  const chat = new ChatOllama({
    baseUrl: cfg.ollamaUrl,
    model: cfg.model,
    temperature: 0.3,
    numCtx: cfg.numCtx,
    numPredict: NUM_PREDICT,
    keepAlive: cfg.keepAlive,
    maxRetries: 1,
    think: false, // qwen3.5 razona por defecto: gasta tokens y tiempo sin aportar al resumen
    // LangChain no pasa su AbortSignal al fetch, y ollama-js solo sabe cortar un stream cuando ya han llegado las cabeceras (con el
    // primer token): hasta entonces la conexión seguía viva y Ollama evaluando el prompt. Con la señal en el fetch se cierra siempre.
    // `truncate: false` (no lo expone ChatOllama): si el prompt no cabe en num_ctx Ollama responde 400 en vez de recortarlo por el
    // principio, que se llevaría las reglas del prompt de sistema.
    fetch: (input, init) => {
      const chatBody = String(input).endsWith("/api/chat") && typeof init?.body === "string";
      const body = chatBody ? JSON.stringify({ ...JSON.parse(init!.body as string), truncate: false }) : init?.body;
      const senales = [init?.signal, actual].filter((s): s is AbortSignal => !!s);
      return fetch(input, { ...init, body, signal: AbortSignal.any(senales) });
    },
  });
  // Sin StringOutputParser: el parser tira los metadatos y hace falta el done_reason del último trozo para no guardar respuestas cortadas.
  const chain = ChatPromptTemplate.fromMessages([
    ["system", SYSTEM],
    ["human", HUMAN],
  ]).pipe(chat);

  const con = (nombre: string) => (nombre.includes(":") ? nombre : `${nombre}:latest`);
  return {
    async stream(vars, signal) {
      actual = signal;
      const trozos = await chain.stream(vars, { signal });
      const gen: Generacion = {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of trozos) {
            const motivo = chunk.response_metadata?.done_reason;
            if (typeof motivo === "string") gen.motivo = motivo;
            if (typeof chunk.content === "string" && chunk.content) yield chunk.content;
          }
        },
      };
      return gen;
    },
    async salud() {
      try {
        const res = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { ollama: false, modelo: false };
        const { models } = (await res.json()) as { models?: { name?: string }[] };
        const nombres = new Set((models ?? []).map((m) => m.name));
        return { ollama: true, modelo: nombres.has(con(cfg.model)) && nombres.has(con(cfg.embedModel)) };
      } catch {
        return { ollama: false, modelo: false };
      }
    },
  };
}
