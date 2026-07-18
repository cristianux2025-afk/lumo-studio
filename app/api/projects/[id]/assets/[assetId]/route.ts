import {consumeRateLimit, database, ensureCollaborationSchema, json, MAX_D1_PAYLOAD_BYTES, MAX_STORED_PROJECT_ASSETS, MAX_STORED_PROJECT_ASSET_TOTAL_BYTES, pruneUnreferencedProjectAssets, validAssetMetadata} from "../../../../../../db/collaboration";

export const dynamic = "force-dynamic";

type Context = {params: Promise<{id: string; assetId: string}>};
type AssetKind = "ImageVector" | "ImageBitmap" | "Sound";

const kinds = new Set<AssetKind>(["ImageVector", "ImageBitmap", "Sound"]);
const contentTypes: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

async function hasInvite(id: string, token: string) {
  return database().prepare(
    "SELECT id FROM projects WHERE id = ? AND invite_token = ?",
  ).bind(id, token).first<{id: string}>();
}

function validAssetId(assetId: string) {
  return /^[a-zA-Z0-9_-]{16,128}$/.test(assetId);
}

function d1Bytes(value: unknown) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === "object") {
    const numericValues = Object.entries(value).filter(([key]) => /^\d+$/.test(key)).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, byte]) => Number(byte));
    if (numericValues.length) return Uint8Array.from(numericValues);
  }
  return new Uint8Array();
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function readLimitedBody(request: Request, maximum: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

export async function GET(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const {id, assetId} = await context.params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!validAssetId(assetId) || !await hasInvite(id, token)) return json({error: "Asset no autorizado"}, 403);
  const asset = await database().prepare(
    "SELECT data, data_format AS dataFormat FROM project_assets WHERE project_id = ? AND asset_id = ?",
  ).bind(id, assetId).first<{data: unknown; dataFormat: string}>();
  if (!asset) return json({error: "Asset no encontrado"}, 404);
  const bytes = d1Bytes(asset.data);
  if (!bytes.byteLength) return json({error: "Asset vacío"}, 500);
  const body = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  return new Response(body as ArrayBuffer, {
    headers: {
      "Content-Type": contentTypes[asset.dataFormat] ?? "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `attachment; filename="${assetId}.${asset.dataFormat}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function PUT(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const {id, assetId} = await context.params;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const dataFormat = (url.searchParams.get("format") ?? "").toLowerCase();
  const assetType = url.searchParams.get("type") as AssetKind | null;
  if (!validAssetId(assetId) || !assetType || !kinds.has(assetType) || !validAssetMetadata(assetType, dataFormat)) {
    return json({error: "Metadatos de asset inválidos"}, 400);
  }
  if (!await hasInvite(id, token)) return json({error: "Invitación inválida"}, 403);
  const rate = await consumeRateLimit(request, `asset:${id}`, "uploads", 120);
  if (!rate.allowed) return json({error: "Demasiadas cargas; inténtalo de nuevo en un momento"}, 429, {"Retry-After": String(rate.retryAfter)});
  const announcedLength = Number(request.headers.get("content-length") || 0);
  if (announcedLength > MAX_D1_PAYLOAD_BYTES) return json({error: "El asset supera 1,75 MB"}, 413);
  const data = await readLimitedBody(request, MAX_D1_PAYLOAD_BYTES);
  if (!data?.byteLength) return json({error: "El asset está vacío o supera 1,75 MB"}, 413);
  const existing = await database().prepare(
    "SELECT data_format AS dataFormat, asset_type AS assetType, data, LENGTH(data) AS byteLength FROM project_assets WHERE project_id = ? AND asset_id = ?",
  ).bind(id, assetId).first<{dataFormat: string; assetType: string; data: unknown; byteLength: number}>();
  if (existing) {
    if (existing.dataFormat !== dataFormat || existing.assetType !== assetType || !sameBytes(d1Bytes(existing.data), data)) {
      return json({error: "El asset inmutable ya existe con otros metadatos o contenido"}, 409);
    }
    const touched = await database().prepare(
      "UPDATE project_assets SET created_at = ? WHERE project_id = ? AND asset_id = ?",
    ).bind(Date.now(), id, assetId).run();
    if (Number(touched.meta?.changes ?? 0) === 1) return json({ok: true, assetId, reused: true}, 200);
  }
  const insertAsset = () => database().prepare(
    `INSERT INTO project_assets (project_id, asset_id, data_format, asset_type, data, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM project_assets WHERE project_id = ?) < ?
       AND (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM project_assets WHERE project_id = ?) + ? <= ?
     ON CONFLICT(project_id, asset_id) DO NOTHING`,
  ).bind(
    id, assetId, dataFormat, assetType, data.buffer, Date.now(),
    id, MAX_STORED_PROJECT_ASSETS, id, data.byteLength, MAX_STORED_PROJECT_ASSET_TOTAL_BYTES,
  ).run();
  let insert = await insertAsset();
  if (Number(insert.meta?.changes ?? 0) !== 1) {
    // Reclaim only after the buffered insert fails. Normal multi-asset uploads
    // therefore keep their full lease even when they take several minutes.
    await pruneUnreferencedProjectAssets(id).catch(() => 0);
    insert = await insertAsset();
  }
  if (Number(insert.meta?.changes ?? 0) !== 1) {
    const concurrent = await database().prepare(
      "SELECT data_format AS dataFormat, asset_type AS assetType, data, LENGTH(data) AS byteLength FROM project_assets WHERE project_id = ? AND asset_id = ?",
    ).bind(id, assetId).first<{dataFormat: string; assetType: string; data: unknown; byteLength: number}>();
    if (concurrent) {
      if (concurrent.dataFormat !== dataFormat || concurrent.assetType !== assetType || !sameBytes(d1Bytes(concurrent.data), data)) {
        return json({error: "El asset inmutable ya existe con otros metadatos o contenido"}, 409);
      }
      const touched = await database().prepare(
        "UPDATE project_assets SET created_at = ? WHERE project_id = ? AND asset_id = ?",
      ).bind(Date.now(), id, assetId).run();
      if (Number(touched.meta?.changes ?? 0) === 1) return json({ok: true, assetId, reused: true}, 200);
      return json({error: "El asset cambió durante la sincronización; reintenta"}, 503);
    }
    const quota = await database().prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(data)), 0) AS totalBytes FROM project_assets WHERE project_id = ?",
    ).bind(id).first<{count: number; totalBytes: number}>();
    const error = Number(quota?.count ?? 0) >= MAX_STORED_PROJECT_ASSETS
      ? "El proyecto está liberando recursos antiguos; el guardado se reintentará"
      : "El proyecto está liberando espacio de recursos; el guardado se reintentará";
    return json({error}, 503, {"Retry-After": "15"});
  }
  return json({ok: true, assetId, byteLength: data.byteLength}, 201);
}
