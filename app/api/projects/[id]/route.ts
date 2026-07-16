import { cleanText, database, ensureCollaborationSchema, json, type ProjectState } from "../../../../db/collaboration";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function authorizedProject(id: string, token: string) {
  return database().prepare(
    "SELECT id, invite_token AS inviteToken, name, state, version, updated_at AS updatedAt, updated_by AS updatedBy FROM projects WHERE id = ? AND invite_token = ?",
  ).bind(id, token).first<{
    id: string; inviteToken: string; name: string; state: string; version: number; updatedAt: number; updatedBy: string;
  }>();
}

export async function GET(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const { id } = await context.params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const project = await authorizedProject(id, token);
  if (!project) return json({ error: "Invitación inválida o vencida" }, 404);
  const activeSince = Date.now() - 12_000;
  const [members, comments] = await Promise.all([
    database().prepare(
      "SELECT client_id AS clientId, name, color, cursor_x AS cursorX, cursor_y AS cursorY, last_seen AS lastSeen FROM presence WHERE project_id = ? AND last_seen >= ? ORDER BY last_seen DESC",
    ).bind(id, activeSince).all(),
    database().prepare(
      "SELECT id, author, color, message, created_at AS createdAt FROM comments WHERE project_id = ? ORDER BY created_at DESC LIMIT 20",
    ).bind(id).all(),
  ]);
  return json({ ...project, state: JSON.parse(project.state) as ProjectState, members: members.results, comments: comments.results });
}

export async function PATCH(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as {
    token?: string; clientId?: string; name?: string; state?: ProjectState;
  };
  const project = await authorizedProject(id, body.token ?? "");
  if (!project) return json({ error: "No autorizado" }, 403);
  if (!body.state || typeof body.state !== "object") return json({ error: "Estado inválido" }, 400);
  const now = Date.now();
  const nextVersion = Number(project.version) + 1;
  const safeState: ProjectState = {
    blocksXml: typeof body.state.blocksXml === "string" ? body.state.blocksXml.slice(0, 500_000) : "",
    selectedSprite: cleanText(body.state.selectedSprite, "Lumi", 40),
    stageBackdrop: cleanText(body.state.stageBackdrop, "Bosque lunar", 60),
    activity: Array.isArray(body.state.activity) ? body.state.activity.slice(-20) : [],
  };
  await database().prepare(
    "UPDATE projects SET name = ?, state = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND invite_token = ?",
  ).bind(cleanText(body.name, project.name, 70), JSON.stringify(safeState), nextVersion, now, cleanText(body.clientId, "anon", 80), id, body.token).run();
  return json({ version: nextVersion, updatedAt: now });
}

export async function POST(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const project = await authorizedProject(id, String(body.token ?? ""));
  if (!project) return json({ error: "No autorizado" }, 403);
  const action = String(body.action ?? "presence");
  if (action === "comment") {
    const message = cleanText(body.message, "", 240);
    if (!message) return json({ error: "Comentario vacío" }, 400);
    await database().prepare(
      "INSERT INTO comments (id, project_id, author, color, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), id, cleanText(body.name, "Invitado", 40), cleanText(body.color, "#6756e8", 16), message, Date.now()).run();
    return json({ ok: true }, 201);
  }
  const clientId = cleanText(body.clientId, "anon", 80);
  await database().prepare(
    `INSERT INTO presence (project_id, client_id, name, color, cursor_x, cursor_y, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, client_id) DO UPDATE SET
       name = excluded.name, color = excluded.color, cursor_x = excluded.cursor_x,
       cursor_y = excluded.cursor_y, last_seen = excluded.last_seen`,
  ).bind(
    id,
    clientId,
    cleanText(body.name, "Invitado", 40),
    cleanText(body.color, "#6756e8", 16),
    Math.max(0, Math.min(100, Number(body.cursorX) || 50)),
    Math.max(0, Math.min(100, Number(body.cursorY) || 50)),
    Date.now(),
  ).run();
  return json({ ok: true });
}
