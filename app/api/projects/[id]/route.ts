import {getChatGPTUser} from "../../../chatgpt-auth";
import {cleanText, consumeRateLimit, database, ensureCollaborationSchema, isRecord, json, MAX_PROJECT_ASSET_TOTAL_BYTES, MAX_PROJECT_REQUEST_BYTES, MAX_SMALL_REQUEST_BYTES, MAX_STRUCTURAL_VERSION, normalizeProjectState, opaqueClientId, pruneUnreferencedProjectAssets, readLimitedJson, type ProjectState} from "../../../../db/collaboration";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function authorizedProject(id: string, token: string) {
  return database().prepare(
    "SELECT id, invite_token AS inviteToken, name, state, version, updated_at AS updatedAt, updated_by AS updatedBy FROM projects WHERE id = ? AND invite_token = ?",
  ).bind(id, token).first<{
    id: string; inviteToken: string; name: string; state: string; version: number; updatedAt: number; updatedBy: string;
  }>();
}

async function mutationIdentity(body: Record<string, unknown>) {
  const user = await getChatGPTUser();
  if (user) {
    const profile = await database().prepare(
      "SELECT display_name AS displayName, avatar_color AS avatarColor FROM profiles WHERE email = ?",
    ).bind(user.email).first<{displayName: string; avatarColor: string}>();
    return {
      name: cleanText(profile?.displayName, cleanText(user.fullName, "Miembro de Lumo", 40), 40),
      color: /^#[0-9a-f]{6}$/i.test(profile?.avatarColor ?? "") ? profile!.avatarColor : "#6756e8",
    };
  }
  return {
    name: `Invitado · ${cleanText(body.name, "Lumo", 28)}`,
    color: /^#[0-9a-f]{6}$/i.test(String(body.color ?? "")) ? String(body.color) : "#6756e8",
  };
}

export async function GET(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const { id } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const token = searchParams.get("token") ?? "";
  const project = await authorizedProject(id, token);
  if (!project) return json({ error: "Invitación inválida o vencida" }, 404);
  const activeSince = Date.now() - 12_000;
  const [members, comments, latestEvent] = await Promise.all([
    database().prepare(
      "SELECT client_id AS clientId, name, color, cursor_x AS cursorX, cursor_y AS cursorY, last_seen AS lastSeen FROM presence WHERE project_id = ? AND last_seen >= ? ORDER BY last_seen DESC",
    ).bind(id, activeSince).all(),
    database().prepare(
      "SELECT id, author, color, message, created_at AS createdAt FROM comments WHERE project_id = ? ORDER BY created_at DESC LIMIT 20",
    ).bind(id).all(),
    database().prepare(
      "SELECT COALESCE(MAX(seq), 0) AS lastEventSeq FROM project_events WHERE project_id = ?",
    ).bind(id).first<{lastEventSeq: number}>(),
  ]);
  const safeProject = {
    id: project.id,
    name: project.name,
    version: project.version,
    updatedAt: project.updatedAt,
  };
  const sinceParameter = searchParams.get("sinceVersion");
  const sinceVersion = Number(sinceParameter);
  const includeState = sinceParameter === null || !Number.isSafeInteger(sinceVersion) || sinceVersion < 0 || Number(project.version) > sinceVersion;
  const viewer = cleanText(searchParams.get("viewer"), "", 80);
  const publicMembers = await Promise.all(members.results.map(async member => ({
    ...member,
    clientId: await opaqueClientId(id, String((member as {clientId?: unknown}).clientId ?? ""), viewer),
  })));
  return json({
    ...safeProject,
    ...(includeState ? {state: JSON.parse(project.state) as ProjectState} : {}),
    stateChanged: includeState,
    members: publicMembers,
    comments: comments.results,
    lastEventSeq: Number(latestEvent?.lastEventSeq ?? 0),
  });
}

export async function PATCH(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const { id } = await context.params;
  const parsed = await readLimitedJson(request, MAX_PROJECT_REQUEST_BYTES);
  if (!parsed.ok) return json({error: parsed.status === 413 ? "Solicitud demasiado grande" : "Solicitud inválida"}, parsed.status);
  const rawBody = parsed.value;
  if (!isRecord(rawBody)) return json({error: "Solicitud inválida"}, 400);
  const body = rawBody as {
    token?: string; clientId?: string; name?: string; state?: ProjectState; expectedVersion?: number;
  };
  const project = await authorizedProject(id, body.token ?? "");
  if (!project) return json({ error: "No autorizado" }, 403);
  const rate = await consumeRateLimit(request, `snapshot:${id}`, cleanText(body.clientId, "anon", 80), 180);
  if (!rate.allowed) return json({error: "Demasiados guardados; inténtalo de nuevo en un momento"}, 429, {"Retry-After": String(rate.retryAfter)});
  if (!body.state || typeof body.state !== "object") return json({ error: "Estado inválido" }, 400);
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(project.version)) {
    return json({
      error: "El proyecto cambió en otro dispositivo",
      version: Number(project.version),
      state: JSON.parse(project.state) as ProjectState,
    }, 409);
  }
  const now = Date.now();
  const nextVersion = Number(project.version) + 1;
  const safeState = normalizeProjectState(body.state);
  if (!safeState) return json({error: "El proyecto es demasiado grande o contiene datos inválidos"}, 413);
  const previousState = normalizeProjectState(JSON.parse(project.state)) ?? safeState;
  safeState.structuralVersion = safeState.structuralVersion > previousState.structuralVersion
    ? Math.min(previousState.structuralVersion + 1, MAX_STRUCTURAL_VERSION)
    : previousState.structuralVersion;
  if (safeState.assets.length) {
    // Renew every desired reference before validating it. A concurrent GC can
    // either delete first (the following SELECT reports it missing) or observe
    // this fresh lease and leave it in place until the CAS commits.
    await database().prepare(
      `UPDATE project_assets SET created_at = ?
       WHERE project_id = ?
         AND asset_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    ).bind(now, id, JSON.stringify(safeState.assets.map(asset => asset.assetId))).run();
  }
  const [latestEvent, storedAssets] = await Promise.all([
    database().prepare(
      "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM project_events WHERE project_id = ?",
    ).bind(id).first<{maxSeq: number}>(),
    safeState.assets.length ? database().prepare(
      "SELECT asset_id AS assetId, data_format AS dataFormat, asset_type AS assetType, LENGTH(data) AS byteLength FROM project_assets WHERE project_id = ?",
    ).bind(id).all<{assetId: string; dataFormat: string; assetType: string; byteLength: number}>() : Promise.resolve({results: []}),
  ]);
  safeState.eventSeq = Math.min(safeState.eventSeq, Number(latestEvent?.maxSeq ?? 0));
  const assetsById = new Map(storedAssets.results.map(asset => [asset.assetId, asset]));
  const missingAssets: string[] = [];
  safeState.assets = safeState.assets.map(reference => {
    const stored = assetsById.get(reference.assetId);
    if (!stored || stored.dataFormat !== reference.dataFormat || stored.assetType !== reference.assetType) {
      missingAssets.push(reference.assetId);
      return reference;
    }
    return {...reference, byteLength: Number(stored.byteLength)};
  });
  if (missingAssets.length) {
    return json({error: "Faltan recursos del proyecto; vuelve a sincronizarlos", missingAssets}, 424);
  }
  const activeAssetBytes = safeState.assets.reduce((total, asset) => total + asset.byteLength, 0);
  if (activeAssetBytes > MAX_PROJECT_ASSET_TOTAL_BYTES) {
    return json({error: "El proyecto supera 50 MB de recursos activos"}, 413);
  }
  const update = await database().prepare(
    "UPDATE projects SET name = ?, state = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND invite_token = ? AND version = ?",
  ).bind(cleanText(body.name, project.name, 70), JSON.stringify(safeState), nextVersion, now, cleanText(body.clientId, "anon", 80), id, body.token, expectedVersion).run();
  if (Number(update.meta?.changes ?? 0) !== 1) {
    const current = await authorizedProject(id, body.token ?? "");
    return json({
      error: "Conflicto de versión",
      version: Number(current?.version ?? expectedVersion),
      state: current ? JSON.parse(current.state) as ProjectState : safeState,
    }, 409);
  }
  // A checkpoint contains every event up to eventSeq. Keep a generous tail
  // for suspended clients while bounding the ordered log.
  const retentionFloor = Math.max(0, safeState.eventSeq - 1000);
  if (retentionFloor > 0) {
    await database().prepare(
      "DELETE FROM project_events WHERE project_id = ? AND seq <= ?",
    ).bind(id, retentionFloor).run().catch(() => undefined);
  }
  // Content-addressed uploads carry a short lease. Once the new snapshot is
  // committed, old unreferenced blobs outside that lease can be reclaimed
  // without racing another collaborator's upload/CAS sequence.
  await pruneUnreferencedProjectAssets(id, now).catch(() => 0);
  return json({ version: nextVersion, updatedAt: now });
}

export async function POST(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const { id } = await context.params;
  const parsed = await readLimitedJson(request, MAX_SMALL_REQUEST_BYTES);
  if (!parsed.ok) return json({error: parsed.status === 413 ? "Solicitud demasiado grande" : "Solicitud inválida"}, parsed.status);
  const rawBody = parsed.value;
  if (!isRecord(rawBody)) return json({error: "Solicitud inválida"}, 400);
  const body = rawBody;
  const project = await authorizedProject(id, String(body.token ?? ""));
  if (!project) return json({ error: "No autorizado" }, 403);
  const action = String(body.action ?? "presence");
  if (action === "comment") {
    const rate = await consumeRateLimit(request, `comment:${id}`, cleanText(body.clientId, "guest", 80), 20);
    if (!rate.allowed) return json({error: "Demasiados comentarios; espera un momento"}, 429, {"Retry-After": String(rate.retryAfter)});
    const message = cleanText(body.message, "", 240);
    if (!message) return json({ error: "Comentario vacío" }, 400);
    const author = await mutationIdentity(body);
    const comment = {
      id: crypto.randomUUID(),
      author: author.name,
      color: author.color,
      message,
      createdAt: Date.now(),
    };
    await database().prepare(
      "INSERT INTO comments (id, project_id, author, color, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(comment.id, id, comment.author, comment.color, comment.message, comment.createdAt).run();
    await database().prepare(
      `DELETE FROM comments WHERE project_id = ? AND id NOT IN (
        SELECT id FROM comments WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 200
      )`,
    ).bind(id, id).run().catch(() => undefined);
    return json({ ok: true, comment }, 201);
  }
  if (action !== "presence") return json({error: "Acción inválida"}, 400);
  const clientId = cleanText(body.clientId, "", 80);
  if (!clientId) return json({error: "Identidad inválida"}, 400);
  const rate = await consumeRateLimit(request, `presence:${id}`, clientId, 90, 60_000, 1_500);
  if (!rate.allowed) return json({error: "Demasiadas actualizaciones de presencia"}, 429, {"Retry-After": String(rate.retryAfter)});
  const cursorX = Number(body.cursorX);
  const cursorY = Number(body.cursorY);
  const collaborator = await mutationIdentity(body);
  const now = Date.now();
  await database().prepare(
    "DELETE FROM presence WHERE project_id = ? AND last_seen < ?",
  ).bind(id, now - 86_400_000).run().catch(() => undefined);
  const upsert = await database().prepare(
    `INSERT INTO presence (project_id, client_id, name, color, cursor_x, cursor_y, last_seen)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM presence WHERE project_id = ? AND client_id = ?)
        OR ((SELECT COUNT(*) FROM presence WHERE project_id = ?) < 500
            AND (SELECT COUNT(*) FROM presence WHERE project_id = ? AND last_seen >= ?) < 50)
     ON CONFLICT(project_id, client_id) DO UPDATE SET
       name = excluded.name, color = excluded.color, cursor_x = excluded.cursor_x,
       cursor_y = excluded.cursor_y, last_seen = excluded.last_seen`,
  ).bind(
    id,
    clientId,
    collaborator.name,
    collaborator.color,
    Math.max(0, Math.min(100, Number.isFinite(cursorX) ? cursorX : 50)),
    Math.max(0, Math.min(100, Number.isFinite(cursorY) ? cursorY : 50)),
    now,
    id,
    clientId,
    id,
    id,
    now - 12_000,
  ).run();
  if (Number(upsert.meta?.changes ?? 0) !== 1) {
    return json({error: "El proyecto alcanzó el límite de colaboradores activos"}, 429);
  }
  return json({ ok: true });
}
