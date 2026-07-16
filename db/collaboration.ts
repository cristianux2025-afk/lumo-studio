import { env } from "cloudflare:workers";

type D1DatabaseLike = {
  batch: (statements: unknown[]) => Promise<unknown>;
  prepare: (query: string) => {
    bind: (...values: unknown[]) => D1DatabaseLike["prepare"] extends (query: string) => infer R ? R : never;
    first: <T = Record<string, unknown>>() => Promise<T | null>;
    all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
    run: () => Promise<unknown>;
  };
};

export type ProjectState = {
  blocksXml: string;
  selectedSprite: string;
  stageBackdrop: string;
  activity: Array<{ id: string; text: string; at: number }>;
};

export const defaultProjectState: ProjectState = {
  blocksXml: "",
  selectedSprite: "Lumi",
  stageBackdrop: "Bosque lunar",
  activity: [
    { id: "welcome", text: "Proyecto creado en Lumo Studio", at: Date.now() },
  ],
};

export function database() {
  const db = (env as unknown as { DB?: D1DatabaseLike }).DB;
  if (!db) throw new Error("La base de datos colaborativa no está disponible.");
  return db;
}

export async function ensureCollaborationSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      invite_token TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS presence (
      project_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      cursor_x INTEGER NOT NULL DEFAULT 50,
      cursor_y INTEGER NOT NULL DEFAULT 50,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (project_id, client_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      author TEXT NOT NULL,
      color TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS presence_project_seen_idx ON presence(project_id, last_seen)"),
    db.prepare("CREATE INDEX IF NOT EXISTS comments_project_created_idx ON comments(project_id, created_at)"),
  ]);
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function cleanText(value: unknown, fallback: string, max = 80) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/[<>]/g, "");
  return cleaned.slice(0, max) || fallback;
}
