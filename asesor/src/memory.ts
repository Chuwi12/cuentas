// Memoria del asesor en Postgres + pgvector. La búsqueda por similitud es el PGVectorStore de LangChain;
// altas, listados y borrados van con `pg` porque el esquema fijo exige user_id, tipo y month (NOT NULL).
import { readFileSync } from "node:fs";
import type { Embeddings } from "@langchain/core/embeddings";
import { PGVectorStore } from "@langchain/pgvector";
import type { Pool } from "pg";

export type Tipo = "analisis" | "conversacion";
export interface Memoria {
  id: string;
  tipo: Tipo;
  month: string | null;
  content: string;
  created_at: string;
}
export interface Analisis {
  month: string;
  content: string;
  model: string;
  created_at: string;
}
export interface NuevaMemoria {
  tipo: Tipo;
  month: string;
  content: string;
  model: string;
}

export interface Memory {
  /** Análisis guardado de un mes, si existe. */
  analisis(userId: string, month: string): Promise<Analisis | null>;
  /** Las `k` memorias más parecidas al texto (similitud coseno), solo del usuario. */
  buscar(userId: string, texto: string, k: number): Promise<Memoria[]>;
  /** Guarda con su embedding; un análisis reemplaza al del mismo mes. Si `signal` se aborta antes del INSERT, no guarda. */
  guardar(userId: string, nueva: NuevaMemoria, signal?: AbortSignal): Promise<Memoria>;
  listar(userId: string): Promise<Memoria[]>;
  borrar(userId: string, id: string): Promise<boolean>;
  salud(): Promise<boolean>;
}

export const MAX_CONTENT = 8000;
const DIMENSIONES = 768;
const COLUMNAS = "id, tipo, month, content, created_at";

interface Fila {
  id: string;
  tipo: Tipo;
  month: string | null;
  content: string;
  created_at: Date;
  model?: string | null;
}
const memoria = (f: Fila): Memoria => ({ id: f.id, tipo: f.tipo, month: f.month, content: f.content, created_at: f.created_at.toISOString() });

export async function applySchema(pool: Pool): Promise<void> {
  await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
}

export function createMemory(pool: Pool, embeddings: Embeddings): Memory {
  // `new` y no `initialize()`: la tabla ya existe (schema.sql) y así no se retiene una conexión.
  const store = new PGVectorStore(embeddings, {
    pool,
    tableName: "memorias",
    skipInitializationCheck: true,
    columns: { idColumnName: "id", contentColumnName: "content", vectorColumnName: "embedding", metadataColumnName: "metadata" },
  });

  return {
    async analisis(userId, month) {
      const { rows } = await pool.query<Fila>(
        `SELECT ${COLUMNAS}, metadata->>'model' AS model FROM memorias WHERE user_id = $1 AND tipo = 'analisis' AND month = $2`,
        [userId, month],
      );
      const f = rows[0];
      return f ? { month, content: f.content, model: f.model ?? "", created_at: f.created_at.toISOString() } : null;
    },

    async buscar(userId, texto, k) {
      // El user_id va también en metadata (lo escribe `guardar`) porque el filtro del store solo mira ahí.
      const docs = await store.asRetriever({ k, filter: { user_id: userId } }).invoke(texto);
      return docs
        .filter((d) => d.metadata.user_id === userId && typeof d.id === "string")
        .map((d) => ({
          id: d.id as string,
          tipo: d.metadata.tipo === "analisis" ? "analisis" : "conversacion",
          month: typeof d.metadata.month === "string" ? d.metadata.month : null,
          content: d.pageContent,
          created_at: String(d.metadata.created_at ?? ""),
        }));
    },

    async guardar(userId, nueva, signal) {
      const content = nueva.content.replaceAll("\0", "").slice(0, MAX_CONTENT);
      const [vector] = await embeddings.embedDocuments([content]);
      if (vector?.length !== DIMENSIONES) {
        throw new Error(`El modelo de embeddings devolvió ${vector?.length ?? 0} dimensiones y la memoria usa ${DIMENSIONES} (revisa ASESOR_EMBED_MODEL)`);
      }
      signal?.throwIfAborted(); // el embedding tarda: si el cliente se fue mientras tanto, no se guarda
      const ahora = new Date();
      const metadata = { user_id: userId, tipo: nueva.tipo, month: nueva.month, model: nueva.model, created_at: ahora.toISOString() };
      const { rows } = await pool.query<Fila>(
        `INSERT INTO memorias (user_id, tipo, month, content, metadata, embedding, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector, $7)
         ON CONFLICT (user_id, month) WHERE tipo = 'analisis'
         DO UPDATE SET content = EXCLUDED.content, metadata = EXCLUDED.metadata,
                       embedding = EXCLUDED.embedding, created_at = EXCLUDED.created_at
         RETURNING ${COLUMNAS}`,
        [userId, nueva.tipo, nueva.month, content, JSON.stringify(metadata), `[${vector.join(",")}]`, ahora],
      );
      return memoria(rows[0] as Fila);
    },

    async listar(userId) {
      const { rows } = await pool.query<Fila>(`SELECT ${COLUMNAS} FROM memorias WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]);
      return rows.map(memoria);
    },

    async borrar(userId, id) {
      const { rowCount } = await pool.query("DELETE FROM memorias WHERE id = $1 AND user_id = $2", [id, userId]);
      return (rowCount ?? 0) > 0;
    },

    async salud() {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}
