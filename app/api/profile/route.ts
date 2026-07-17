import {getChatGPTUser} from "../../chatgpt-auth";
import {cleanText, database, ensureCollaborationSchema, isRecord, json, MAX_SMALL_REQUEST_BYTES, readLimitedJson} from "../../../db/collaboration";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({error: "Debes iniciar sesión"}, 401);
  await ensureCollaborationSchema();
  const profile = await database().prepare(
    "SELECT email, handle, display_name AS displayName, avatar_color AS avatarColor, created_at AS createdAt FROM profiles WHERE email = ?",
  ).bind(user.email).first();
  return json({user: {displayName: user.displayName}, profile});
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({error: "Debes iniciar sesión"}, 401);
  await ensureCollaborationSchema();
  const parsed = await readLimitedJson(request, MAX_SMALL_REQUEST_BYTES);
  if (!parsed.ok) return json({error: parsed.status === 413 ? "Solicitud demasiado grande" : "Solicitud inválida"}, parsed.status);
  const rawBody = parsed.value;
  if (!isRecord(rawBody)) return json({error: "Solicitud inválida"}, 400);
  const body = rawBody;
  const displayName = cleanText(body.displayName, user.displayName, 50);
  const handle = String(body.handle ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(handle)) {
    return json({error: "El usuario debe tener 3–24 letras minúsculas, números o guiones bajos."}, 400);
  }
  const avatarColor = avatarColorFor(user.email);
  const now = Date.now();
  try {
    await database().prepare(
      `INSERT INTO profiles (email, handle, display_name, avatar_color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name,
       avatar_color = excluded.avatar_color, updated_at = excluded.updated_at`,
    ).bind(user.email, handle, displayName, avatarColor, now, now).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      return json({error: "Ese nombre de usuario ya está en uso."}, 409);
    }
    return json({error: "No pudimos guardar el perfil."}, 500);
  }
  return json({profile: {email: user.email, handle, displayName, avatarColor}}, 200);
}

function avatarColorFor(value: string) {
  const palette = ["#6756E8", "#E34884", "#159A80", "#E87817", "#2878D0"];
  const seed = [...value].reduce((total, character) => total + character.charCodeAt(0), 0);
  return palette[seed % palette.length];
}
