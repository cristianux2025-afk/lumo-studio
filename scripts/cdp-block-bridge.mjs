const target = await fetch("http://localhost:9223/json/new?about%3Ablank", {method: "PUT"}).then(response => response.json());
const appUrl = process.argv[2] ?? "http://localhost:4173/";
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, {once: true});
  socket.addEventListener("error", reject, {once: true});
});
let id = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const {resolve, reject} = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id;
  pending.set(callId, {resolve, reject});
  socket.send(JSON.stringify({id: callId, method, params}));
});
const evaluate = async expression => {
  const response = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
const state = () => evaluate(`(() => ({
  editingTarget: {id: window.__LUMO_TEST__.vm.editingTarget.id, name: window.__LUMO_TEST__.vm.editingTarget.sprite.name},
  workspace: window.__LUMO_TEST__.workspace.getAllBlocks(false).map(block => ({id: block.id, type: block.type})),
  vm: Object.entries(window.__LUMO_TEST__.vm.editingTarget.blocks._blocks).map(([id, block]) => ({id, type: block.opcode})),
  targets: window.__LUMO_TEST__.vm.runtime.targets.filter(target => target.isOriginal !== false).map(target => ({id: target.id, name: target.sprite?.name, blocks: Object.values(target.blocks._blocks).map(block => ({id: block.id, type: block.opcode}))})),
  events: window.__LUMO_EVENT_LOG__ ?? [],
  listeners: window.__LUMO_LISTENER_STATE__ ?? null
}))()`);
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", {url: appUrl});
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (await evaluate(`Boolean(window.__LUMO_TEST__ && document.querySelector('.engine-note')?.textContent?.includes('60 TPS'))`)) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
const before = await state();
await evaluate(`(() => {
  const {ScratchBlocks, workspace, vm} = window.__LUMO_TEST__;
  window.__LUMO_EVENT_LOG__ = [];
  workspace.addChangeListener(event => window.__LUMO_EVENT_LOG__.push({type: event.type, blockId: event.blockId, json: event.toJson?.()}));
  window.__LUMO_LISTENER_STATE__ = {count: workspace.listeners_?.length, hasVm: workspace.listeners_?.includes(vm.blockListener)};
  const xml = ScratchBlocks.utils.xml.textToDom('<xml xmlns="https://developers.google.com/blockly/xml"><block type="motion_turnright" id="bridge_turn" x="48" y="230"><value name="DEGREES"><shadow type="math_number" id="bridge_degrees"><field name="NUM">15</field></shadow></value></block></xml>');
  ScratchBlocks.Xml.domToWorkspace(xml, workspace);
})()`);
await new Promise(resolve => setTimeout(resolve, 1500));
const after = await state();
console.log(JSON.stringify({before, after}, null, 2));
await Promise.race([send("Target.closeTarget", {targetId: target.id}).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
socket.close();
const workspaceBlock = after.workspace.find(block => block.id === "bridge_turn" && block.type === "motion_turnright");
const vmBlock = after.vm.find(block => block.id === "bridge_turn" && block.type === "motion_turnright");
const createEvent = after.events.some(event => event.type === "create" && event.blockId === "bridge_turn");
if (!workspaceBlock || !vmBlock || !createEvent) process.exitCode = 1;
