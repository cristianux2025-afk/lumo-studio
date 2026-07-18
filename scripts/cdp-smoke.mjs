const appUrl = process.argv[2] ?? "http://localhost:4173/";
const target = await fetch("http://localhost:9223/json/new?about%3Ablank", {method: "PUT"}).then(response => response.json());

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, {once: true});
  socket.addEventListener("error", reject, {once: true});
});

let nextId = 0;
const pending = new Map();
const diagnostics = new Map();
const remember = entry => {
  const key = `${entry.type}:${entry.text}`;
  const current = diagnostics.get(key);
  diagnostics.set(key, current ? {...current, count: current.count + 1} : {...entry, count: 1});
};
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
    remember({type: "exception", text: message.params.exceptionDetails.text, details: message.params.exceptionDetails.exception?.description});
  }
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
    remember({type: message.params.type, text: message.params.args.map(argument => argument.description ?? argument.value).join(" ")});
  }
  if (message.method === "Log.entryAdded" && ["error", "warning"].includes(message.params.entry.level)) {
    remember({type: message.params.entry.level, text: message.params.entry.text});
  }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params}));
});
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const evaluate = async expression => {
  const response = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
const waitFor = async (expression, attempts = 100, interval = 200) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(expression).catch(() => false)) return true;
    await sleep(interval);
  }
  return false;
};
const setFormValue = (selector, value, blur = false) => evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLSelectElement)) return false;
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('input', {bubbles: true}));
  element.dispatchEvent(new Event('change', {bubbles: true}));
  if (${blur}) { element.focus(); element.blur(); }
  return true;
})()`);

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.bringToFront");
await send("Page.navigate", {url: appUrl});

const ready = await waitFor(`Boolean(window.__LUMO_TEST__ && document.querySelector('.engine-note')?.textContent?.includes('60 TPS'))`, 150);
const fpsReady = ready && await waitFor(`Number(document.querySelector('.stage-toolbar small')?.textContent?.match(/([0-9]+) FPS/)?.[1] ?? 0) >= 10`);
const initial = await evaluate(`(() => {
  const test = window.__LUMO_TEST__;
  const vm = test?.vm;
  const workspace = test?.workspace;
  const originals = vm?.runtime?.targets?.filter(target => target.isOriginal !== false) ?? [];
  return {
    title: document.title,
    runtimeError: document.querySelector('.error-banner')?.textContent?.trim() || '',
    runtimeReady: document.querySelector('.engine-note')?.textContent?.trim() || '',
    stageLoading: Boolean(document.querySelector('.stage-loading')),
    categories: workspace?.options?.languageTree?.querySelectorAll?.('category')?.length ?? document.querySelectorAll('[role="treeitem"]').length,
    flyoutBlocks: document.querySelectorAll('.blocklyDraggable').length,
    workspaceBlocks: workspace?.getAllBlocks?.(false)?.length ?? -1,
    vmBlocks: vm?.editingTarget ? Object.keys(vm.editingTarget.blocks?._blocks ?? {}).length : -1,
    sprites: originals.filter(target => !target.isStage).length,
    spriteCards: document.querySelectorAll('.sprite-card').length,
    editingTarget: vm?.editingTarget ? {name: vm.editingTarget.sprite?.name, isStage: Boolean(vm.editingTarget.isStage)} : null,
    canvas: Boolean(document.querySelector('.stage canvas')),
    hydrationOverlay: Boolean(document.querySelector('[data-nextjs-dialog-overlay]')),
    fps: Number(document.querySelector('.stage-toolbar small')?.textContent?.match(/([0-9]+) FPS/)?.[1] ?? 0)
  };
})()`);

const addSpriteClicked = ready && await evaluate(`(() => {
  const button = document.querySelector('.add-sprite');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);
const editorOpened = addSpriteClicked && await waitFor(`Boolean(document.querySelector('[data-testid="image-editor"]'))`);
const editorClosedClicked = editorOpened && await evaluate(`(() => {
  const button = document.querySelector('[aria-label="Cerrar editor"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);
const editorClosed = editorClosedClicked && await waitFor(`!document.querySelector('[data-testid="image-editor"]')`);
const spriteReady = editorClosed && await waitFor(`(() => {
  const vm = window.__LUMO_TEST__?.vm;
  const sprites = vm?.runtime?.targets?.filter(target => target.isOriginal !== false && !target.isStage) ?? [];
  return sprites.length === 1 && vm?.editingTarget?.id === sprites[0].id && window.__LUMO_TEST__?.workspace?.getAllBlocks(false)?.length === 0;
})()`);

let propertiesUpdated = false;
let visibilityToggled = false;
let rotationUpdated = false;
if (spriteReady) {
  await setFormValue('[aria-label="Nombre del sprite"]', 'Sprite probado', true);
  await setFormValue('[aria-label="Posición Y"]', '37');
  await setFormValue('[aria-label="Tamaño del sprite"]', '125');
  await setFormValue('[aria-label="Dirección del sprite"]', '-45');
  propertiesUpdated = await waitFor(`(() => {
    const target = window.__LUMO_TEST__?.vm?.editingTarget;
    return target?.sprite?.name === 'Sprite probado' && Math.round(target.y) === 37 && Math.round(target.size) === 125 && Math.round(target.direction) === -45;
  })()`);
  const visibilityButton = '.sprite-options button[aria-pressed]';
  const hiddenClicked = await evaluate(`(() => { const button = document.querySelector(${JSON.stringify(visibilityButton)}); if (!button) return false; button.click(); return true; })()`);
  const hidden = hiddenClicked && await waitFor(`window.__LUMO_TEST__?.vm?.editingTarget?.visible === false && document.querySelector(${JSON.stringify(visibilityButton)})?.getAttribute('aria-pressed') === 'false'`);
  const visibleClicked = hidden && await evaluate(`(() => { const button = document.querySelector(${JSON.stringify(visibilityButton)}); if (!button) return false; button.click(); return true; })()`);
  visibilityToggled = visibleClicked && await waitFor(`window.__LUMO_TEST__?.vm?.editingTarget?.visible === true && document.querySelector(${JSON.stringify(visibilityButton)})?.getAttribute('aria-pressed') === 'true'`);
  await setFormValue('[aria-label="Estilo de rotación"]', 'left-right');
  rotationUpdated = await waitFor(`window.__LUMO_TEST__?.vm?.editingTarget?.rotationStyle === 'left-right'`);
}

let scriptInserted = false;
if (spriteReady) {
  scriptInserted = await evaluate(`(() => {
    const {ScratchBlocks, workspace} = window.__LUMO_TEST__;
    const xml = ScratchBlocks.utils.xml.textToDom('<xml xmlns="https://developers.google.com/blockly/xml"><block type="event_whenflagclicked" id="smoke_flag" x="48" y="48"><next><block type="motion_movesteps" id="smoke_move"><value name="STEPS"><shadow type="math_number" id="smoke_steps"><field name="NUM">24</field></shadow></value><next><block type="control_wait" id="smoke_wait"><value name="DURATION"><shadow type="math_positive_number" id="smoke_duration"><field name="NUM">2</field></shadow></value></block></next></block></next></block></xml>');
    ScratchBlocks.Xml.domToWorkspace(xml, workspace);
    return true;
  })()`);
}
const bridgeReady = scriptInserted && await waitFor(`(() => {
  const {workspace, vm} = window.__LUMO_TEST__;
  return Boolean(workspace.getBlockById('smoke_flag') && workspace.getBlockById('smoke_move') && workspace.getBlockById('smoke_wait') && vm.editingTarget?.blocks?._blocks?.smoke_flag && vm.editingTarget?.blocks?._blocks?.smoke_move && vm.editingTarget?.blocks?._blocks?.smoke_wait);
})()`);
const prepared = await evaluate(`(() => {
  const test = window.__LUMO_TEST__;
  const vm = test?.vm;
  const workspace = test?.workspace;
  const sprite = vm?.runtime?.targets?.find(target => target.isOriginal !== false && !target.isStage);
  const workspaceFlag = workspace?.getBlockById?.('smoke_flag');
  const workspaceMove = workspace?.getBlockById?.('smoke_move');
  const workspaceWait = workspace?.getBlockById?.('smoke_wait');
  const vmFlag = sprite?.blocks?._blocks?.smoke_flag;
  const vmMove = sprite?.blocks?._blocks?.smoke_move;
  const vmWait = sprite?.blocks?._blocks?.smoke_wait;
  return {
    stepTime: vm?.runtime?.currentStepTime ?? 0,
    sprite: sprite ? {id: sprite.id, x: sprite.x, y: sprite.y, size: sprite.size, direction: sprite.direction, visible: sprite.visible, rotationStyle: sprite.rotationStyle, name: sprite.sprite?.name} : null,
    editingSprite: Boolean(sprite && vm?.editingTarget?.id === sprite.id),
    workspace: {
      count: workspace?.getAllBlocks?.(false)?.length ?? -1,
      flag: workspaceFlag?.type ?? null,
      move: workspaceMove?.type ?? null,
      wait: workspaceWait?.type ?? null,
      next: workspaceFlag?.getNextBlock?.()?.id ?? null,
      afterMove: workspaceMove?.getNextBlock?.()?.id ?? null
    },
    vm: {
      flag: vmFlag?.opcode ?? null,
      move: vmMove?.opcode ?? null,
      wait: vmWait?.opcode ?? null,
      next: vmFlag?.next ?? null,
      afterMove: vmMove?.next ?? null,
      parent: vmMove?.parent ?? null,
      waitParent: vmWait?.parent ?? null
    }
  };
})()`);

const runClicked = bridgeReady && await evaluate(`(() => {
  const button = document.querySelector('[aria-label="Ejecutar proyecto"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);
await sleep(800);
const afterRun = await evaluate(`(() => {
  const vm = window.__LUMO_TEST__?.vm;
  const sprite = vm?.runtime?.targets?.find(target => target.isOriginal !== false && !target.isStage);
  return {x: sprite?.x ?? null, y: sprite?.y ?? null, threads: vm?.runtime?.threads?.length ?? -1, running: document.querySelector('[aria-label="Ejecutar proyecto"]')?.classList.contains('running') ?? false};
})()`);
const stopClicked = await evaluate(`(() => {
  const button = document.querySelector('[aria-label="Detener proyecto"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);
await sleep(150);
const stopped = await evaluate(`(() => {
  const vm = window.__LUMO_TEST__?.vm;
  return {
    running: document.querySelector('[aria-label="Ejecutar proyecto"]')?.classList.contains('running') ?? true,
    threads: vm?.runtime?.threads?.length ?? -1
  };
})()`);
const fullscreenClicked = await evaluate(`(() => {
  const stage = document.querySelector('.stage');
  const button = document.querySelector('[aria-label="Pantalla completa"]');
  if (!(stage instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || button.disabled) return false;
  stage.requestFullscreen = async () => { window.__LUMO_FULLSCREEN_TEST__ = true; };
  button.click();
  return true;
})()`);
const fullscreenHandled = fullscreenClicked && await waitFor(`window.__LUMO_FULLSCREEN_TEST__ === true`);
const codeTabSelected = await evaluate(`(() => {
  const button = [...document.querySelectorAll('.editor-tabs button')].find(candidate => candidate.textContent?.trim() === 'Código');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);
const extensionButtonReady = codeTabSelected && await waitFor(`Boolean(document.querySelector('.extensions-button:not(:disabled)'))`);
const extensionOpened = extensionButtonReady && await evaluate(`(() => {
  const button = document.querySelector('.extensions-button');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);
const extensionModalReady = extensionOpened && await waitFor(`(() => [...document.querySelectorAll('.extension-modal .extension-grid button')].some(button => button.querySelector('strong')?.textContent?.trim() === 'Lápiz'))()`);
const extensionClicked = extensionModalReady && await evaluate(`(() => {
  const button = [...document.querySelectorAll('.extension-modal .extension-grid button')].find(candidate => candidate.querySelector('strong')?.textContent?.trim() === 'Lápiz');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);
const extensionInstalled = extensionClicked && await waitFor(`(() => {
  const test = window.__LUMO_TEST__;
  const button = [...document.querySelectorAll('.extension-modal .extension-grid button')].find(candidate => candidate.querySelector('strong')?.textContent?.trim() === 'Lápiz');
  const category = test?.workspace?.getToolbox?.()?.getToolboxItems?.().find(item => item.getId?.() === 'pen');
  const categoryContents = category?.getContents?.();
  const hasClearBlock = Array.isArray(categoryContents) && categoryContents.some(item => {
    if (item?.type === 'pen_clear') return true;
    const xml = item?.blockxml;
    if (typeof xml === 'string') return xml.includes('type="pen_clear"');
    return xml?.getAttribute?.('type') === 'pen_clear';
  });
  const runtimeCategory = test?.vm?.runtime?.getBlocksXML?.(test?.vm?.editingTarget)?.find(item => item.id === 'pen');
  return Boolean(
    button?.disabled &&
    button.textContent?.includes('Añadida') &&
    test?.vm?.extensionManager?.isExtensionLoaded?.('pen') &&
    runtimeCategory?.xml?.includes('type="pen_clear"') &&
    category &&
    hasClearBlock &&
    test?.ScratchBlocks?.Blocks?.pen_clear
  );
})()`);
const extensionState = await evaluate(`(() => {
  const {workspace, vm} = window.__LUMO_TEST__ ?? {};
  const button = [...document.querySelectorAll('.extension-modal .extension-grid button')].find(candidate => candidate.querySelector('strong')?.textContent?.trim() === 'Lápiz');
  const toolbox = workspace?.getToolbox?.();
  const category = toolbox?.getToolboxItems?.().find(item => item.getId?.() === 'pen');
  const contents = category?.getContents?.();
  const extensionXml = vm?.runtime?.getBlocksXML?.(vm?.editingTarget) ?? [];
  const runtimeCategory = extensionXml.find(item => item.id === 'pen');
  const hasClearBlock = Array.isArray(contents) && contents.some(item => {
    if (item?.type === 'pen_clear') return true;
    const xml = item?.blockxml;
    if (typeof xml === 'string') return xml.includes('type="pen_clear"');
    return xml?.getAttribute?.('type') === 'pen_clear';
  });
  return {
    button: {disabled: Boolean(button?.disabled), text: button?.textContent?.trim() ?? ''},
    managerLoaded: Boolean(vm?.extensionManager?.isExtensionLoaded?.('pen')),
    toolboxCategory: category ? {id: category.getId?.() ?? '', name: category.getName?.() ?? '', contents: Array.isArray(contents) ? contents.length : -1, hasClearBlock} : null,
    runtimeCategory: runtimeCategory ? {id: runtimeCategory.id, hasClearBlock: runtimeCategory.xml?.includes('type="pen_clear"') ?? false} : null,
    blockDefinition: Boolean(window.__LUMO_TEST__?.ScratchBlocks?.Blocks?.pen_clear)
  };
})()`);
await evaluate(`document.querySelector('.extension-modal [aria-label="Cerrar"]')?.click()`);
const deleteClicked = await evaluate(`(() => {
  const button = document.querySelector('.delete-sprite');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  window.confirm = () => true;
  button.click();
  return true;
})()`);
const spriteDeleted = deleteClicked && await waitFor(`(() => {
  const vm = window.__LUMO_TEST__?.vm;
  return vm?.runtime?.targets?.filter(target => target.isOriginal !== false && !target.isStage)?.length === 0 && vm?.editingTarget?.isStage === true && document.querySelectorAll('.sprite-card').length === 0;
})()`);

const result = {
  actions: {ready, fpsReady, addSpriteClicked, editorOpened, editorClosedClicked, editorClosed, spriteReady, propertiesUpdated, visibilityToggled, rotationUpdated, scriptInserted, bridgeReady, runClicked, stopClicked, fullscreenHandled, codeTabSelected, extensionButtonReady, extensionOpened, extensionModalReady, extensionClicked, extensionInstalled, spriteDeleted},
  initial,
  prepared,
  runtime: {afterRun, stopped},
  extensionState,
  diagnostics: [...diagnostics.values()].slice(0, 50),
};
console.log(JSON.stringify(result, null, 2));
await send("Target.closeTarget", {targetId: target.id}).catch(() => {});
socket.close();

const initialIsBlank = initial.editingTarget?.isStage === true && initial.editingTarget.name === "Stage" && initial.sprites === 0 && initial.spriteCards === 0 && initial.workspaceBlocks === 0 && initial.vmBlocks === 0;
const bridgeMatches = prepared.editingSprite && prepared.workspace.flag === "event_whenflagclicked" && prepared.workspace.move === "motion_movesteps" && prepared.workspace.wait === "control_wait" && prepared.workspace.next === "smoke_move" && prepared.workspace.afterMove === "smoke_wait" && prepared.vm.flag === "event_whenflagclicked" && prepared.vm.move === "motion_movesteps" && prepared.vm.wait === "control_wait" && prepared.vm.next === "smoke_move" && prepared.vm.afterMove === "smoke_wait" && prepared.vm.parent === "smoke_flag" && prepared.vm.waitParent === "smoke_move";
const spritePropertiesMatch = prepared.sprite?.name === "Sprite probado" && Math.round(prepared.sprite.y) === 37 && Math.round(prepared.sprite.size) === 125 && Math.round(prepared.sprite.direction) === -45 && prepared.sprite.visible === true && prepared.sprite.rotationStyle === "left-right";
const movedExactly24 = typeof prepared.sprite?.x === "number" && typeof prepared.sprite?.y === "number" && typeof afterRun.x === "number" && typeof afterRun.y === "number" && Math.abs(Math.hypot(afterRun.x - prepared.sprite.x, afterRun.y - prepared.sprite.y) - 24) < 0.5;
if (
  !Object.values(result.actions).every(Boolean) ||
  !initialIsBlank ||
  initial.runtimeError ||
  !initial.runtimeReady.includes("60 TPS") ||
  initial.stageLoading ||
  !initial.canvas ||
  initial.categories < 9 ||
  initial.flyoutBlocks < 100 ||
  initial.hydrationOverlay ||
  initial.fps < 10 ||
  !bridgeMatches ||
  !spritePropertiesMatch ||
  Math.abs(prepared.stepTime - (1000 / 60)) > 0.5 ||
  !movedExactly24 ||
  !afterRun.running ||
  stopped.running ||
  stopped.threads !== 0 ||
  result.diagnostics.some(entry => entry.type === "exception" || entry.type === "error")
) process.exitCode = 1;
