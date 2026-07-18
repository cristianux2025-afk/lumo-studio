const target = await fetch("http://localhost:9223/json/new?about%3Ablank", {method: "PUT"}).then(response => response.json());
const appUrl = process.argv[2] ?? "http://localhost:4173/";
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, {once: true});
  socket.addEventListener("error", reject, {once: true});
});

let id = 0;
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
    diagnostics.push({type: "exception", text: message.params.exceptionDetails.text, details: message.params.exceptionDetails.exception?.description});
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    diagnostics.push({type: "console-error", text: message.params.args.map(argument => argument.description ?? argument.value).join(" ")});
  }
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    diagnostics.push({type: "log-error", text: message.params.entry.text});
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id;
  pending.set(callId, {resolve, reject});
  socket.send(JSON.stringify({id: callId, method, params}));
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
const state = () => evaluate(`(() => {
  const test = window.__LUMO_TEST__;
  const vm = test?.vm;
  const workspace = test?.workspace;
  const originals = vm?.runtime?.targets?.filter(target => target.isOriginal !== false) ?? [];
  return {
    editingTarget: vm?.editingTarget ? {id: vm.editingTarget.id, name: vm.editingTarget.sprite?.name, isStage: Boolean(vm.editingTarget.isStage)} : null,
    workspace: workspace?.getAllBlocks(false).map(block => ({id: block.id, type: block.type})) ?? [],
    vm: vm?.editingTarget ? Object.entries(vm.editingTarget.blocks._blocks).map(([id, block]) => ({id, type: block.opcode})) : [],
    targets: originals.map(target => ({id: target.id, name: target.sprite?.name, isStage: Boolean(target.isStage), blocks: Object.values(target.blocks._blocks).map(block => ({id: block.id, type: block.opcode}))})),
    events: window.__LUMO_EVENT_LOG__ ?? [],
    listeners: window.__LUMO_LISTENER_STATE__ ?? null
  };
})()`);

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", {url: appUrl});
const ready = await waitFor(`Boolean(window.__LUMO_TEST__ && document.querySelector('.engine-note')?.textContent?.includes('60 TPS'))`, 150);
const initial = await state();
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
const spriteReady = editorClosedClicked && await waitFor(`(() => {
  const test = window.__LUMO_TEST__;
  const sprites = test?.vm?.runtime?.targets?.filter(target => target.isOriginal !== false && !target.isStage) ?? [];
  return !document.querySelector('[data-testid="image-editor"]') && sprites.length === 1 && test?.vm?.editingTarget?.id === sprites[0].id && test?.workspace?.getAllBlocks(false)?.length === 0;
})()`);
const before = await state();
let inserted = false;
if (spriteReady) {
  inserted = await evaluate(`(() => {
    const {ScratchBlocks, workspace, vm} = window.__LUMO_TEST__;
    window.__LUMO_EVENT_LOG__ = [];
    workspace.addChangeListener(event => window.__LUMO_EVENT_LOG__.push({type: event.type, blockId: event.blockId, json: event.toJson?.()}));
    window.__LUMO_LISTENER_STATE__ = {count: workspace.listeners?.length, hasVm: workspace.listeners?.includes(vm.blockListener)};
    const xml = ScratchBlocks.utils.xml.textToDom('<xml xmlns="https://developers.google.com/blockly/xml"><block type="motion_turnright" id="bridge_turn" x="48" y="230"><value name="DEGREES"><shadow type="math_number" id="bridge_degrees"><field name="NUM">15</field></shadow></value></block></xml>');
    ScratchBlocks.Xml.domToWorkspace(xml, workspace);
    return true;
  })()`);
}
const synchronized = inserted && await waitFor(`(() => {
  const {workspace, vm} = window.__LUMO_TEST__;
  return Boolean(workspace.getBlockById('bridge_turn') && vm.editingTarget?.blocks?._blocks?.bridge_turn && (window.__LUMO_EVENT_LOG__ ?? []).some(event => event.type === 'create' && event.blockId === 'bridge_turn'));
})()`);
const after = await state();
console.log(JSON.stringify({actions: {ready, addSpriteClicked, editorOpened, editorClosedClicked, spriteReady, inserted, synchronized}, initial, before, after, diagnostics}, null, 2));
await Promise.race([send("Target.closeTarget", {targetId: target.id}).catch(() => {}), sleep(1000)]);
socket.close();

const initialIsBlank = initial.editingTarget?.isStage === true && initial.editingTarget.name === "Stage" && initial.workspace.length === 0 && initial.vm.length === 0 && initial.targets.filter(item => !item.isStage).length === 0;
const spriteWasCreated = before.editingTarget?.isStage === false && before.workspace.length === 0 && before.vm.length === 0 && before.targets.filter(item => !item.isStage).length === 1;
const workspaceBlock = after.workspace.find(block => block.id === "bridge_turn" && block.type === "motion_turnright");
const vmBlock = after.vm.find(block => block.id === "bridge_turn" && block.type === "motion_turnright");
const spriteTarget = after.targets.find(item => !item.isStage && item.id === after.editingTarget?.id);
const targetBlock = spriteTarget?.blocks.find(block => block.id === "bridge_turn" && block.type === "motion_turnright");
const createEvent = after.events.some(event => event.type === "create" && event.blockId === "bridge_turn");
if (!Object.values({ready, addSpriteClicked, editorOpened, editorClosedClicked, spriteReady, inserted, synchronized}).every(Boolean) || !initialIsBlank || !spriteWasCreated || !workspaceBlock || !vmBlock || !targetBlock || !createEvent || !after.listeners?.hasVm || diagnostics.length) process.exitCode = 1;
