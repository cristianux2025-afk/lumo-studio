import {cleanText, consumeRateLimit, database, ensureCollaborationSchema, isRecord, json, MAX_EVENT_REQUEST_BYTES, opaqueClientId, readLimitedJson} from "../../../../../db/collaboration";

export const dynamic = "force-dynamic";

type Context = {params: Promise<{id: string}>};

const allowedTypes = new Set([
  "create", "change", "move", "delete",
  "var_create", "var_rename", "var_delete",
  "block_comment_create", "block_comment_change", "block_comment_move",
  "block_comment_collapse", "block_comment_resize", "block_comment_delete",
  "comment_create", "comment_change", "comment_move", "comment_collapse",
  "comment_resize", "comment_delete", "block_field_intermediate_change",
]);
const blockTypes = new Set(["create", "change", "move", "delete", "block_field_intermediate_change"]);
const variableTypes = new Set(["var_create", "var_rename", "var_delete"]);
const commentTypes = new Set([...allowedTypes].filter(type => type.includes("comment")));

async function hasInvite(id: string, token: string) {
  return database().prepare(
    "SELECT id FROM projects WHERE id = ? AND invite_token = ?",
  ).bind(id, token).first<{id: string}>();
}

function validEventShape(event: Record<string, unknown>) {
  const type = String(event.type ?? "");
  const hasOwn = (name: string) => Object.hasOwn(event, name);
  if (type === "create") return isRecord(event.json) || (typeof event.xml === "string" && event.xml.length > 0);
  if (type === "change") {
    return typeof event.element === "string" && event.element.length > 0 && hasOwn("newValue");
  }
  if (type === "block_field_intermediate_change") {
    return typeof event.name === "string" && event.name.length > 0 && hasOwn("newValue");
  }
  if (type === "move") return hasOwn("newCoordinate") || hasOwn("newParentId") || hasOwn("reason");
  if (type === "delete") return isRecord(event.oldJson) || typeof event.oldXml === "string" || Array.isArray(event.ids);
  if (type === "var_create") return typeof event.varName === "string" && typeof event.varType === "string";
  if (type === "var_rename") return typeof event.newName === "string";
  if (type === "var_delete") return typeof event.varName === "string" && typeof event.varType === "string";
  return true;
}

export async function GET(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const {id} = await context.params;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  if (!await hasInvite(id, token)) return json({error: "Invitación inválida"}, 403);
  const rawAfter = Number(url.searchParams.get("after"));
  const after = Number.isSafeInteger(rawAfter) && rawAfter > 0 ? rawAfter : 0;
  const viewer = cleanText(url.searchParams.get("viewer"), "", 80);
  const [events, bounds] = await Promise.all([
    database().prepare(
      `SELECT seq, client_id AS clientId, client_seq AS clientSeq, payload, created_at AS createdAt
       FROM project_events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200`,
    ).bind(id, after).all<{seq: number; clientId: string; clientSeq: number; payload: string; createdAt: number}>(),
    database().prepare(
      "SELECT MIN(seq) AS minSeq FROM project_events WHERE project_id = ?",
    ).bind(id).first<{minSeq: number | null}>(),
  ]);
  const minSeq = Number(bounds?.minSeq ?? 0);
  const publicEvents = await Promise.all(events.results.map(async event => ({
    ...event,
    clientId: await opaqueClientId(id, event.clientId, viewer),
    payload: JSON.parse(event.payload),
  })));
  return json({
    resetRequired: after > 0 && minSeq > after + 1,
    events: publicEvents,
  });
}

export async function POST(request: Request, context: Context) {
  await ensureCollaborationSchema();
  const {id} = await context.params;
  const parsed = await readLimitedJson(request, MAX_EVENT_REQUEST_BYTES);
  if (!parsed.ok) return json({error: parsed.status === 413 ? "Evento demasiado grande" : "Solicitud inválida"}, parsed.status);
  const rawBody = parsed.value;
  if (!isRecord(rawBody)) return json({error: "Solicitud inválida"}, 400);
  const body = rawBody as {
    token?: string;
    clientId?: string;
    clientSeq?: number;
    event?: unknown;
  };
  if (!await hasInvite(id, String(body.token ?? ""))) return json({error: "Invitación inválida"}, 403);
  const clientId = cleanText(body.clientId, "", 80);
  const clientSeq = Number(body.clientSeq);
  if (!clientId || !Number.isSafeInteger(clientSeq) || clientSeq < 1 || !isRecord(body.event)) {
    return json({error: "Evento inválido"}, 400);
  }
  const targetName = typeof body.event.targetName === "string" ? body.event.targetName.trim() : "";
  const targetId = typeof body.event.targetId === "string" ? body.event.targetId.trim() : "";
  const blockEvent = body.event.event;
  if ((!targetName && !targetId) || targetName.length > 40 || targetId.length > 160 || !isRecord(blockEvent) || typeof blockEvent.type !== "string" || !allowedTypes.has(blockEvent.type)) {
    return json({error: "Evento Blockly inválido"}, 400);
  }
  const hasId = (name: string) => typeof blockEvent[name] === "string" && String(blockEvent[name]).length > 0 && String(blockEvent[name]).length <= 128;
  if ((blockTypes.has(blockEvent.type) && !hasId("blockId")) ||
      (variableTypes.has(blockEvent.type) && !hasId("varId")) ||
      (commentTypes.has(blockEvent.type) && !hasId("commentId"))) {
    return json({error: "El evento no contiene su identificador"}, 400);
  }
  if (!validEventShape(blockEvent)) return json({error: "El evento Blockly está incompleto"}, 400);
  const rate = await consumeRateLimit(request, `event:${id}`, clientId, 600);
  if (!rate.allowed) return json({error: "Demasiados eventos; espera antes de continuar"}, 429, {"Retry-After": String(rate.retryAfter)});
  const payload = JSON.stringify({targetName, targetId, event: blockEvent});
  if (payload.length > 80_000) return json({error: "Evento demasiado grande"}, 413);
  const duplicate = await database().prepare(
    "SELECT seq FROM project_events WHERE project_id = ? AND client_id = ? AND client_seq = ?",
  ).bind(id, clientId, clientSeq).first<{seq: number}>();
  if (duplicate) return json({ok: true, seq: duplicate.seq}, 201);
  await database().prepare(
    `INSERT INTO project_events (project_id, client_id, client_seq, payload, created_at)
     SELECT ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM project_events WHERE project_id = ?) < 10000
     ON CONFLICT(project_id, client_id, client_seq) DO NOTHING`,
  ).bind(id, clientId, clientSeq, payload, Date.now(), id).run();
  const stored = await database().prepare(
    "SELECT seq FROM project_events WHERE project_id = ? AND client_id = ? AND client_seq = ?",
  ).bind(id, clientId, clientSeq).first<{seq: number}>();
  if (!stored) return json({error: "El registro de eventos necesita un snapshot antes de aceptar más cambios"}, 429);
  return json({ok: true, seq: stored.seq}, 201);
}
