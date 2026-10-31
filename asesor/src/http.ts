import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY = 256 * 1024;

/** Error con status y código del contrato (`{"error":{"code","message"}}`). */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(data);
}

export function sendError(res: ServerResponse, e: HttpError): void {
  // Con un cuerpo de más no se lee el resto: se cierra la conexión.
  sendJson(res, e.status, { error: { code: e.code, message: e.message } }, e.status === 413 ? { connection: "close" } : {});
}

/** Lee el cuerpo (máx. MAX_BODY) y lo parsea como JSON. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const tooLarge = () => new HttpError(413, "validation", "El cuerpo de la petición supera los 256 KB.");
  if (Number(req.headers["content-length"]) > MAX_BODY) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(422, "validation", "El cuerpo no es un JSON válido.");
  }
}

/** Bearer en tiempo constante. Se comparan los SHA-256 para que el largo no se filtre ni rompa timingSafeEqual. */
export function authorized(req: IncomingMessage, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m?.[1]) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(m[1]), digest(token));
}
