const base = (process.argv[2] ?? "http://localhost:4173").replace(/\/$/, "");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return {response, body};
}

const jsonHeaders = {"Content-Type": "application/json"};
const creationHeaders = {...jsonHeaders, "X-Forwarded-For": `192.0.2.${Math.floor(Math.random() * 254) + 1}`};

const nullCreate = await request("/api/projects", {method: "POST", headers: creationHeaders, body: "null"});
assert(nullCreate.response.status === 400, "POST /api/projects debe rechazar JSON null");

const created = await request("/api/projects", {
  method: "POST",
  headers: creationHeaders,
  body: JSON.stringify({
    name: "API smoke",
    clientId: "api-smoke-client",
    state: {
      blocksXml: "",
      projectJson: "",
      eventSeq: 999,
      structuralVersion: 999,
      assets: [{assetId: "creation_asset_123456", dataFormat: "png", assetType: "ImageBitmap", byteLength: 0}],
      selectedSprite: "Stage",
      stageBackdrop: "Fondo 1",
      activity: [],
    },
  }),
});
assert(created.response.status === 201 && created.body?.id && created.body?.inviteToken && created.body?.state, "No se creó el proyecto de prueba");
const {id, inviteToken: token} = created.body;
assert(/^[a-f0-9]{32}$/.test(token), "El token de invitación no contiene 128 bits aleatorios en hexadecimal");
assert(created.body.state.assets.length === 0, "POST confió en un manifiesto sin blobs verificados");
assert(created.body.state.eventSeq === 0 && created.body.state.structuralVersion === 1, "POST no normalizó los cursores controlados por el servidor");

const missingToken = await request(`/api/projects/${id}`);
assert(missingToken.response.status === 404, "GET de proyecto aceptó una invitación ausente");
const wrongEventToken = await request(`/api/projects/${id}/events`, {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({token: "incorrecto", clientId: "api-smoke-client", clientSeq: 99, event: {targetName: "Lumi", event: {type: "delete", blockId: "x"}}}),
});
assert(wrongEventToken.response.status === 403, "La API de eventos aceptó un token incorrecto");

const nullPatch = await request(`/api/projects/${id}`, {method: "PATCH", headers: jsonHeaders, body: "null"});
assert(nullPatch.response.status === 400, "PATCH debe rechazar JSON null");

const badType = await request(`/api/projects/${id}/events`, {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", clientSeq: 1, event: {targetName: "Lumi", event: {type: "execute_script"}}}),
});
assert(badType.response.status === 400, "La API aceptó un tipo de evento no permitido");

const missingBlockId = await request(`/api/projects/${id}/events`, {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", clientSeq: 2, event: {targetName: "Lumi", event: {type: "create"}}}),
});
assert(missingBlockId.response.status === 400, "La API aceptó un create sin blockId");
const poisonedCreate = await request(`/api/projects/${id}/events`, {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", clientSeq: 7, event: {targetName: "Lumi", event: {type: "create", blockId: "poisoned"}}}),
});
assert(poisonedCreate.response.status === 400, "La API aceptó un create que Blockly no puede reconstruir");
const oversizedEventRequest = await request(`/api/projects/${id}/events`, {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", clientSeq: 8, event: {targetName: "Lumi", event: {type: "change", blockId: "x", filler: "x".repeat(100_000)}}}),
});
assert(oversizedEventRequest.response.status === 413, "La API cargó un cuerpo de evento por encima del límite");

const validEventBody = {token, clientId: "api-smoke-client", clientSeq: 3, event: {targetName: "Lumi", event: {type: "create", blockId: "api_smoke_block", json: {type: "motion_turnright", id: "api_smoke_block"}}}};
const validEvent = await request(`/api/projects/${id}/events`, {method: "POST", headers: jsonHeaders, body: JSON.stringify(validEventBody)});
assert(validEvent.response.status === 201 && validEvent.body?.seq > 0, "La API rechazó un evento válido");
const repeatedEvent = await request(`/api/projects/${id}/events`, {method: "POST", headers: jsonHeaders, body: JSON.stringify(validEventBody)});
assert(repeatedEvent.response.status === 201 && repeatedEvent.body?.seq === validEvent.body.seq, "La idempotencia clientSeq falló");
const secondEventBody = {token, clientId: "api-smoke-client", clientSeq: 4, event: {targetName: "Lumi", event: {type: "change", blockId: "api_smoke_block", element: "field", name: "STEPS", oldValue: "10", newValue: "20"}}};
const secondEvent = await request(`/api/projects/${id}/events`, {method: "POST", headers: jsonHeaders, body: JSON.stringify(secondEventBody)});
assert(secondEvent.response.status === 201 && secondEvent.body?.seq > validEvent.body.seq, "El segundo evento no conservó el orden global");

const presence = await request(`/api/projects/${id}`, {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({action: "presence", token, clientId: "api-smoke-presence", name: "Cero", color: "#123456", cursorX: 0, cursorY: 0}),
});
assert(presence.response.ok, "No se guardó la presencia");
const otherPresence = await request(`/api/projects/${id}`, {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({action: "presence", token, clientId: "other-secret-client", name: "Otro", color: "#654321", cursorX: 20, cursorY: 30}),
});
assert(otherPresence.response.ok, "No se guardó la segunda presencia");

const comment = await request(`/api/projects/${id}`, {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({action: "comment", token, name: "API", color: "#123456", message: "Comentario de prueba"}),
});
assert(comment.response.status === 201 && comment.body?.comment?.message === "Comentario de prueba", "La API no devolvió el comentario creado");

// A collaborator controls clientId, so rotating it must not open a fresh
// project-wide mutation budget on every request. Use a dedicated network
// fingerprint to keep this regression independent from the rest of the smoke.
const rotatingRateHeaders = {...jsonHeaders, "X-Forwarded-For": "198.51.100.42"};
// Send the saturation burst concurrently so a production smoke cannot straddle
// two fixed minute windows merely because of network latency.
const rotatingCommentStatuses = await Promise.all(Array.from({length: 25}, async (_, index) => {
  const attempt = await request(`/api/projects/${id}`, {
    method: "POST",
    headers: rotatingRateHeaders,
    body: JSON.stringify({
      action: "comment",
      token,
      clientId: `rotating-client-${index}`,
      name: "Rotación",
      color: "#123456",
      message: `Límite compartido ${index}`,
    }),
  });
  return attempt.response.status;
}));
assert(rotatingCommentStatuses.includes(429), "Rotar clientId eludió por completo el límite fijo de comentarios por red/proyecto");
const postLimitComment = await request(`/api/projects/${id}`, {
  method: "POST",
  headers: rotatingRateHeaders,
  body: JSON.stringify({
    action: "comment",
    token,
    clientId: "rotating-client-after-limit",
    name: "Rotación",
    color: "#123456",
    message: "Límite compartido posterior",
  }),
});
assert(postLimitComment.response.status === 429, "Cambiar clientId reabrió el presupuesto de comentarios después de alcanzar el límite por red/proyecto");

const invalidAsset = await request(`/api/projects/${id}/assets/asset_smoke_123456?token=${token}&format=svg&type=Sound`, {
  method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: new TextEncoder().encode("<svg/>")
});
assert(invalidAsset.response.status === 400, "La API aceptó Sound + svg");

const assetPath = `/api/projects/${id}/assets/asset_smoke_123456?token=${token}&format=svg&type=ImageVector`;
const originalBytes = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
const savedAsset = await request(assetPath, {method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: originalBytes});
assert(savedAsset.response.status === 201, "No se guardó el asset válido");
const reusedAsset = await request(assetPath, {method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: originalBytes});
assert(reusedAsset.response.status === 200 && reusedAsset.body?.reused, "El asset inmutable no se reutilizó");
const alteredAsset = await request(assetPath, {method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: new TextEncoder().encode("cambiado")});
assert(alteredAsset.response.status === 409, "El asset inmutable aceptó otro tamaño para el mismo identificador");
const conflictingAsset = await request(`/api/projects/${id}/assets/asset_smoke_123456?token=${token}&format=png&type=ImageBitmap`, {method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: new Uint8Array([1])});
assert(conflictingAsset.response.status === 409, "El asset inmutable aceptó metadatos incompatibles");
const sameSizeAssetPath = `/api/projects/${id}/assets/asset_same_size_123456?token=${token}&format=png&type=ImageBitmap`;
const sameSizeOriginal = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const sameSizeCollision = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
const savedSameSizeAsset = await request(sameSizeAssetPath, {method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: sameSizeOriginal});
assert(savedSameSizeAsset.response.status === 201, "No se pudo preparar la colisión de asset con tamaño idéntico");
const rejectedSameSizeAsset = await request(sameSizeAssetPath, {method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: sameSizeCollision});
assert(rejectedSameSizeAsset.response.status === 409, "El asset inmutable aceptó bytes distintos con el mismo ID, tipo y tamaño");
const oversizedAsset = await request(`/api/projects/${id}/assets/asset_oversized_123456?token=${token}&format=png&type=ImageBitmap`, {
  method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: new Uint8Array(1_750_001),
});
assert(oversizedAsset.response.status === 413, "La API aceptó un asset que excede el límite seguro de D1");
const assetResponse = await fetch(`${base}/api/projects/${id}/assets/asset_smoke_123456?token=${token}`);
assert(assetResponse.headers.get("content-disposition")?.startsWith("attachment;") && assetResponse.headers.get("content-security-policy")?.includes("sandbox"), "El asset no se sirvió como descarga aislada");
assert(assetResponse.ok && Buffer.from(await assetResponse.arrayBuffer()).equals(Buffer.from(originalBytes)), "Los bytes del asset inmutable cambiaron");

const raceId = `race_asset_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
const [raceVector, raceBitmap] = await Promise.all([
  request(`/api/projects/${id}/assets/${raceId}?token=${token}&format=svg&type=ImageVector`, {method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: new TextEncoder().encode("<svg/>")}),
  request(`/api/projects/${id}/assets/${raceId}?token=${token}&format=png&type=ImageBitmap`, {method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: new Uint8Array([1, 2, 3])}),
]);
assert([raceVector.response.status, raceBitmap.response.status].sort((a, b) => a - b).join(",") === "201,409", "Dos PUT concurrentes aceptaron metadatos incompatibles para el mismo asset");

let atomicQuota = "production-skipped";
let overQuotaAssets = [];
if (/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(base)) {
  const fillers = await Promise.all(Array.from({length: 101}, (_, index) => {
    const fillerId = `quota_asset_${String(index).padStart(5, "0")}`;
    return request(`/api/projects/${id}/assets/${fillerId}?token=${token}&format=png&type=ImageBitmap`, {
      method: "PUT", headers: {"Content-Type": "application/octet-stream"}, body: new Uint8Array([index % 255]),
    });
  }));
  assert(fillers.every(item => item.response.status === 201), "No se pudo preparar la prueba de cuota activa");
  overQuotaAssets = Array.from({length: 101}, (_, index) => ({
    assetId: `quota_asset_${String(index).padStart(5, "0")}`,
    dataFormat: "png",
    assetType: "ImageBitmap",
    byteLength: 1,
  }));
  atomicQuota = "prepared";
}

const project = await request(`/api/projects/${id}?token=${token}&viewer=api-smoke-presence`);
assert(project.response.ok && !project.body?.inviteToken, "La API expuso el token de invitación");
if (overQuotaAssets.length) {
  const overQuotaPatch = await request(`/api/projects/${id}`, {
    method: "PATCH", headers: jsonHeaders,
    body: JSON.stringify({token, clientId: "api-smoke-client", name: "Cuota activa", state: {...project.body.state, assets: overQuotaAssets}, expectedVersion: project.body.version}),
  });
  assert(overQuotaPatch.response.status === 413, "PATCH aceptó más de 100 recursos activos");
  atomicQuota = true;
}
const zeroCursor = project.body?.members?.find(member => member.clientId === "api-smoke-presence");
assert(zeroCursor?.cursorX === 0 && zeroCursor?.cursorY === 0, "La presencia convirtió el cursor 0 en 50");
assert(project.body?.members?.some(member => member.clientId.startsWith("peer:")) && !project.body?.members?.some(member => member.clientId === "other-secret-client"), "La API expuso el clientId reutilizable de otro colaborador");
assert(project.body?.comments?.some(item => String(item.message ?? "").startsWith("Límite compartido")), "Los comentarios recientes no quedaron persistidos");
assert(comment.body.comment.author.startsWith("Invitado · "), "Un comentario anónimo no quedó identificado como invitado");
const unchangedProject = await request(`/api/projects/${id}?token=${token}&viewer=api-smoke-presence&sinceVersion=${project.body.version}`);
assert(unchangedProject.response.ok && unchangedProject.body?.stateChanged === false && !("state" in unchangedProject.body), "GET descargó el snapshot aunque la versión no cambió");

const wrongPatchToken = await request(`/api/projects/${id}`, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({token: "incorrecto", clientId: "api-smoke-client", name: "No", state: project.body.state, expectedVersion: project.body.version}),
});
assert(wrongPatchToken.response.status === 403, "PATCH aceptó un token incorrecto");
const stalePatch = await request(`/api/projects/${id}`, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", name: "API smoke", state: project.body.state, expectedVersion: 0}),
});
assert(stalePatch.response.status === 409 && stalePatch.body?.version === project.body.version && stalePatch.body?.state, "PATCH no devolvió la base necesaria para resolver el conflicto CAS");
const validPatch = await request(`/api/projects/${id}`, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", name: "API smoke guardado", state: project.body.state, expectedVersion: project.body.version}),
});
assert(validPatch.response.ok && validPatch.body?.version === project.body.version + 1, "PATCH válido no incrementó la versión");
const projectAfterPatch = await request(`/api/projects/${id}?token=${token}`);
assert(projectAfterPatch.response.ok, "No se pudo comprobar la identidad pública del último guardado");
assert(projectAfterPatch.body?.updatedBy !== "api-smoke-client", "GET /api/projects expuso el clientId reutilizable mediante updatedBy");
assert(
  projectAfterPatch.body?.updatedBy === undefined || String(projectAfterPatch.body.updatedBy).startsWith("peer:"),
  "updatedBy debe omitirse o usar el mismo alias opaco que miembros y eventos",
);
const assetAfterSnapshot = await request(assetPath);
assert(assetAfterSnapshot.response.ok, "Un snapshot concurrente eliminó un asset retenido");
const missingAssetState = {...project.body.state, assets: [{assetId: "missing_asset_123456", dataFormat: "svg", assetType: "ImageVector", byteLength: 10}]};
const missingAssetPatch = await request(`/api/projects/${id}`, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", name: "Asset ausente", state: missingAssetState, expectedVersion: validPatch.body.version}),
});
assert(missingAssetPatch.response.status === 424 && missingAssetPatch.body?.missingAssets?.includes("missing_asset_123456"), "PATCH aceptó un manifiesto con assets ausentes");
const unsafeCounters = await request(`/api/projects/${id}`, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", name: "Contadores inválidos", state: {...project.body.state, eventSeq: 1e308, structuralVersion: Number.MAX_SAFE_INTEGER}, expectedVersion: validPatch.body.version}),
});
assert(unsafeCounters.response.status === 413, "PATCH aceptó contadores que rompen la precisión o el cursor");
const futureCursor = await request(`/api/projects/${id}`, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", name: "Cursor acotado", state: {...project.body.state, eventSeq: Number.MAX_SAFE_INTEGER - 1}, expectedVersion: validPatch.body.version}),
});
assert(futureCursor.response.ok, "PATCH no pudo normalizar un cursor futuro pero seguro");
const clampedProject = await request(`/api/projects/${id}?token=${token}`);
assert(clampedProject.body?.state?.eventSeq === secondEvent.body.seq, "El servidor guardó un eventSeq superior al log real");
const oversizedState = await request(`/api/projects/${id}`, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({token, clientId: "api-smoke-client", name: "Demasiado grande", state: {...project.body.state, projectJson: "x".repeat(1_500_001)}, expectedVersion: futureCursor.body.version}),
});
assert(oversizedState.response.status === 413, "PATCH aceptó un estado que excede el límite D1");

const events = await request(`/api/projects/${id}/events?token=${token}&after=0`);
assert(events.response.ok && events.body?.events?.length === 2 && events.body.events[0].seq === validEvent.body.seq && events.body.events[1].seq === secondEvent.body.seq, "El registro ordenado/idempotente no coincide");

const anonymousProfile = await request("/api/profile");
assert(anonymousProfile.response.status === 401, "El perfil se expuso sin sesión");
const unprofiledEmail = `unprofiled-${crypto.randomUUID()}@example.com`;
const unprofiledHeaders = {
  ...jsonHeaders,
  "oai-authenticated-user-email": unprofiledEmail,
};
const unprofiledComment = await request(`/api/projects/${id}`, {
  method: "POST",
  headers: unprofiledHeaders,
  body: JSON.stringify({action: "comment", token, clientId: "unprofiled-comment", message: "Identidad sin perfil"}),
});
assert(unprofiledComment.response.status === 201, "No se pudo comprobar la identidad autenticada sin perfil");
assert(
  !String(unprofiledComment.body?.comment?.author ?? "").toLowerCase().includes(unprofiledEmail.toLowerCase()),
  "Un comentario autenticado sin perfil expuso el correo del usuario",
);
const unprofiledPresence = await request(`/api/projects/${id}`, {
  method: "POST",
  headers: unprofiledHeaders,
  body: JSON.stringify({action: "presence", token, clientId: "unprofiled-presence", cursorX: 25, cursorY: 30}),
});
assert(unprofiledPresence.response.ok, "No se pudo comprobar la presencia autenticada sin perfil");
const unprofiledProject = await request(`/api/projects/${id}?token=${token}&viewer=unprofiled-presence`);
const unprofiledMember = unprofiledProject.body?.members?.find(member => member.clientId === "unprofiled-presence");
assert(unprofiledMember, "La presencia autenticada sin perfil no quedó visible");
assert(
  !String(unprofiledMember.name ?? "").toLowerCase().includes(unprofiledEmail.toLowerCase()),
  "La presencia autenticada sin perfil expuso el correo del usuario",
);
const authHeaders = {
  ...jsonHeaders,
  "oai-authenticated-user-email": `api-smoke-${crypto.randomUUID()}@example.com`,
  "oai-authenticated-user-full-name": "API%20Smoke",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};
const nullProfile = await request("/api/profile", {method: "PUT", headers: authHeaders, body: "null"});
assert(nullProfile.response.status === 400, "PUT /api/profile no rechazó JSON null con sesión");
const oversizedProfile = await request("/api/profile", {method: "PUT", headers: authHeaders, body: JSON.stringify({displayName: "API", handle: "api_smoke", filler: "x".repeat(8_100)})});
assert(oversizedProfile.response.status === 413, "PUT /api/profile cargó un cuerpo por encima del límite");
const handle = `smoke_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const savedProfile = await request("/api/profile", {method: "PUT", headers: authHeaders, body: JSON.stringify({displayName: "API Smoke", handle})});
assert(savedProfile.response.ok && savedProfile.body?.profile?.handle === handle, "No se guardó el perfil autenticado");
const verifiedComment = await request(`/api/projects/${id}`, {
  method: "POST", headers: authHeaders,
  body: JSON.stringify({action: "comment", token, clientId: "verified-smoke", name: "Nombre falsificado", color: "#000000", message: "Identidad verificada"}),
});
assert(verifiedComment.response.status === 201 && verifiedComment.body?.comment?.author === "API Smoke" && verifiedComment.body?.comment?.color === savedProfile.body.profile.avatarColor, "El servidor confió en una identidad autenticada enviada por el cliente");

console.log(JSON.stringify({projectId: id, eventSeqs: [validEvent.body.seq, secondEvent.body.seq], assetBytes: originalBytes.byteLength, assetLimit: true, atomicQuota, boundedJson: true, conditionalState: true, cas: true, auth: true, cursorZero: true, validators: true}, null, 2));
