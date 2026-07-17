import { env } from "cloudflare:workers";

type D1DatabaseLike = {
  batch: (statements: unknown[]) => Promise<unknown>;
  prepare: (query: string) => {
    bind: (...values: unknown[]) => D1DatabaseLike["prepare"] extends (query: string) => infer R ? R : never;
    first: <T = Record<string, unknown>>() => Promise<T | null>;
    all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
    run: () => Promise<{ meta?: { changes?: number } }>;
  };
};

export type ProjectState = {
  blocksXml: string;
  projectJson?: string;
  eventSeq: number;
  structuralVersion: number;
  assets: Array<{
    assetId: string;
    dataFormat: string;
    assetType: "ImageVector" | "ImageBitmap" | "Sound";
    byteLength: number;
  }>;
  selectedSprite: string;
  stageBackdrop: string;
  activity: Array<{ id: string; text: string; at: number }>;
};

export const defaultProjectState: ProjectState = {
  blocksXml: "",
  projectJson: "",
  eventSeq: 0,
  structuralVersion: 0,
  assets: [],
  selectedSprite: "Lumi",
  stageBackdrop: "Bosque lunar",
  activity: [
    { id: "welcome", text: "Proyecto creado en Lumo Studio", at: Date.now() },
  ],
};

export const MAX_D1_PAYLOAD_BYTES = 1_750_000;
export const MAX_PROJECT_REQUEST_BYTES = 1_800_000;
export const MAX_EVENT_REQUEST_BYTES = 100_000;
export const MAX_SMALL_REQUEST_BYTES = 8_000;
export const MAX_PROJECT_ASSETS = 100;
export const MAX_PROJECT_ASSET_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_STRUCTURAL_VERSION = 1_000_000_000_000;

export function database() {
  const db = (env as unknown as { DB?: D1DatabaseLike }).DB;
  if (!db) throw new Error("La base de datos colaborativa no está disponible.");
  return db;
}

let schemaPromise: Promise<void> | null = null;

export function ensureCollaborationSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
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
    db.prepare(`CREATE TABLE IF NOT EXISTS profiles (
      email TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, client_id, client_seq)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_assets (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      data_format TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_creation_limits (
      bucket TEXT PRIMARY KEY,
      hits INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS presence_project_seen_idx ON presence(project_id, last_seen)"),
    db.prepare("CREATE INDEX IF NOT EXISTS comments_project_created_idx ON comments(project_id, created_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS project_events_client_seq_idx ON project_events(project_id, client_id, client_seq)"),
      db.prepare("CREATE INDEX IF NOT EXISTS project_events_project_seq_idx ON project_events(project_id, seq)"),
      db.prepare("CREATE INDEX IF NOT EXISTS project_assets_project_idx ON project_assets(project_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS project_creation_limits_expiry_idx ON project_creation_limits(expires_at)"),
    ]);
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, {status, headers: {"Cache-Control": "no-store", ...Object.fromEntries(new Headers(headers))}});
}

export async function consumeRateLimit(
  request: Request,
  scope: string,
  subject: string,
  limit: number,
  durationMs = 60_000,
  networkLimit = limit,
) {
  const forwarded = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local-development";
  const now = Date.now();
  const windowNumber = Math.floor(now / durationMs);
  const expiresAt = (windowNumber + 1) * durationMs;

  const fingerprint = async (value: string) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return {
      value: [...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
      cleanupSample: digest[0] < 4,
    };
  };
  const increment = async (bucket: string) => {
    await database().prepare(
      `INSERT INTO project_creation_limits (bucket, hits, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1`,
    ).bind(bucket, expiresAt).run();
    const counter = await database().prepare(
      "SELECT hits FROM project_creation_limits WHERE bucket = ?",
    ).bind(bucket).first<{hits: number}>();
    return Number(counter?.hits ?? 0);
  };

  // Always charge a fixed network/project bucket first. This bounds both the
  // request volume and the number of per-client rows an attacker can create by
  // rotating an untrusted clientId.
  const network = await fingerprint(forwarded);
  const networkBucket = `${scope}:${windowNumber}:network:${network.value}`;
  const networkHits = await increment(networkBucket);
  const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  if (networkHits > networkLimit) return {allowed: false, retryAfter};

  let identityHits = 0;
  if (subject) {
    const identity = await fingerprint(`${forwarded}:${subject}`);
    identityHits = await increment(`${scope}:${windowNumber}:identity:${identity.value}`);
  }
  if (network.cleanupSample) {
    await database().prepare(
      "DELETE FROM project_creation_limits WHERE expires_at < ?",
    ).bind(now).run().catch(() => undefined);
  }
  return {allowed: !subject || identityHits <= limit, retryAfter};
}

export async function opaqueClientId(scope: string, clientId: string, viewer: string) {
  if (viewer && clientId === viewer) return clientId;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:${clientId}`)));
  return `peer:${[...digest.slice(0, 12)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function cleanText(value: unknown, fallback: string, max = 80) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/[<>]/g, "");
  return cleaned.slice(0, max) || fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function readLimitedJson(request: Request, maximum: number): Promise<
  {ok: true; value: unknown} | {ok: false; status: 400 | 413}
> {
  const announcedLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(announcedLength) && announcedLength > maximum) return {ok: false, status: 413};
  if (!request.body) return {ok: false, status: 400};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      return {ok: false, status: 413};
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {ok: true, value: JSON.parse(new TextDecoder().decode(bytes))};
  } catch {
    return {ok: false, status: 400};
  }
}

export function validAssetMetadata(assetType: unknown, dataFormat: unknown) {
  return (assetType === "ImageVector" && dataFormat === "svg") ||
    (assetType === "ImageBitmap" && (dataFormat === "png" || dataFormat === "jpg" || dataFormat === "jpeg")) ||
    (assetType === "Sound" && (dataFormat === "wav" || dataFormat === "mp3"));
}

export function normalizeProjectState(value: unknown): ProjectState | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ProjectState>;
  const blocksXml = typeof input.blocksXml === "string" ? input.blocksXml : "";
  const projectJson = typeof input.projectJson === "string" ? input.projectJson : "";
  if (blocksXml.length > 500_000 || projectJson.length > 1_500_000) return null;
  const activity = Array.isArray(input.activity) ? input.activity.slice(-20).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const record = item as {id?: unknown; text?: unknown; at?: unknown};
    const text = cleanText(record.text, "", 180);
    if (!text) return [];
    return [{
      id: cleanText(record.id, crypto.randomUUID(), 80),
      text,
      at: Number.isFinite(Number(record.at)) ? Number(record.at) : Date.now(),
    }];
  }) : [];
  const seenAssets = new Set<string>();
  const assets: ProjectState["assets"] = Array.isArray(input.assets) ? input.assets.slice(0, MAX_PROJECT_ASSETS).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const record = item as {assetId?: unknown; dataFormat?: unknown; assetType?: unknown; byteLength?: unknown};
    const assetId = typeof record.assetId === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(record.assetId) ? record.assetId : "";
    const dataFormat = typeof record.dataFormat === "string" && /^(svg|png|jpg|jpeg|wav|mp3)$/.test(record.dataFormat) ? record.dataFormat : "";
    const assetType: ProjectState["assets"][number]["assetType"] | null = record.assetType === "ImageVector" || record.assetType === "ImageBitmap" || record.assetType === "Sound" ? record.assetType : null;
    if (!assetId || !dataFormat || !assetType || !validAssetMetadata(assetType, dataFormat) || seenAssets.has(assetId)) return [];
    seenAssets.add(assetId);
    return [{assetId, dataFormat, assetType, byteLength: Math.max(0, Math.min(MAX_D1_PAYLOAD_BYTES, Math.floor(Number(record.byteLength) || 0)))}];
  }) : [];
  const eventSeq = input.eventSeq === undefined ? 0 : Number(input.eventSeq);
  const structuralVersion = input.structuralVersion === undefined ? 0 : Number(input.structuralVersion);
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 0 ||
      !Number.isSafeInteger(structuralVersion) || structuralVersion < 0 || structuralVersion > MAX_STRUCTURAL_VERSION) {
    return null;
  }
  const normalized = {
    blocksXml,
    projectJson,
    eventSeq,
    structuralVersion,
    assets,
    selectedSprite: cleanText(input.selectedSprite, "Lumi", 40),
    stageBackdrop: cleanText(input.stageBackdrop, "Bosque lunar", 60),
    activity,
  };
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_D1_PAYLOAD_BYTES) return null;
  return normalized;
}
