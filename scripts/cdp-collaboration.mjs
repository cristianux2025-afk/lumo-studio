const endpoint = "http://localhost:9223";
const appUrl = process.argv[2] ?? "http://localhost:4173/";
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const testForwardedFor = `198.51.100.${Math.floor(Math.random() * 254) + 1}`;

class PageSession {
  constructor(target, socket) {
    this.target = target;
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const {resolve, reject} = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }

  async waitFor(expression, label, timeout = 25_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await this.evaluate(`Boolean(${expression})`)) return;
      await delay(250);
    }
    throw new Error(`Tiempo agotado esperando: ${label}`);
  }

  async click(selector, index = 0, button = "left") {
    const rect = await this.evaluate(`(() => {
      const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!element) return null;
      element.scrollIntoView({block: "center", inline: "center"});
      const rect = element.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    })()`);
    if (!rect) throw new Error(`No existe el elemento ${selector}[${index}]`);
    await this.send("Input.dispatchMouseEvent", {type: "mousePressed", x: rect.x, y: rect.y, button, clickCount: 1});
    await this.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: rect.x, y: rect.y, button, clickCount: 1});
  }

  async setInput(selector, value) {
    const changed = await this.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLInputElement)) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", {bubbles: true}));
      input.dispatchEvent(new Event("change", {bubbles: true}));
      return true;
    })()`);
    if (!changed) throw new Error(`No existe el input ${selector}`);
  }

  async drag(sourceSelector, targetSelector) {
    const points = await this.evaluate(`(() => {
      const source = document.querySelector(${JSON.stringify(sourceSelector)});
      const target = document.querySelector(${JSON.stringify(targetSelector)});
      if (!source || !target) return null;
      const a = source.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      return {from: {x: a.left + Math.min(28, a.width / 2), y: a.top + Math.min(18, a.height / 2)}, to: {x: b.left + b.width / 2, y: b.top + b.height / 2}};
    })()`);
    if (!points) throw new Error(`No se pudo arrastrar ${sourceSelector} hacia ${targetSelector}`);
    await this.send("Input.dispatchMouseEvent", {type: "mousePressed", x: points.from.x, y: points.from.y, button: "left", buttons: 1, clickCount: 1});
    for (let step = 1; step <= 12; step += 1) {
      const ratio = step / 12;
      await this.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: points.from.x + (points.to.x - points.from.x) * ratio, y: points.from.y + (points.to.y - points.from.y) * ratio, button: "left", buttons: 1});
      await delay(20);
    }
    await this.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: points.to.x, y: points.to.y, button: "left", buttons: 0, clickCount: 1});
  }

  async close() {
    await Promise.race([this.send("Target.closeTarget", {targetId: this.target.id}).catch(() => {}), delay(1000)]);
    this.socket.close();
  }
}

async function openPage(url) {
  const target = await fetch(`${endpoint}/json/new?about%3Ablank`, {method: "PUT"}).then(response => response.json());
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
  const page = new PageSession(target, socket);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("Network.setExtraHTTPHeaders", {headers: {"X-Forwarded-For": testForwardedFor}});
  await page.send("Page.navigate", {url});
  await page.waitFor(`document.querySelector('.engine-note')?.textContent?.includes('60 TPS')`, "Scratch VM listo");
  return page;
}

async function installPatchGate(page) {
  await page.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    let unblock;
    const barrier = new Promise(resolve => { unblock = resolve; });
    const gate = {
      waiting: 0,
      released: false,
      requests: [],
      release() {
        if (gate.released) return;
        gate.released = true;
        unblock();
      },
    };
    window.__LUMO_PATCH_GATE__ = gate;
    window.fetch = (input, init = {}) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const path = new URL(requestUrl, location.href).pathname;
      if (method === "PATCH" && /^\\/api\\/projects\\/[^/]+$/.test(path)) {
        let body = null;
        try {
          if (typeof init.body === "string") body = JSON.parse(init.body);
        } catch {}
        gate.waiting += 1;
        gate.requests.push({expectedVersion: body?.expectedVersion, structuralVersion: body?.state?.structuralVersion});
        return barrier.then(() => nativeFetch(input, init));
      }
      return nativeFetch(input, init);
    };
  })()`);
}

const first = await openPage(appUrl);
let second;
try {
  const initialIds = await first.evaluate(`({workspace: window.__LUMO_TEST__.workspace.getAllBlocks(false).map(block => block.id), vm: Object.keys(window.__LUMO_TEST__.vm.editingTarget.blocks._blocks)})`);
  if (!initialIds.workspace.includes("lumo_move") || !initialIds.vm.includes("lumo_move")) throw new Error(`IDs Blockly/VM divergentes: ${JSON.stringify(initialIds)}`);
  const mediaMerge = await first.evaluate(`(() => {
    const target = (costumes, sounds) => ({isStage: false, name: "Lumi", lumoTargetId: "sprite-stable", costumes, sounds, blocks: {}});
    const costume = (id, name) => ({lumoMediaId: id, assetId: "shared-costume-asset", name, dataFormat: "svg"});
    const sound = (id, name) => ({lumoMediaId: id, assetId: "shared-sound-asset", name, dataFormat: "wav"});
    const state = projectJson => ({blocksXml: "", projectJson: JSON.stringify(projectJson), eventSeq: 0, structuralVersion: 1, assets: [], selectedSprite: "Lumi", stageBackdrop: "", activity: []});
    const base = state({targets: [target([costume("costume-base", "Traje")], [sound("sound-base", "Sonido")])]});
    const local = state({targets: [target([costume("costume-base", "Traje"), costume("costume-local", "Traje 2")], [sound("sound-base", "Sonido"), sound("sound-local", "Sonido 2")])]});
    const remote = state({targets: [target([costume("costume-base", "Traje"), costume("costume-remote", "Traje 2")], [sound("sound-base", "Sonido"), sound("sound-remote", "Sonido 2")])]});
    const merged = JSON.parse(window.__LUMO_TEST__.mergeProjectStates(base, local, remote).projectJson).targets[0];
    return {costumes: merged.costumes.map(item => item.lumoMediaId), sounds: merged.sounds.map(item => item.lumoMediaId)};
  })()`);
  if (new Set(mediaMerge.costumes).size !== 3 || new Set(mediaMerge.sounds).size !== 3) {
    throw new Error(`El merge colapsó medios que comparten assetId: ${JSON.stringify(mediaMerge)}`);
  }
  console.log("[collab] medios duplicados conservan identidad estable");
  await first.click(".invite-button");
  await first.waitFor(`location.search.includes('project=') && document.querySelector('.invite-modal')`, "enlace de invitación");
  const inviteUrl = await first.evaluate("location.href");
  await first.click(".modal-close");
  console.log("[collab] enlace creado");

  second = await openPage(inviteUrl);
  await second.waitFor(`document.querySelectorAll('.sprite-card').length === 1 && !document.querySelector('.error-banner')`, "proyecto invitado cargado");
  const [firstClientId, secondClientId] = await Promise.all([first.evaluate("window.__LUMO_TEST__.clientId"), second.evaluate("window.__LUMO_TEST__.clientId")]);
  if (!firstClientId || firstClientId === secondClientId) throw new Error("Las pestañas comparten el mismo clientId");
  console.log("[collab] segundo usuario conectado");

  const parsed = new URL(inviteUrl);
  const projectId = parsed.searchParams.get("project");
  const token = parsed.searchParams.get("invite");
  const projectApi = `${appUrl}api/projects/${projectId}?token=${encodeURIComponent(token)}`;
  const baselineProject = await fetch(projectApi, {cache: "no-store"}).then(response => response.json());
  const originalName = await first.evaluate("window.__LUMO_TEST__.vm.runtime.targets.find(target => target.isOriginal !== false && !target.isStage).sprite.name");

  await second.click(".sprite-card", 0);
  await Promise.all([installPatchGate(first), installPatchGate(second)]);
  await Promise.all([
    first.click(".add-sprite"),
    second.setInput(".sprite-properties label:nth-child(1) input", "137"),
  ]);
  await Promise.all([
    first.waitFor("window.__LUMO_PATCH_GATE__?.waiting >= 1", "PATCH estructural de la primera pestaña", 10_000),
    second.waitFor("window.__LUMO_PATCH_GATE__?.waiting >= 1", "PATCH estructural de la segunda pestaña", 10_000),
  ]);
  const [firstExpectedVersion, secondExpectedVersion] = await Promise.all([
    first.evaluate("window.__LUMO_PATCH_GATE__.requests[0]?.expectedVersion"),
    second.evaluate("window.__LUMO_PATCH_GATE__.requests[0]?.expectedVersion"),
  ]);
  if (firstExpectedVersion !== baselineProject.version || secondExpectedVersion !== baselineProject.version) {
    throw new Error(`No se forzó el mismo expectedVersion: ${JSON.stringify({baseline: baselineProject.version, firstExpectedVersion, secondExpectedVersion})}`);
  }
  await Promise.all([
    first.evaluate("window.__LUMO_PATCH_GATE__.release()"),
    second.evaluate("window.__LUMO_PATCH_GATE__.release()"),
  ]);
  const converged = `(() => {
    const targets = window.__LUMO_TEST__.vm.runtime.targets.filter(target => target.isOriginal !== false && !target.isStage);
    const original = targets.find(target => target.sprite?.name === ${JSON.stringify(originalName)});
    return targets.length === 2 && targets.some(target => target.sprite?.name === "Objeto 2") && Math.round(original?.x ?? Number.NaN) === 137;
  })()`;
  await Promise.all([
    first.waitFor(converged, "merge concurrente en la primera pestaña", 30_000),
    second.waitFor(converged, "merge concurrente en la segunda pestaña", 30_000),
  ]);
  const [firstRequests, secondRequests, concurrentProject] = await Promise.all([
    first.evaluate("window.__LUMO_PATCH_GATE__.requests"),
    second.evaluate("window.__LUMO_PATCH_GATE__.requests"),
    fetch(projectApi, {cache: "no-store"}).then(response => response.json()),
  ]);
  const patchAttempts = [...firstRequests, ...secondRequests];
  if (!patchAttempts.some(item => item.expectedVersion > baselineProject.version)) {
    throw new Error(`No se observó el reintento tras el 409: ${JSON.stringify(patchAttempts)}`);
  }
  const persisted = JSON.parse(concurrentProject.state.projectJson);
  const persistedSprites = persisted.targets.filter(target => !target.isStage);
  const persistedOriginal = persistedSprites.find(target => target.name === originalName);
  if (persistedSprites.length !== 2 || !persistedSprites.some(target => target.name === "Objeto 2") || Math.round(persistedOriginal?.x ?? Number.NaN) !== 137) {
    throw new Error("El snapshot fusionado perdió una edición concurrente");
  }
  if (concurrentProject.version < baselineProject.version + 2) throw new Error("El conflicto CAS no produjo guardado y reintento");
  console.log("[collab] snapshots estructurales concurrentes fusionados");

  const renameBaseline = await fetch(projectApi, {cache: "no-store"}).then(response => response.json());
  await Promise.all([first.click(".sprite-card", 0), second.click(".sprite-card", 0)]);
  await Promise.all([installPatchGate(first), installPatchGate(second)]);
  await first.evaluate(`(() => {
    const vm = window.__LUMO_TEST__.vm;
    vm.renameSprite(vm.editingTarget.id, "Lumi Renombrada");
  })()`);
  await first.waitFor(`document.querySelector('.sprite-card b')?.textContent === 'Lumi Renombrada'`, "renombre local visible");
  await Promise.all([
    first.setInput(".sprite-properties label:nth-child(3) input", "111"),
    second.setInput(".sprite-properties label:nth-child(1) input", "211"),
  ]);
  await Promise.all([
    first.waitFor("window.__LUMO_PATCH_GATE__?.waiting >= 1", "PATCH del renombre", 10_000),
    second.waitFor("window.__LUMO_PATCH_GATE__?.waiting >= 1", "PATCH de la propiedad remota", 10_000),
  ]);
  const renameExpectedVersions = await Promise.all([
    first.evaluate("window.__LUMO_PATCH_GATE__.requests[0]?.expectedVersion"),
    second.evaluate("window.__LUMO_PATCH_GATE__.requests[0]?.expectedVersion"),
  ]);
  if (!renameExpectedVersions.every(value => value === renameBaseline.version)) {
    throw new Error(`El conflicto de renombre no partió de la misma base: ${JSON.stringify(renameExpectedVersions)}`);
  }
  await Promise.all([
    first.evaluate("window.__LUMO_PATCH_GATE__.release()"),
    second.evaluate("window.__LUMO_PATCH_GATE__.release()"),
  ]);
  const renameConverged = `(() => {
    const target = window.__LUMO_TEST__.vm.runtime.targets.find(item => item.sprite?.name === 'Lumi Renombrada');
    return target && Math.round(target.x) === 211 && Math.round(target.size) === 111;
  })()`;
  await Promise.all([
    first.waitFor(renameConverged, "renombre y propiedad remota en la primera pestaña", 30_000),
    second.waitFor(renameConverged, "renombre y propiedad remota en la segunda pestaña", 30_000),
  ]);
  const renamedProject = await fetch(projectApi, {cache: "no-store"}).then(response => response.json());
  const renamedJson = JSON.parse(renamedProject.state.projectJson);
  const renamedTarget = renamedJson.targets.find(target => target.name === "Lumi Renombrada");
  const stableIds = renamedJson.targets.filter(target => !target.isStage).map(target => target.lumoTargetId);
  if (!renamedTarget || Math.round(renamedTarget.x) !== 211 || Math.round(renamedTarget.size) !== 111 || stableIds.some(id => typeof id !== "string") || new Set(stableIds).size !== stableIds.length) {
    throw new Error("El merge por identidad estable perdió el renombre o una propiedad concurrente");
  }
  console.log("[collab] renombre concurrente fusionado por ID estable");

  await first.click(".sprite-card", 1);
  await first.click(".editor-tabs button", 1);
  await first.click(".panel-primary");
  await first.waitFor(`document.querySelectorAll('.asset-card').length === 2`, "disfraz local creado");
  await second.click(".sprite-card", 1);
  await second.click(".editor-tabs button", 1);
  await second.waitFor(`document.querySelectorAll('.asset-card').length === 2`, "disfraz y bytes remotos cargados");
  console.log("[collab] disfraz sincronizado");

  await first.click(".editor-tabs button", 0);
  await second.click(".editor-tabs button", 0);
  await first.click(".sprite-card", 0);
  await second.click(".sprite-card", 1);
  const blockState = await first.evaluate(`(() => {
    const workspace = window.__LUMO_TEST__.workspace.getAllBlocks(false).map(block => ({id: block.id, type: block.type}));
    const vm = Object.entries(window.__LUMO_TEST__.vm.editingTarget.blocks._blocks).map(([id, block]) => ({id, type: block.opcode}));
    const targetId = window.__LUMO_TEST__.vm.editingTarget.id;
    return {workspace, vm, targetId, stableTargetId: window.__LUMO_TEST__.targetStableIds.get(targetId), targetName: window.__LUMO_TEST__.vm.editingTarget.sprite.name};
  })()`);
  if (!blockState.stableTargetId) throw new Error("El target de bloques no tiene identidad persistente");
  const moveBlock = blockState.workspace.find(block => block.type === "motion_movesteps");
  if (!moveBlock || !blockState.vm.some(block => block.id === moveBlock.id && block.type === "motion_movesteps")) throw new Error(`Workspace/VM divergieron antes de editar: ${JSON.stringify(blockState)}`);
  // Blockly flushes its event queue through requestAnimationFrame. Activate the
  // page that is being edited so headless Chrome does not suspend that frame as
  // it would for a background tab a real user cannot interact with.
  await first.send("Page.bringToFront");
  await first.evaluate(`(() => {
    const {ScratchBlocks, workspace} = window.__LUMO_TEST__;
    const xml = ScratchBlocks.utils.xml.textToDom('<xml xmlns="https://developers.google.com/blockly/xml"><block type="motion_turnright" id="collab_turn" x="48" y="230"><value name="DEGREES"><shadow type="math_number" id="collab_degrees"><field name="NUM">15</field></shadow></value></block></xml>');
    ScratchBlocks.Xml.domToWorkspace(xml, workspace);
  })()`);
  await first.waitFor(`Object.values(window.__LUMO_TEST__.vm.runtime.getTargetById(${JSON.stringify(blockState.targetId)}).blocks._blocks).some(block => block.opcode === 'motion_turnright')`, "bloque local creado", 3000);
  await delay(1200);
  await second.send("Page.bringToFront");
  await second.waitFor(`(() => { const target = window.__LUMO_TEST__.vm.runtime.targets.find(item => item.sprite?.name === ${JSON.stringify(blockState.targetName)}); return target && Object.values(target.blocks._blocks).some(block => block.opcode === 'motion_turnright') && window.__LUMO_TEST__.vm.editingTarget.id !== target.id; })()`, "operación remota aplicada en target no seleccionado");
  console.log("[collab] bloque sincronizado en target oculto");

  await first.send("Page.bringToFront");
  await first.evaluate(`window.__LUMO_TEST__.workspace.getBlockById('collab_turn').dispose(true)`);
  await first.waitFor(`!Object.values(window.__LUMO_TEST__.vm.runtime.getTargetById(${JSON.stringify(blockState.targetId)}).blocks._blocks).some(block => block.opcode === 'motion_turnright')`, "bloque local eliminado", 3000);
  await delay(1200);
  await second.send("Page.bringToFront");
  await second.waitFor(`(() => { const target = window.__LUMO_TEST__.vm.runtime.targets.find(item => item.sprite?.name === ${JSON.stringify(blockState.targetName)}); return target && !Object.values(target.blocks._blocks).some(block => block.opcode === 'motion_turnright'); })()`, "eliminación remota aplicada");
  console.log("[collab] eliminación de bloque sincronizada");

  const recoveryClientId = `recovery-${crypto.randomUUID()}`;
  let recoveryClientSeq = Date.now() * 1000;
  const postRecoveryEvent = async event => {
    const response = await fetch(`${appUrl}api/projects/${projectId}/events`, {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Forwarded-For": testForwardedFor},
      body: JSON.stringify({token, clientId: recoveryClientId, clientSeq: recoveryClientSeq++, event}),
    });
    if (response.status !== 201) throw new Error(`No se pudo preparar la recuperación de eventos: ${response.status} ${await response.text()}`);
  };
  await postRecoveryEvent({
    targetName: "Sprite eliminado",
    targetId: "target-inexistente",
    event: {type: "change", blockId: "ghost-block", element: "field", name: "TEXT", oldValue: "a", newValue: "b"},
  });
  await postRecoveryEvent({
    // Deliberately stale: applying this operation proves targetId wins over a
    // name that changed during collaboration.
    targetName: "Nombre obsoleto",
    targetId: blockState.stableTargetId,
    event: {
      type: "create",
      blockId: "after_poison_turn",
      ids: ["after_poison_turn", "after_poison_degrees"],
      xml: '<block xmlns="https://developers.google.com/blockly/xml" type="motion_turnright" id="after_poison_turn" x="96" y="280"><value name="DEGREES"><shadow type="math_number" id="after_poison_degrees"><field name="NUM">30</field></shadow></value></block>',
      json: {type: "motion_turnright", id: "after_poison_turn", x: 96, y: 280, inputs: {DEGREES: {shadow: {type: "math_number", id: "after_poison_degrees", fields: {NUM: "30"}}}}},
    },
  });
  const recoveredBlock = `(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(blockState.stableTargetId)});
    return Boolean(target?.blocks?._blocks?.after_poison_turn);
  })()`;
  await Promise.all([
    first.waitFor(recoveredBlock, "recuperación de la cola en la primera pestaña", 20_000),
    second.waitFor(recoveredBlock, "recuperación de la cola en la segunda pestaña", 20_000),
  ]);
  console.log("[collab] evento inválido aislado y target resuelto por ID");

  await first.click(".team-tabs button", 0);
  await first.setInput("input[aria-label='Nuevo comentario']", "Prueba colaborativa verificada");
  await first.click("button[aria-label='Enviar comentario']");
  await second.click(".team-tabs button", 0);
  await second.waitFor(`document.querySelector('.comments-list')?.textContent?.includes('Prueba colaborativa verificada')`, "comentario remoto");
  console.log("[collab] comentario sincronizado");

  const project = await fetch(`${appUrl}api/projects/${projectId}?token=${encodeURIComponent(token)}`, {cache: "no-store"}).then(response => response.json());
  if (project.inviteToken) throw new Error("La API expuso el token secreto");
  if (!Array.isArray(project.state.assets) || project.state.assets.length < 3) throw new Error("El manifiesto remoto no contiene los assets creados");
  for (const asset of project.state.assets) {
    const response = await fetch(`${appUrl}api/projects/${projectId}/assets/${asset.assetId}?token=${encodeURIComponent(token)}`);
    if (!response.ok || !(await response.arrayBuffer()).byteLength) throw new Error(`Asset remoto vacío: ${asset.assetId}`);
  }
  const savedProject = JSON.parse(project.state.projectJson);
  const savedLumi = savedProject.targets.find(target => target.name === blockState.targetName);
  if (savedLumi?.blocks?.collab_turn) throw new Error("La eliminación remota dejó el bloque eliminado");
  const mediaIds = savedProject.targets.flatMap(target => [...(target.costumes ?? []), ...(target.sounds ?? [])].map(item => item.lumoMediaId));
  if (mediaIds.some(id => typeof id !== "string" || !id) || new Set(mediaIds).size !== mediaIds.length) {
    throw new Error("El snapshot no conservó identidades únicas para disfraces y sonidos");
  }
  const events = await fetch(`${appUrl}api/projects/${projectId}/events?token=${encodeURIComponent(token)}&after=0`, {cache: "no-store"}).then(response => response.json());
  if (events.events.filter(event => event.payload?.event?.type === "create" && event.payload.event.blockId === "collab_turn").length !== 1 ||
      events.events.filter(event => event.payload?.event?.type === "delete" && event.payload.event.blockId === "collab_turn").length !== 1 ||
      events.events.filter(event => event.payload?.event?.blockId === "after_poison_turn" && event.payload?.targetId === blockState.stableTargetId).length !== 1 ||
      events.events.some(event => event.payload?.event?.type === "finished_loading")) {
    throw new Error("El registro de eventos contiene duplicados o eventos internos");
  }

  const result = {
    invite: {projectId, tokenLength: token.length},
    first: {
      sprites: await first.evaluate("document.querySelectorAll('.sprite-card').length"),
      costumes: await first.evaluate("window.__LUMO_TEST__.vm.runtime.targets.find(target => target.sprite?.name === 'Objeto 2').getCostumes().length"),
      exceptions: first.exceptions,
    },
    second: {
      sprites: await second.evaluate("document.querySelectorAll('.sprite-card').length"),
      costumes: await second.evaluate("window.__LUMO_TEST__.vm.runtime.targets.find(target => target.sprite?.name === 'Objeto 2').getCostumes().length"),
      commentSynced: await second.evaluate("document.querySelector('.comments-list')?.textContent?.includes('Prueba colaborativa verificada')"),
      exceptions: second.exceptions,
    },
    assets: project.state.assets.map(asset => ({assetId: asset.assetId, bytes: asset.byteLength, type: asset.assetType})),
  };
  console.log(JSON.stringify(result, null, 2));
  if (first.exceptions.length || second.exceptions.length) process.exitCode = 1;
} catch (error) {
  const diagnostics = {
    error: error instanceof Error ? error.message : String(error),
    first: await first.evaluate(`({url: location.href, toast: document.querySelector('.toast')?.textContent ?? '', error: document.querySelector('.error-banner')?.textContent ?? '', sprites: document.querySelectorAll('.sprite-card').length, ready: document.querySelector('.engine-note')?.textContent ?? ''})`).catch(() => null),
    second: second ? await second.evaluate(`({url: location.href, toast: document.querySelector('.toast')?.textContent ?? '', error: document.querySelector('.error-banner')?.textContent ?? '', sprites: document.querySelectorAll('.sprite-card').length, ready: document.querySelector('.engine-note')?.textContent ?? ''})`).catch(() => null) : null,
    exceptions: {first: first.exceptions, second: second?.exceptions ?? []},
  };
  console.error(JSON.stringify(diagnostics, null, 2));
  throw error;
} finally {
  await second?.close();
  await first.close();
}
