const endpoint = "http://localhost:9223";
const appUrl = process.argv[2] ?? "http://localhost:4173/";
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const testForwardedFor = `198.51.100.${Math.floor(Math.random() * 254) + 1}`;
const unexpectedBrowserErrors = errors => errors.filter(message => !/status of 409 \(Conflict\)/.test(message));

class PageSession {
  constructor(target, socket) {
    this.target = target;
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.errors = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const {resolve, reject} = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.errors.push(message.params.args.map(argument => argument.description ?? argument.value).join(" "));
      } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        this.errors.push(message.params.entry.text);
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

  async clickSprite(name) {
    const index = await this.evaluate(`Array.from(document.querySelectorAll('.sprite-card')).findIndex(card => card.querySelector('b')?.textContent === ${JSON.stringify(name)})`);
    if (index < 0) throw new Error(`No existe la tarjeta del sprite ${name}`);
    await this.click(".sprite-card", index);
  }

  async drawStroke(selector) {
    const drawing = await this.evaluate(`(() => {
      const canvas = document.querySelector(${JSON.stringify(selector)});
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        before: canvas.toDataURL(),
        from: {x: rect.left + rect.width * 0.28, y: rect.top + rect.height * 0.38},
        to: {x: rect.left + rect.width * 0.72, y: rect.top + rect.height * 0.62},
      };
    })()`);
    if (!drawing) throw new Error(`No existe el lienzo ${selector}`);
    await this.send("Input.dispatchMouseEvent", {type: "mousePressed", x: drawing.from.x, y: drawing.from.y, button: "left", buttons: 1, clickCount: 1});
    for (let step = 1; step <= 16; step += 1) {
      const ratio = step / 16;
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: drawing.from.x + (drawing.to.x - drawing.from.x) * ratio,
        y: drawing.from.y + (drawing.to.y - drawing.from.y) * ratio,
        button: "left",
        buttons: 1,
      });
      await delay(12);
    }
    await this.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: drawing.to.x, y: drawing.to.y, button: "left", buttons: 0, clickCount: 1});
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})?.toDataURL() !== ${JSON.stringify(drawing.before)}`, "trazo aplicado en el editor", 5000);
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
  await page.send("Log.enable");
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
  const initialProject = await first.evaluate(`(() => {
    const {vm, workspace} = window.__LUMO_TEST__;
    const originals = vm.runtime.targets.filter(target => target.isOriginal !== false);
    const stage = originals.find(target => target.isStage);
    return {
      stageCount: originals.filter(target => target.isStage).length,
      spriteCount: originals.filter(target => !target.isStage).length,
      workspaceBlocks: workspace.getAllBlocks(false).map(block => block.id),
      stageBlocks: Object.keys(stage?.blocks?._blocks ?? {}),
      editingStage: vm.editingTarget?.isStage === true,
      targetNames: originals.map(target => target.sprite?.name ?? target.getName?.() ?? ""),
    };
  })()`);
  if (initialProject.stageCount !== 1 || initialProject.spriteCount !== 0 || initialProject.workspaceBlocks.length !== 0 || initialProject.stageBlocks.length !== 0 || !initialProject.editingStage) {
    throw new Error(`El proyecto inicial no está vacío y limitado al escenario: ${JSON.stringify(initialProject)}`);
  }
  if (initialProject.targetNames.length !== 1 || initialProject.targetNames[0] !== "Stage") throw new Error(`El escenario inicial no es neutral: ${JSON.stringify(initialProject.targetNames)}`);
  console.log("[collab] proyecto inicial Stage-only sin sprites ni bloques");

  const mediaMerge = await first.evaluate(`(() => {
    const target = (costumes, sounds, blocks = {}) => ({isStage: false, name: "Sprite base", lumoTargetId: "sprite-stable", costumes, sounds, blocks});
    const costume = (id, name) => ({lumoMediaId: id, assetId: "shared-costume-asset", name, dataFormat: "svg"});
    const sound = (id, name) => ({lumoMediaId: id, assetId: "shared-sound-asset", name, dataFormat: "wav"});
    const state = projectJson => ({blocksXml: "", projectJson: JSON.stringify(projectJson), eventSeq: 0, structuralVersion: 1, assets: [], selectedSprite: "Sprite base", stageBackdrop: "", activity: []});
    const base = state({targets: [target([costume("costume-base", "Traje")], [sound("sound-base", "Sonido")])]});
    const local = state({targets: [target(
      [costume("costume-base", "Traje"), costume("costume-local", "Traje 2")],
      [sound("sound-base", "Sonido"), sound("sound-local", "Sonido 2")],
      {
        "costume-menu-local": {opcode: "looks_costume", fields: {COSTUME: ["Traje 2", null]}},
        "sound-menu-local": {opcode: "sound_sounds_menu", fields: {SOUND_MENU: ["Sonido 2", null]}},
      },
    )]});
    const remote = state({targets: [target(
      [costume("costume-base", "Traje"), costume("costume-remote", "Traje 2")],
      [sound("sound-base", "Sonido"), sound("sound-remote", "Sonido 2")],
      {
        "costume-menu-remote": {opcode: "looks_costume", fields: {COSTUME: ["Traje 2", null]}},
        "sound-menu-remote": {opcode: "sound_sounds_menu", fields: {SOUND_MENU: ["Sonido 2", null]}},
      },
    )]});
    const merged = JSON.parse(window.__LUMO_TEST__.mergeProjectStates(base, local, remote).projectJson).targets[0];
    const costumeNames = Object.fromEntries(merged.costumes.map(item => [item.lumoMediaId, item.name]));
    const soundNames = Object.fromEntries(merged.sounds.map(item => [item.lumoMediaId, item.name]));
    return {
      costumes: merged.costumes.map(item => item.lumoMediaId),
      sounds: merged.sounds.map(item => item.lumoMediaId),
      costumeNameList: merged.costumes.map(item => item.name),
      soundNameList: merged.sounds.map(item => item.name),
      costumeRefs: [
        [merged.blocks["costume-menu-local"].lumoFieldRefs.COSTUME.id, merged.blocks["costume-menu-local"].fields.COSTUME[0]],
        [merged.blocks["costume-menu-remote"].lumoFieldRefs.COSTUME.id, merged.blocks["costume-menu-remote"].fields.COSTUME[0]],
      ],
      soundRefs: [
        [merged.blocks["sound-menu-local"].lumoFieldRefs.SOUND_MENU.id, merged.blocks["sound-menu-local"].fields.SOUND_MENU[0]],
        [merged.blocks["sound-menu-remote"].lumoFieldRefs.SOUND_MENU.id, merged.blocks["sound-menu-remote"].fields.SOUND_MENU[0]],
      ],
      costumeNames,
      soundNames,
    };
  })()`);
  if (new Set(mediaMerge.costumes).size !== 3 || new Set(mediaMerge.sounds).size !== 3 ||
      new Set(mediaMerge.costumeNameList).size !== 3 || new Set(mediaMerge.soundNameList).size !== 3 ||
      mediaMerge.costumeRefs.some(([id, name]) => mediaMerge.costumeNames[id] !== name) ||
      mediaMerge.soundRefs.some(([id, name]) => mediaMerge.soundNames[id] !== name)) {
    throw new Error(`El merge colapsó medios que comparten assetId: ${JSON.stringify(mediaMerge)}`);
  }
  console.log("[collab] medios concurrentes conservan ID, nombre único y referencias");

  const targetNameMerge = await first.evaluate(`(() => {
    const backdrop = (id, name) => ({lumoMediaId: id, assetId: "backdrop-shared", name, dataFormat: "svg"});
    const stage = costumes => ({isStage: true, name: "Stage", lumoTargetId: "stage-stable", costumes, sounds: [], blocks: {}});
    const sprite = (id, backdropName, name = "Sprite 1") => ({
      isStage: false,
      name,
      lumoTargetId: id,
      costumes: [],
      sounds: [],
      blocks: {
        ["clone-" + id]: {opcode: "control_create_clone_of_menu", fields: {CLONE_OPTION: [name, null]}},
        ["point-" + id]: {opcode: "motion_pointtowards_menu", fields: {TOWARDS: [name, null]}},
        ["backdrop-" + id]: {opcode: "event_whenbackdropswitchesto", fields: {BACKDROP: [backdropName, null]}},
        ["variable-" + id]: {opcode: "data_setvariableto", fields: {VARIABLE: ["Sprite 1", "variable-id"]}},
        ["broadcast-" + id]: {opcode: "event_broadcast_menu", fields: {BROADCAST_OPTION: ["Sprite 1", "broadcast-id"]}},
        ["mouse-" + id]: {opcode: "motion_goto_menu", fields: {TO: ["_mouse_", null]}, lumoFieldRefs: {TO: {kind: "target", id}}},
        ["random-backdrop-" + id]: {opcode: "looks_backdrops", fields: {BACKDROP: ["random backdrop", null]}, lumoFieldRefs: {BACKDROP: {kind: "backdrop", id: "backdrop-" + id.slice(-1)}}},
      },
    });
    const monitor = (id, name = "Sprite 1") => ({id: "monitor-" + id, opcode: "sensing_of", spriteName: name, params: {OBJECT: name}});
    const state = projectJson => ({blocksXml: "", projectJson: JSON.stringify(projectJson), eventSeq: 0, structuralVersion: 1, assets: [], selectedSprite: "Stage", stageBackdrop: "", activity: []});
    const base = state({targets: [stage([backdrop("backdrop-base", "Fondo 1")])], monitors: []});
    const reservedStageSprite = sprite("target-stage-name", "Fondo 2", "Stage");
    const local = state({targets: [stage([backdrop("backdrop-base", "Fondo 1"), backdrop("backdrop-b", "Fondo 2")]), sprite("target-b", "Fondo 2"), reservedStageSprite], monitors: [monitor("target-b"), monitor("target-stage-name", "Stage")]});
    const remote = state({targets: [stage([backdrop("backdrop-base", "Fondo 1"), backdrop("backdrop-a", "Fondo 2")]), sprite("target-a", "Fondo 2")], monitors: [monitor("target-a")]});
    const project = JSON.parse(window.__LUMO_TEST__.mergeProjectStates(base, local, remote).projectJson);
    const names = Object.fromEntries(project.targets.filter(target => !target.isStage).map(target => [target.lumoTargetId, target.name]));
    const backdropNames = Object.fromEntries(project.targets.find(target => target.isStage).costumes.map(item => [item.lumoMediaId, item.name]));
    return {
      names,
      backdropNames,
      blockRefs: project.targets.filter(target => !target.isStage && target.blocks["clone-" + target.lumoTargetId]).map(target => ({
        id: target.lumoTargetId,
        cloneName: target.blocks["clone-" + target.lumoTargetId].fields.CLONE_OPTION[0],
        cloneId: target.blocks["clone-" + target.lumoTargetId].lumoFieldRefs.CLONE_OPTION.id,
        pointName: target.blocks["point-" + target.lumoTargetId].fields.TOWARDS[0],
        pointId: target.blocks["point-" + target.lumoTargetId].lumoFieldRefs.TOWARDS.id,
        backdropName: target.blocks["backdrop-" + target.lumoTargetId].fields.BACKDROP[0],
        backdropId: target.blocks["backdrop-" + target.lumoTargetId].lumoFieldRefs.BACKDROP.id,
        variable: target.blocks["variable-" + target.lumoTargetId].fields.VARIABLE,
        broadcast: target.blocks["broadcast-" + target.lumoTargetId].fields.BROADCAST_OPTION,
        mouse: target.blocks["mouse-" + target.lumoTargetId],
        randomBackdrop: target.blocks["random-backdrop-" + target.lumoTargetId],
      })),
      monitorRefs: project.monitors.map(item => ({id: item.lumoTargetId, owner: item.spriteName, objectId: item.lumoParamRefs.OBJECT.id, objectName: item.params.OBJECT})),
    };
  })()`);
  if (Object.keys(targetNameMerge.names).length !== 3 || new Set(Object.values(targetNameMerge.names)).size !== 3 || Object.values(targetNameMerge.names).includes("Stage") ||
      Object.keys(targetNameMerge.backdropNames).length !== 3 || new Set(Object.values(targetNameMerge.backdropNames)).size !== 3 ||
      targetNameMerge.blockRefs.some(item => item.cloneId !== item.id || item.pointId !== item.id || targetNameMerge.names[item.id] !== item.cloneName || targetNameMerge.names[item.id] !== item.pointName || targetNameMerge.backdropNames[item.backdropId] !== item.backdropName || JSON.stringify(item.variable) !== JSON.stringify(["Sprite 1", "variable-id"]) || JSON.stringify(item.broadcast) !== JSON.stringify(["Sprite 1", "broadcast-id"]) || item.mouse.fields.TO[0] !== "_mouse_" || item.mouse.lumoFieldRefs || item.randomBackdrop.fields.BACKDROP[0] !== "random backdrop" || item.randomBackdrop.lumoFieldRefs) ||
      targetNameMerge.monitorRefs.some(item => item.objectId !== item.id || targetNameMerge.names[item.id] !== item.owner || targetNameMerge.names[item.id] !== item.objectName)) {
    throw new Error(`El merge de nombres concurrentes rompió referencias por nombre: ${JSON.stringify(targetNameMerge)}`);
  }
  console.log("[collab] sprites homónimos se renombran sin romper bloques ni monitores");

  await first.click(".add-sprite");
  await first.waitFor(`document.querySelector('[data-testid="image-editor"]') && document.querySelectorAll('.sprite-card').length === 1`, "primer sprite vacío y editor abiertos");
  const starterSprite = await first.evaluate(`(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => item.isOriginal !== false && !item.isStage);
    return {
      name: target?.sprite?.name ?? "",
      stableId: target ? test.targetStableIds.get(target.id) : "",
      costumeCount: target?.getCostumes?.().length ?? -1,
      blocks: Object.keys(target?.blocks?._blocks ?? {}),
    };
  })()`);
  if (!starterSprite.name || !starterSprite.stableId || starterSprite.costumeCount !== 1 || starterSprite.blocks.length !== 0) {
    throw new Error(`El primer sprite vacío no se creó correctamente: ${JSON.stringify(starterSprite)}`);
  }
  await first.click('[aria-label="Cerrar editor"]');
  await first.waitFor(`!document.querySelector('[data-testid="image-editor"]')`, "editor del primer sprite cerrado");
  console.log(`[collab] primer sprite vacío creado: ${starterSprite.name}`);

  await first.click(".invite-button");
  await first.waitFor(`location.search.includes('project=') && document.querySelector('.invite-modal')`, "enlace de invitación");
  const inviteUrl = await first.evaluate("location.href");
  await first.click(".modal-close");
  console.log("[collab] enlace creado");

  second = await openPage(inviteUrl);
  await second.waitFor(`document.querySelectorAll('.sprite-card').length === 1 && !document.querySelector('.error-banner')`, "proyecto invitado cargado");
  const [firstClientId, secondClientId] = await Promise.all([first.evaluate("window.__LUMO_TEST__.clientId"), second.evaluate("window.__LUMO_TEST__.clientId")]);
  if (!firstClientId || firstClientId === secondClientId) throw new Error("Las pestañas comparten el mismo clientId");
  const originalName = starterSprite.name;
  const originalStableId = starterSprite.stableId;
  const remoteStarter = await second.evaluate(`(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => item.isOriginal !== false && !item.isStage);
    return {name: target?.sprite?.name ?? "", stableId: target ? test.targetStableIds.get(target.id) : "", blocks: Object.keys(target?.blocks?._blocks ?? {})};
  })()`);
  if (remoteStarter.name !== originalName || remoteStarter.stableId !== originalStableId || remoteStarter.blocks.length !== 0) {
    throw new Error(`El primer sprite no llegó idéntico al invitado: ${JSON.stringify(remoteStarter)}`);
  }
  console.log("[collab] segundo usuario conectado");

  const parsed = new URL(inviteUrl);
  const projectId = parsed.searchParams.get("project");
  const token = parsed.searchParams.get("invite");
  const projectApi = `${appUrl}api/projects/${projectId}?token=${encodeURIComponent(token)}`;
  const baselineProject = await fetch(projectApi, {cache: "no-store"}).then(response => response.json());

  await second.clickSprite(originalName);
  await Promise.all([installPatchGate(first), installPatchGate(second)]);
  await Promise.all([
    first.click(".add-sprite"),
    second.setInput("input[aria-label='Posición X']", "137"),
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
    const test = window.__LUMO_TEST__;
    const targets = test.vm.runtime.targets.filter(target => target.isOriginal !== false && !target.isStage);
    const original = targets.find(target => test.targetStableIds.get(target.id) === ${JSON.stringify(originalStableId)});
    return targets.length === 2 && Math.round(original?.x ?? Number.NaN) === 137 && targets.every(target => Boolean(test.targetStableIds.get(target.id)));
  })()`;
  await Promise.all([
    first.waitFor(converged, "merge concurrente en la primera pestaña", 30_000),
    second.waitFor(converged, "merge concurrente en la segunda pestaña", 30_000),
  ]);
  await first.waitFor(`document.querySelector('[data-testid="image-editor"]')`, "editor del sprite añadido tras el conflicto", 30_000);
  const addedSprite = await first.evaluate(`(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => item.isOriginal !== false && !item.isStage && test.targetStableIds.get(item.id) !== ${JSON.stringify(originalStableId)});
    return {name: target?.sprite?.name ?? "", stableId: target ? test.targetStableIds.get(target.id) : ""};
  })()`);
  if (!addedSprite.name || !addedSprite.stableId || addedSprite.stableId === originalStableId) {
    throw new Error(`El alta concurrente perdió identidad: ${JSON.stringify(addedSprite)}`);
  }
  const concurrentCostumeBefore = await first.evaluate(`(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(addedSprite.stableId)});
    const costume = target?.getCostumes?.()[0];
    return {targetId: target?.id ?? "", assetId: costume?.assetId ?? "", mediaId: costume?.lumoMediaId ?? ""};
  })()`);
  if (!concurrentCostumeBefore.targetId || !concurrentCostumeBefore.assetId || !concurrentCostumeBefore.mediaId) {
    throw new Error(`El editor concurrente no apunta a un target vivo: ${JSON.stringify(concurrentCostumeBefore)}`);
  }
  await first.waitFor(`!document.querySelector('[data-testid="image-editor-save"]')?.disabled`, "editor concurrente listo para guardar");
  await first.drawStroke('[data-testid="image-editor-canvas"]');
  await first.click('[data-testid="image-editor-save"]');
  await first.waitFor(`(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(addedSprite.stableId)});
    const costume = target?.getCostumes?.()[0];
    return !document.querySelector('[data-testid="image-editor"]') && costume?.lumoMediaId === ${JSON.stringify(concurrentCostumeBefore.mediaId)} && costume?.assetId && costume.assetId !== ${JSON.stringify(concurrentCostumeBefore.assetId)};
  })()`, "guardar el disfraz sobre el target vivo tras el conflicto", 30_000);
  const concurrentCostumeAfter = await first.evaluate(`(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(addedSprite.stableId)});
    const costume = target?.getCostumes?.()[0];
    return {assetId: costume?.assetId ?? "", mediaId: costume?.lumoMediaId ?? ""};
  })()`);
  await second.waitFor(`(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(addedSprite.stableId)});
    const costume = target?.getCostumes?.()[0];
    return costume?.assetId === ${JSON.stringify(concurrentCostumeAfter.assetId)} && costume?.lumoMediaId === ${JSON.stringify(concurrentCostumeAfter.mediaId)};
  })()`, "disfraz concurrente sincronizado al segundo cliente", 30_000);
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
  const persistedOriginal = persistedSprites.find(target => target.lumoTargetId === originalStableId);
  const persistedAdded = persistedSprites.find(target => target.lumoTargetId === addedSprite.stableId);
  if (persistedSprites.length !== 2 || persistedAdded?.name !== addedSprite.name || Math.round(persistedOriginal?.x ?? Number.NaN) !== 137) {
    throw new Error("El snapshot fusionado perdió una edición concurrente");
  }
  if (concurrentProject.version < baselineProject.version + 2) throw new Error("El conflicto CAS no produjo guardado y reintento");
  console.log("[collab] snapshots concurrentes fusionados y editor reanudado sobre el target vivo");

  const renameBaseline = await fetch(projectApi, {cache: "no-store"}).then(response => response.json());
  await Promise.all([first.clickSprite(originalName), second.clickSprite(originalName)]);
  await Promise.all([installPatchGate(first), installPatchGate(second)]);
  const renamedName = `${originalName} colaborativo`.slice(0, 40);
  await first.evaluate(`(() => {
    const vm = window.__LUMO_TEST__.vm;
    vm.renameSprite(vm.editingTarget.id, ${JSON.stringify(renamedName)});
  })()`);
  await first.waitFor(`Array.from(document.querySelectorAll('.sprite-card b')).some(label => label.textContent === ${JSON.stringify(renamedName)})`, "renombre local visible");
  await Promise.all([
    first.setInput("input[aria-label='Tamaño del sprite']", "111"),
    second.setInput("input[aria-label='Posición X']", "211"),
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
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(originalStableId)});
    return target?.sprite?.name === ${JSON.stringify(renamedName)} && Math.round(target.x) === 211 && Math.round(target.size) === 111;
  })()`;
  await Promise.all([
    first.waitFor(renameConverged, "renombre y propiedad remota en la primera pestaña", 30_000),
    second.waitFor(renameConverged, "renombre y propiedad remota en la segunda pestaña", 30_000),
  ]);
  const renamedProject = await fetch(projectApi, {cache: "no-store"}).then(response => response.json());
  const renamedJson = JSON.parse(renamedProject.state.projectJson);
  const renamedTarget = renamedJson.targets.find(target => target.lumoTargetId === originalStableId);
  const stableIds = renamedJson.targets.filter(target => !target.isStage).map(target => target.lumoTargetId);
  if (renamedTarget?.name !== renamedName || Math.round(renamedTarget.x) !== 211 || Math.round(renamedTarget.size) !== 111 || stableIds.some(id => typeof id !== "string") || new Set(stableIds).size !== stableIds.length) {
    throw new Error("El merge por identidad estable perdió el renombre o una propiedad concurrente");
  }
  console.log("[collab] renombre concurrente fusionado por ID estable");

  await first.clickSprite(addedSprite.name);
  await first.click(".editor-tabs button", 1);
  await first.click(".panel-primary");
  await first.waitFor(`document.querySelector('[data-testid="image-editor"]') && document.querySelectorAll('.asset-card').length === 2 && !document.querySelector('[data-testid="image-editor-save"]')?.disabled`, "editor del disfraz nuevo listo");
  await first.drawStroke('[data-testid="image-editor-canvas"]');
  await first.click('[data-testid="image-editor-save"]');
  await first.waitFor(`!document.querySelector('[data-testid="image-editor"]') && document.querySelectorAll('.asset-card').length === 2`, "disfraz dibujado guardado", 30_000);
  const costumeDigestExpression = `(() => {
    const test = window.__LUMO_TEST__;
    const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(addedSprite.stableId)});
    const costumes = target?.getCostumes?.() ?? [];
    const costume = costumes.at(-1);
    const raw = costume?.asset?.data;
    const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array();
    let checksum = 2166136261;
    for (const value of bytes) checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
    return {count: costumes.length, firstAssetId: costumes[0]?.assetId ?? "", assetId: costume?.assetId ?? "", dataFormat: costume?.dataFormat ?? "", mediaId: costume?.lumoMediaId ?? "", byteLength: bytes.byteLength, checksum};
  })()`;
  const localCostume = await first.evaluate(costumeDigestExpression);
  if (localCostume.count !== 2 || !localCostume.mediaId || !localCostume.assetId || localCostume.assetId === localCostume.firstAssetId || localCostume.byteLength === 0) {
    throw new Error(`El editor no produjo un disfraz nuevo con bytes: ${JSON.stringify(localCostume)}`);
  }
  await second.clickSprite(addedSprite.name);
  await second.click(".editor-tabs button", 1);
  await second.waitFor(`(() => { const test = window.__LUMO_TEST__; const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(addedSprite.stableId)}); const costume = target?.getCostumes?.().at(-1); return target?.getCostumes?.().length === 2 && costume?.assetId === ${JSON.stringify(localCostume.assetId)} && costume?.lumoMediaId === ${JSON.stringify(localCostume.mediaId)} && costume?.asset?.data?.byteLength === ${localCostume.byteLength} && document.querySelectorAll('.asset-card').length === 2; })()`, "disfraz y bytes remotos cargados", 30_000);
  const remoteCostume = await second.evaluate(costumeDigestExpression);
  if (JSON.stringify(remoteCostume) !== JSON.stringify(localCostume)) {
    throw new Error(`Los bytes del disfraz no convergieron: ${JSON.stringify({localCostume, remoteCostume})}`);
  }
  console.log("[collab] disfraz dibujado y bytes sincronizados");

  await first.click(".editor-tabs button", 0);
  await second.click(".editor-tabs button", 0);
  await first.clickSprite(renamedName);
  await second.clickSprite(addedSprite.name);
  const blockState = await first.evaluate(`(() => {
    const workspace = window.__LUMO_TEST__.workspace.getAllBlocks(false).map(block => ({id: block.id, type: block.type}));
    const vm = Object.entries(window.__LUMO_TEST__.vm.editingTarget.blocks._blocks).map(([id, block]) => ({id, type: block.opcode}));
    const targetId = window.__LUMO_TEST__.vm.editingTarget.id;
    return {workspace, vm, targetId, stableTargetId: window.__LUMO_TEST__.targetStableIds.get(targetId), targetName: window.__LUMO_TEST__.vm.editingTarget.sprite.name};
  })()`);
  if (blockState.stableTargetId !== originalStableId || blockState.targetName !== renamedName || blockState.workspace.length !== 0 || blockState.vm.length !== 0) {
    throw new Error(`El sprite vacío ya traía bloques o perdió identidad: ${JSON.stringify(blockState)}`);
  }
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
  await second.waitFor(`(() => { const test = window.__LUMO_TEST__; const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(blockState.stableTargetId)}); return target && Object.values(target.blocks._blocks).some(block => block.opcode === 'motion_turnright') && test.vm.editingTarget.id !== target.id; })()`, "operación remota aplicada en target no seleccionado");
  console.log("[collab] bloque sincronizado en target oculto");

  await first.send("Page.bringToFront");
  await first.evaluate(`window.__LUMO_TEST__.workspace.getBlockById('collab_turn').dispose(true)`);
  await first.waitFor(`!Object.values(window.__LUMO_TEST__.vm.runtime.getTargetById(${JSON.stringify(blockState.targetId)}).blocks._blocks).some(block => block.opcode === 'motion_turnright')`, "bloque local eliminado", 3000);
  await delay(1200);
  await second.send("Page.bringToFront");
  await second.waitFor(`(() => { const test = window.__LUMO_TEST__; const target = test.vm.runtime.targets.find(item => test.targetStableIds.get(item.id) === ${JSON.stringify(blockState.stableTargetId)}); return target && !Object.values(target.blocks._blocks).some(block => block.opcode === 'motion_turnright'); })()`, "eliminación remota aplicada");
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
  let editedAssetVerified = false;
  for (const asset of project.state.assets) {
    const response = await fetch(`${appUrl}api/projects/${projectId}/assets/${asset.assetId}?token=${encodeURIComponent(token)}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || !bytes.byteLength) throw new Error(`Asset remoto vacío: ${asset.assetId}`);
    if (asset.assetId === localCostume.assetId) {
      let checksum = 2166136261;
      for (const value of bytes) checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
      if (bytes.byteLength !== localCostume.byteLength || checksum !== localCostume.checksum || asset.byteLength !== localCostume.byteLength) {
        throw new Error(`Los bytes persistidos del disfraz difieren: ${JSON.stringify({manifest: asset.byteLength, fetched: bytes.byteLength, checksum})}`);
      }
      editedAssetVerified = true;
    }
  }
  if (!editedAssetVerified) throw new Error("El asset dibujado no figura en el manifiesto remoto");
  const savedProject = JSON.parse(project.state.projectJson);
  const savedTarget = savedProject.targets.find(target => target.lumoTargetId === blockState.stableTargetId);
  const savedAddedTarget = savedProject.targets.find(target => target.lumoTargetId === addedSprite.stableId);
  const savedEditedCostume = savedAddedTarget?.costumes?.at(-1);
  if (!savedTarget || savedTarget.name !== renamedName || savedTarget.blocks?.collab_turn) {
    throw new Error("El snapshot final perdió el renombre o conservó el bloque eliminado");
  }
  if (savedAddedTarget?.costumes?.length !== 2 || savedEditedCostume?.assetId !== localCostume.assetId || savedEditedCostume?.lumoMediaId !== localCostume.mediaId) {
    throw new Error("El snapshot final perdió el disfraz editado o su identidad estable");
  }
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
    sprites: {original: {name: renamedName, stableId: originalStableId}, added: addedSprite},
    first: {
      sprites: await first.evaluate("document.querySelectorAll('.sprite-card').length"),
      costumes: await first.evaluate(`(() => { const test = window.__LUMO_TEST__; return test.vm.runtime.targets.find(target => test.targetStableIds.get(target.id) === ${JSON.stringify(addedSprite.stableId)})?.getCostumes?.().length ?? 0; })()`),
      exceptions: first.exceptions,
      errors: unexpectedBrowserErrors(first.errors),
    },
    second: {
      sprites: await second.evaluate("document.querySelectorAll('.sprite-card').length"),
      costumes: await second.evaluate(`(() => { const test = window.__LUMO_TEST__; return test.vm.runtime.targets.find(target => test.targetStableIds.get(target.id) === ${JSON.stringify(addedSprite.stableId)})?.getCostumes?.().length ?? 0; })()`),
      commentSynced: await second.evaluate("document.querySelector('.comments-list')?.textContent?.includes('Prueba colaborativa verificada')"),
      exceptions: second.exceptions,
      errors: unexpectedBrowserErrors(second.errors),
    },
    editedCostume: localCostume,
    assets: project.state.assets.map(asset => ({assetId: asset.assetId, bytes: asset.byteLength, type: asset.assetType})),
  };
  console.log(JSON.stringify(result, null, 2));
  if (first.exceptions.length || second.exceptions.length || unexpectedBrowserErrors(first.errors).length || unexpectedBrowserErrors(second.errors).length) process.exitCode = 1;
} catch (error) {
  const diagnostics = {
    error: error instanceof Error ? error.message : String(error),
    first: await first.evaluate(`(() => {
      const test = window.__LUMO_TEST__;
      return {
        url: location.href,
        toast: document.querySelector('.toast')?.textContent ?? '',
        error: document.querySelector('.error-banner')?.textContent ?? '',
        sprites: document.querySelectorAll('.sprite-card').length,
        ready: document.querySelector('.engine-note')?.textContent ?? '',
        sync: document.querySelector('.sync-status')?.textContent ?? '',
        editor: document.querySelector('[data-testid="image-editor"]') ? {
          status: document.querySelector('[data-testid="image-editor"] [role="status"]')?.textContent ?? '',
          busy: document.querySelector('[data-testid="image-editor"] [role="dialog"]')?.getAttribute('aria-busy') ?? '',
          saveDisabled: document.querySelector('[data-testid="image-editor-save"]')?.disabled ?? null,
        } : null,
        targets: test?.vm?.runtime?.targets?.filter(target => target.isOriginal !== false).map(target => ({
          id: target.id,
          stableId: test.targetStableIds.get(target.id),
          name: target.sprite?.name,
          costumes: target.getCostumes?.().map(costume => ({assetId: costume.assetId, mediaId: costume.lumoMediaId, name: costume.name})),
        })) ?? [],
        patchRequests: window.__LUMO_PATCH_GATE__?.requests ?? [],
      };
    })()`).catch(() => null),
    second: second ? await second.evaluate(`({url: location.href, toast: document.querySelector('.toast')?.textContent ?? '', error: document.querySelector('.error-banner')?.textContent ?? '', sprites: document.querySelectorAll('.sprite-card').length, ready: document.querySelector('.engine-note')?.textContent ?? ''})`).catch(() => null) : null,
    exceptions: {first: first.exceptions, second: second?.exceptions ?? []},
    errors: {first: first.errors, second: second?.errors ?? []},
  };
  console.error(JSON.stringify(diagnostics, null, 2));
  throw error;
} finally {
  await second?.close();
  await first.close();
}
