import { database, defaultProjectState, ensureCollaborationSchema, json } from "../../../db/collaboration";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await ensureCollaborationSchema();
  const body = await request.json().catch(() => ({})) as { name?: string; clientId?: string };
  const id = crypto.randomUUID().split("-")[0];
  const inviteToken = crypto.randomUUID().replaceAll("-", "");
  const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 80) : "creator";
  const now = Date.now();
  const name = typeof body.name === "string" ? body.name.slice(0, 70) : "Mi aventura luminosa";
  await database().prepare(
    "INSERT INTO projects (id, invite_token, name, state, version, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)",
  ).bind(id, inviteToken, name, JSON.stringify(defaultProjectState), now, clientId).run();
  return json({ id, inviteToken, name, state: defaultProjectState, version: 1 }, 201);
}
