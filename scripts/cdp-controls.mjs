import assert from "node:assert/strict";

const appUrl = process.argv[2] ?? "http://localhost:4173/";
const endpoint = process.argv[3] ?? "http://localhost:9223";
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const target = await fetch(`${endpoint}/json/new?about%3Ablank`, {method: "PUT"}).then(response => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, {once: true});
  socket.addEventListener("error", reject, {once: true});
});

let nextId = 0;
const pending = new Map();
const diagnostics = [];
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const {resolve, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    diagnostics.push({
      type: "exception",
      text: message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text,
    });
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    diagnostics.push({
      type: "console-error",
      text: message.params.args.map(argument => argument.description ?? argument.value).join(" "),
    });
  }
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    diagnostics.push({type: "log-error", text: message.params.entry.text});
  }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params}));
});

const evaluate = async (expression, userGesture = false) => {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
};

const waitUntil = async (probe, label, timeout = 25_000) => {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await probe();
    if (lastValue) return lastValue;
    await delay(100);
  }
  throw new Error(`Tiempo agotado esperando ${label}; ultimo valor: ${JSON.stringify(lastValue)}`);
};

const click = (selector, userGesture = false) => evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!(element instanceof HTMLElement) || element.matches(':disabled')) return false;
  element.click();
  return true;
})()`, userGesture);

const clickText = (containerSelector, text, userGesture = false) => evaluate(`(() => {
  const container = document.querySelector(${JSON.stringify(containerSelector)});
  const button = [...(container?.querySelectorAll('button') ?? [])]
    .find(candidate => candidate.textContent?.includes(${JSON.stringify(text)}));
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`, userGesture);

const cardAction = (name, action, userGesture = false) => evaluate(`(() => {
  const card = [...document.querySelectorAll('article.asset-card')]
    .find(candidate => candidate.querySelector(':scope > strong')?.textContent === ${JSON.stringify(name)});
  const button = [...(card?.querySelectorAll('button') ?? [])]
    .find(candidate => candidate.textContent?.includes(${JSON.stringify(action)}));
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`, userGesture);

const setInput = (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!(input instanceof HTMLInputElement)) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()`);

const mediaState = () => evaluate(`(() => {
  const vm = window.__LUMO_TEST__?.vm;
  const stage = vm?.runtime?.getTargetForStage?.();
  const sprite = vm?.runtime?.targets?.find(target => target.isOriginal !== false && !target.isStage);
  return {
    sprites: vm?.runtime?.targets?.filter(target => target.isOriginal !== false && !target.isStage).length ?? -1,
    spriteCostumes: sprite?.getCostumes?.().map(costume => costume.name) ?? [],
    currentCostume: sprite?.currentCostume ?? -1,
    backdrops: stage?.getCostumes?.().map(backdrop => backdrop.name) ?? [],
    currentBackdrop: stage?.currentCostume ?? -1,
    sounds: sprite?.getSounds?.().map(sound => ({
      name: sound.name,
      rate: Number(sound.rate ?? 0),
      sampleCount: Number(sound.sampleCount ?? 0),
      broken: Boolean(sound.broken),
      bytes: Number(sound.asset?.data?.byteLength ?? 0),
    })) ?? [],
  };
})()`);

const uploadInvalidWav = () => evaluate(`(() => {
  const input = document.querySelector('input[accept*="audio/wav"]');
  if (!(input instanceof HTMLInputElement)) return false;
  const transfer = new DataTransfer();
  transfer.items.add(new File([new Uint8Array([1, 2, 3, 4, 5])], 'roto.wav', {type: 'audio/wav'}));
  Object.defineProperty(input, 'files', {configurable: true, value: transfer.files});
  input.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()`);

const uploadValidWav = () => evaluate(`(() => {
  const input = document.querySelector('input[accept*="audio/wav"]');
  if (!(input instanceof HTMLInputElement)) return false;
  const sampleRate = 8000;
  const sampleCount = 800;
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(44 + index * 2, Math.sin(index / 10) * 12000, true);
  }
  const transfer = new DataTransfer();
  transfer.items.add(new File([buffer], 'tono.wav', {type: 'audio/wav'}));
  Object.defineProperty(input, 'files', {configurable: true, value: transfer.files});
  input.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()`);

const result = {};

try {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Page.navigate", {url: appUrl});
  await waitUntil(
    () => evaluate(`Boolean(window.__LUMO_TEST__ && document.querySelector('.add-sprite:not(:disabled)'))`),
    "el estudio",
    35_000,
  );

  assert.equal(await click(".add-sprite"), true);
  await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-testid="image-editor"]'))`), "el primer sprite");
  assert.equal(await click('[aria-label="Cerrar editor"]'), true);
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"]')`), "cerrar el editor");

  const localCancel = await evaluate(`(() => {
    window.__lumoConfirmCalls = 0;
    window.confirm = () => { window.__lumoConfirmCalls += 1; return false; };
    document.querySelector('[aria-label="Crear proyecto nuevo"]')?.click();
    return true;
  })()`);
  assert.equal(localCancel, true);
  await delay(350);
  result.localNewCancel = await evaluate(`({
    confirmCalls: window.__lumoConfirmCalls,
    sprites: window.__LUMO_TEST__?.vm?.runtime?.targets?.filter(target => target.isOriginal !== false && !target.isStage).length ?? -1,
  })`);
  assert.equal(result.localNewCancel.confirmCalls, 1, "Nuevo debe confirmar antes de borrar trabajo local");
  assert.equal(result.localNewCancel.sprites, 1, "Cancelar Nuevo debe conservar el sprite local");

  assert.equal(await clickText(".editor-tabs", "Disfraces"), true);
  const initialCostume = (await mediaState()).spriteCostumes[0];
  assert.ok(initialCostume);
  assert.equal(await click(".left-panel .panel-primary"), true);
  await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-testid="image-editor-save"]:not(:disabled)'))`), "el disfraz nuevo");
  assert.equal(await click('[data-testid="image-editor-save"]'), true);
  await waitUntil(async () => (
    !await evaluate(`Boolean(document.querySelector('[data-testid="image-editor"]'))`) &&
    (await mediaState()).spriteCostumes.length === 2
  ), "guardar el disfraz");
  const secondCostume = (await mediaState()).spriteCostumes[1];
  await evaluate(`window.prompt = () => 'Disfraz control'`);
  assert.equal(await cardAction(secondCostume, "Renombrar"), true);
  await waitUntil(async () => (await mediaState()).spriteCostumes.includes("Disfraz control"), "renombrar el disfraz");
  assert.equal(await cardAction(initialCostume, "Usar"), true);
  await waitUntil(async () => (await mediaState()).currentCostume === 0, "usar el primer disfraz");
  assert.equal(await cardAction("Disfraz control", "Usar"), true);
  await waitUntil(async () => (await mediaState()).currentCostume === 1, "usar el segundo disfraz");

  assert.equal(await clickText(".editor-tabs", "Fondos"), true);
  const initialBackdrop = (await mediaState()).backdrops[0];
  assert.equal(await click(".left-panel .panel-primary"), true);
  await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-testid="image-editor-save"]:not(:disabled)'))`), "el fondo nuevo");
  assert.equal(await click('[data-testid="image-editor-save"]'), true);
  await waitUntil(async () => (
    !await evaluate(`Boolean(document.querySelector('[data-testid="image-editor"]'))`) &&
    (await mediaState()).backdrops.length === 2
  ), "guardar el fondo");
  const secondBackdrop = (await mediaState()).backdrops[1];
  await evaluate(`window.prompt = () => 'Fondo control'`);
  assert.equal(await cardAction(secondBackdrop, "Renombrar"), true);
  await waitUntil(async () => (await mediaState()).backdrops.includes("Fondo control"), "renombrar el fondo");
  assert.equal(await cardAction(initialBackdrop, "Usar"), true);
  await waitUntil(async () => (await mediaState()).currentBackdrop === 0, "usar el primer fondo");
  assert.equal(await cardAction("Fondo control", "Usar"), true);
  await waitUntil(async () => (await mediaState()).currentBackdrop === 1, "usar el segundo fondo");

  assert.equal(await click(".sprite-card"), true);
  assert.equal(await clickText(".editor-tabs", "Sonidos"), true);
  await waitUntil(() => evaluate(`!document.querySelector('.toast')`), "ocultar mensajes previos");
  assert.equal(await uploadInvalidWav(), true);
  const invalidSound = await waitUntil(async () => {
    const state = await mediaState();
    const toast = await evaluate(`document.querySelector('.toast')?.textContent?.trim() ?? ''`);
    return state.sounds.length > 0 || toast ? {state, toast} : null;
  }, "rechazar el WAV invalido", 8_000);
  result.invalidSound = {count: invalidSound.state.sounds.length, toast: invalidSound.toast};
  assert.equal(invalidSound.state.sounds.length, 0, "Un WAV invalido no debe crear una tarjeta reproducible");
  assert.match(invalidSound.toast, /sonido|audio|wav|decodificar|valido/i);

  await waitUntil(() => evaluate(`!document.querySelector('.toast')`), "ocultar el error del WAV");
  assert.equal(await uploadValidWav(), true);
  const validSound = await waitUntil(async () => {
    const state = await mediaState();
    const sound = state.sounds[0];
    return sound?.rate > 0 && sound.sampleCount > 1 ? sound : null;
  }, "decodificar el WAV valido");
  assert.equal(validSound.broken, false);
  assert.ok(validSound.bytes > 44);
  assert.equal(await cardAction("tono", "Oír", true), true);
  await delay(300);
  assert.doesNotMatch(await evaluate(`document.querySelector('.toast')?.textContent ?? ''`), /bloqueo el audio/i);
  await evaluate(`window.prompt = () => 'Tono control'`);
  assert.equal(await cardAction("tono", "Renombrar"), true);
  await waitUntil(async () => (await mediaState()).sounds[0]?.name === "Tono control", "renombrar el sonido");

  result.beforeExport = await mediaState();
  await evaluate(`(() => {
    window.__lumoExportBlob = null;
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      window.__lumoExportBlob = blob;
      return original(blob);
    };
    return true;
  })()`);
  assert.equal(await clickText(".top-actions", "Exportar", true), true);
  result.exported = await waitUntil(() => evaluate(`(async () => {
    const blob = window.__lumoExportBlob;
    if (!(blob instanceof Blob) || !blob.size) return null;
    return {size: blob.size, type: blob.type, header: [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())]};
  })()`), "exportar el SB3");
  assert.ok(result.exported.size > 500);
  assert.deepEqual(result.exported.header.slice(0, 2), [0x50, 0x4b], "El SB3 exportado debe ser un ZIP");

  await evaluate(`(() => {
    window.__lumoCopiedInvite = '';
    window.__lumoInvitePatchFailures = 0;
    window.__lumoOriginalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (window.__lumoInvitePatchFailures === 0 && init?.method === 'PATCH' && /\\/api\\/projects\\/[^/]+$/.test(new URL(url, location.href).pathname)) {
        window.__lumoInvitePatchFailures += 1;
        return new Response(JSON.stringify({error: 'Fallo canónico simulado'}), {
          status: 413,
          headers: {'Content-Type': 'application/json'},
        });
      }
      return window.__lumoOriginalFetch(input, init);
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {writeText: async value => { window.__lumoCopiedInvite = value; }},
    });
    return true;
  })()`);
  assert.equal(await click(".invite-button", true), true);
  result.partialInviteFailure = await waitUntil(() => evaluate(`(() => {
    const toast = document.querySelector('.toast')?.textContent?.trim() ?? '';
    return window.__lumoInvitePatchFailures === 1 && /no pudimos crear la invitación/i.test(toast)
      ? {toast, url: location.href, modalOpen: Boolean(document.querySelector('.invite-modal'))}
      : null;
  })()`), "rechazar la invitación sin snapshot canónico", 35_000);
  assert.equal(new URL(result.partialInviteFailure.url).search, "", "El primer fallo no debe publicar el enlace");
  assert.equal(result.partialInviteFailure.modalOpen, false);

  assert.equal(await click(".invite-button", true), true);
  result.inviteUrl = await waitUntil(() => evaluate(`(() => {
    const input = document.querySelector('.invite-link input');
    return location.search.includes('project=') && input?.value ? input.value : '';
  })()`), "crear la invitacion", 35_000);
  assert.equal(result.inviteUrl, await evaluate("location.href"));
  const canonicalInvite = new URL(result.inviteUrl);
  const canonicalProject = await fetch(new URL(`/api/projects/${canonicalInvite.searchParams.get("project")}?token=${encodeURIComponent(canonicalInvite.searchParams.get("invite") ?? "")}`, appUrl)).then(response => response.json());
  const canonicalProjectJson = JSON.parse(canonicalProject.state?.projectJson ?? "{}");
  const canonicalMedia = (canonicalProjectJson.targets ?? []).flatMap(target => [...(target.costumes ?? []), ...(target.sounds ?? [])]);
  result.partialInviteRetry = {
    version: canonicalProject.version,
    assets: canonicalProject.state?.assets?.length ?? 0,
    projectJson: Boolean(canonicalProject.state?.projectJson),
    media: canonicalMedia.length,
    uniqueMediaAssets: new Set(canonicalMedia.map(media => media.assetId)).size,
  };
  assert.ok(result.partialInviteRetry.version >= 2, "El reintento debe confirmar una versión canónica");
  const expectedActiveAssets = result.beforeExport.spriteCostumes.length + result.beforeExport.backdrops.length + result.beforeExport.sounds.length;
  assert.equal(result.partialInviteRetry.media, expectedActiveAssets, "El snapshot canónico debe conservar todos los recursos activos");
  assert.equal(result.partialInviteRetry.assets, result.partialInviteRetry.uniqueMediaAssets, "El manifiesto debe incluir cada blob referenciado");
  assert.equal(result.partialInviteRetry.projectJson, true);
  await evaluate(`window.__lumoCopiedInvite = ''`);
  assert.equal(await clickText(".invite-link", "Copiar", true), true);
  await waitUntil(() => evaluate(`window.__lumoCopiedInvite === document.querySelector('.invite-link input')?.value`), "copiar la invitacion");
  assert.equal(await click(".modal-close"), true);

  const sharedCancel = await evaluate(`(() => {
    window.__lumoConfirmCalls = 0;
    window.confirm = () => { window.__lumoConfirmCalls += 1; return false; };
    document.querySelector('[aria-label="Crear proyecto nuevo"]')?.click();
    return true;
  })()`);
  assert.equal(sharedCancel, true);
  await delay(350);
  result.sharedNewCancel = await evaluate(`({
    confirmCalls: window.__lumoConfirmCalls,
    project: new URL(location.href).searchParams.get('project'),
    sprites: window.__LUMO_TEST__?.vm?.runtime?.targets?.filter(target => target.isOriginal !== false && !target.isStage).length ?? -1,
  })`);
  assert.equal(result.sharedNewCancel.confirmCalls, 1);
  assert.ok(result.sharedNewCancel.project);
  assert.equal(result.sharedNewCancel.sprites, 1);

  assert.equal(await cardAction("Tono control", "Eliminar"), true);
  await waitUntil(async () => (await mediaState()).sounds.length === 0, "eliminar el sonido");
  assert.equal(await clickText(".editor-tabs", "Disfraces"), true);
  assert.equal(await cardAction("Disfraz control", "Eliminar"), true);
  await waitUntil(async () => (await mediaState()).spriteCostumes.length === 1, "eliminar el disfraz");
  assert.equal(await clickText(".editor-tabs", "Fondos"), true);
  assert.equal(await cardAction("Fondo control", "Eliminar"), true);
  await waitUntil(async () => (await mediaState()).backdrops.length === 1, "eliminar el fondo");

  await evaluate(`window.confirm = () => true`);
  assert.equal(await click('[aria-label="Crear proyecto nuevo"]'), true);
  await waitUntil(async () => {
    const state = await mediaState();
    return state.sprites === 0 && state.backdrops.length === 1 && !new URL(await evaluate("location.href")).search;
  }, "crear un proyecto vacio");
  assert.equal(await evaluate(`Boolean(window.__lumoExportBlob?.size)`), true, "Nuevo no debe recargar la pagina ni perder el Blob de prueba");

  assert.equal(await evaluate(`(() => {
    const input = document.querySelector('input[accept^=".sb3"]');
    if (!(input instanceof HTMLInputElement) || !(window.__lumoExportBlob instanceof Blob)) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([window.__lumoExportBlob], 'roundtrip.sb3', {type: 'application/x.scratch.sb3'}));
    Object.defineProperty(input, 'files', {configurable: true, value: transfer.files});
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  })()`), true);
  result.afterImport = await waitUntil(async () => {
    const state = await mediaState();
    return state.sprites === 1 && state.spriteCostumes.length === 2 && state.backdrops.length === 2 && state.sounds.length === 1 ? state : null;
  }, "importar el SB3", 35_000);
  assert.ok(result.afterImport.spriteCostumes.includes("Disfraz control"));
  assert.ok(result.afterImport.backdrops.includes("Fondo control"));
  assert.equal(result.afterImport.sounds[0].name, "Tono control");
  assert.ok(result.afterImport.sounds[0].sampleCount > 1);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Nombre del proyecto"]')?.value`), "roundtrip");

  const inviteRelative = new URL(result.inviteUrl).pathname + new URL(result.inviteUrl).search;
  const loginUrl = new URL(`/login?returnTo=${encodeURIComponent(inviteRelative)}`, appUrl).href;
  await send("Network.setExtraHTTPHeaders", {headers: {}});
  await send("Page.navigate", {url: loginUrl});
  result.login = await waitUntil(() => evaluate(`(() => {
    const primary = document.querySelector('.account-primary');
    const register = document.querySelector('.account-secondary');
    const back = document.querySelector('.account-back');
    return primary && register && back ? {primary: primary.getAttribute('href'), register: register.getAttribute('href'), back: back.getAttribute('href')} : null;
  })()`), "la pagina de login");
  assert.equal(new URL(result.login.primary, appUrl).pathname, "/signin-with-chatgpt");
  assert.equal(new URL(result.login.primary, appUrl).searchParams.get("return_to"), inviteRelative);
  assert.equal(new URL(result.login.register, appUrl).searchParams.get("returnTo"), inviteRelative);
  assert.equal(result.login.back, inviteRelative);

  const email = `controls-${crypto.randomUUID()}@example.com`;
  const handle = `control_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await send("Network.setExtraHTTPHeaders", {headers: {
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": "Control%20CDP",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  }});
  // The profile write uses a unique synthetic account and returns to a fresh
  // root page. Login above already proves that invite return paths survive;
  // keeping registration at `/` makes this stateful check isolated from the
  // shared project created earlier in the test.
  const registerUrl = new URL(`/register?returnTo=${encodeURIComponent("/")}`, appUrl).href;
  await send("Page.navigate", {url: registerUrl});
  await waitUntil(() => evaluate(`Boolean(document.querySelector('.account-form'))`), "el formulario de registro");
  // The server-rendered form can appear a moment before React attaches its
  // submit handler. Clicking during that gap performs a plain GET submission.
  await delay(500);
  assert.equal(await setInput(".account-form label:nth-of-type(1) input", "Control CDP"), true);
  assert.equal(await setInput(".account-form label:nth-of-type(2) input", handle), true);
  await delay(150);
  assert.equal(await click(".account-form .account-primary", true), true);
  const registration = await waitUntil(() => evaluate(`(() => {
    const error = document.querySelector('.account-error')?.textContent?.trim() ?? '';
    if (error) return {error, url: location.href};
    if (location.pathname === '/' && !location.search && !document.querySelector('.account-form')) {
      return {error: '', url: location.href};
    }
    return null;
  })()`), "guardar el registro", 35_000);
  assert.equal(registration.error, "", `El formulario de registro fallo: ${registration.error}`);
  await waitUntil(() => evaluate(`Boolean(window.__LUMO_TEST__)`), "volver al estudio tras registrarse", 35_000);
  result.profile = await evaluate(`fetch('/api/profile').then(response => response.json())`);
  assert.equal(result.profile.profile?.handle, handle);
  assert.equal(result.profile.profile?.displayName, "Control CDP");

  result.diagnostics = diagnostics;
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(diagnostics, []);
} finally {
  await send("Target.closeTarget", {targetId: target.id}).catch(() => {});
  socket.close();
}
