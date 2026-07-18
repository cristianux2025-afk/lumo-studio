import {database, defaultProjectState, ensureCollaborationSchema, isRecord, json, MAX_PROJECT_REQUEST_BYTES, normalizeProjectState, readLimitedJson, type ProjectState} from "../../../db/collaboration";

export const dynamic = "force-dynamic";

async function projectCreationAllowed(request: Request) {
  const forwarded = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local-development";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(forwarded)));
  const fingerprint = [...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const windows = [
    {name: "minute", duration: 60_000, limit: 5},
    {name: "day", duration: 86_400_000, limit: 50},
  ];
  for (const window of windows) {
    const expiresAt = Math.floor(now / window.duration + 1) * window.duration;
    const bucket = `${window.name}:${Math.floor(now / window.duration)}:${fingerprint}`;
    const counter = await database().prepare(
      `INSERT INTO project_creation_limits (bucket, hits, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1, expires_at = excluded.expires_at
       RETURNING hits`,
    ).bind(bucket, expiresAt).first<{hits: number}>();
    if (Number(counter?.hits ?? 0) > window.limit) return false;
  }
  await database().prepare(
    "DELETE FROM project_creation_limits WHERE expires_at < ?",
  ).bind(now).run().catch(() => undefined);
  return true;
}

export async function POST(request: Request) {
  await ensureCollaborationSchema();
  if (!await projectCreationAllowed(request)) return json({error: "Demasiados proyectos creados desde esta red; inténtalo más tarde"}, 429);
  const parsed = await readLimitedJson(request, MAX_PROJECT_REQUEST_BYTES);
  if (!parsed.ok) return json({error: parsed.status === 413 ? "Solicitud demasiado grande" : "Solicitud inválida"}, parsed.status);
  const rawBody = parsed.value;
  if (!isRecord(rawBody)) return json({error: "Solicitud inválida"}, 400);
  const body = rawBody as { name?: string; clientId?: string; state?: ProjectState };
  const id = crypto.randomUUID();
  const inviteToken = [...crypto.getRandomValues(new Uint8Array(16))]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 80) : "creator";
  const now = Date.now();
  const name = typeof body.name === "string" ? body.name.slice(0, 70) : "Mi aventura luminosa";
  const normalizedState = body.state ? normalizeProjectState(body.state) : defaultProjectState;
  if (!normalizedState) return json({error: "El proyecto es demasiado grande o contiene datos inválidos"}, 413);
  // The project cannot have ordered events before it exists. Keep this cursor
  // server-owned so a crafted creation request cannot poison future polling.
  // Assets are content-addressed blobs uploaded only after the server assigns
  // a project id. Never trust a creation-time manifest: the client must PUT
  // each blob and then commit the canonical, size-checked manifest via PATCH.
  const initialState = {
    ...normalizedState,
    eventSeq: 0,
    structuralVersion: Math.min(normalizedState.structuralVersion, 1),
    assets: [],
  };
  await database().prepare(
    "INSERT INTO projects (id, invite_token, name, state, version, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)",
  ).bind(id, inviteToken, name, JSON.stringify(initialState), now, clientId).run();
  return json({ id, inviteToken, name, state: initialState, version: 1 }, 201);
}
