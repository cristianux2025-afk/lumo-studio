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

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.bringToFront");
await send("Page.navigate", {url: appUrl});
await new Promise(resolve => setTimeout(resolve, 18000));

const snapshot = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    title: document.title,
    runtimeError: document.querySelector('.error-banner')?.textContent?.trim() || '',
    runtimeReady: document.querySelector('.engine-note')?.textContent?.trim() || '',
    stageLoading: Boolean(document.querySelector('.stage-loading')),
    categories: window.__LUMO_TEST__?.workspace?.options?.languageTree?.querySelectorAll?.('category')?.length ?? document.querySelectorAll('[role="treeitem"]').length,
    blocks: document.querySelectorAll('.blocklyDraggable').length,
    sprites: document.querySelectorAll('.sprite-card').length,
    canvas: Boolean(document.querySelector('canvas')),
    hydrationOverlay: Boolean(document.querySelector('[data-nextjs-dialog-overlay]')),
    fps: Number(document.querySelector('.stage-toolbar small')?.textContent?.match(/([0-9]+) FPS/)?.[1] ?? 0)
  })`,
  returnByValue: true,
});

const beforeRun = await send("Runtime.evaluate", {
  expression: `(() => {
    const vm = window.__LUMO_TEST__?.vm;
    const sprite = vm?.runtime?.targets?.find(target => target.isOriginal !== false && !target.isStage);
    return {stepTime: vm?.runtime?.currentStepTime ?? 0, x: sprite?.x ?? null, ready: Boolean(vm)};
  })()`,
  returnByValue: true,
});
await send("Runtime.evaluate", {expression: `document.querySelector('[aria-label="Ejecutar proyecto"]')?.click()`});
await new Promise(resolve => setTimeout(resolve, 800));
const afterRun = await send("Runtime.evaluate", {
  expression: `(() => {
    const vm = window.__LUMO_TEST__?.vm;
    const sprite = vm?.runtime?.targets?.find(target => target.isOriginal !== false && !target.isStage);
    document.querySelector('[aria-label="Detener proyecto"]')?.click();
    return {x: sprite?.x ?? null, threads: vm?.runtime?.threads?.length ?? -1};
  })()`,
  returnByValue: true,
});
await new Promise(resolve => setTimeout(resolve, 150));
const stopped = await send("Runtime.evaluate", {
  expression: `({running: document.querySelector('[aria-label="Ejecutar proyecto"]')?.classList.contains('running') ?? true})`,
  returnByValue: true,
});

const result = {
  snapshot: JSON.parse(snapshot.result.value),
  runtime: {before: beforeRun.result.value, after: afterRun.result.value, stopped: stopped.result.value},
  diagnostics: [...diagnostics.values()].slice(0, 50),
};
console.log(JSON.stringify(result, null, 2));
await send("Target.closeTarget", {targetId: target.id}).catch(() => {});
socket.close();
if (
  result.snapshot.runtimeError ||
  !result.snapshot.runtimeReady.includes("60 TPS") ||
  result.snapshot.stageLoading ||
  !result.snapshot.canvas ||
  result.snapshot.categories < 9 ||
  result.snapshot.blocks < 100 ||
  result.snapshot.sprites < 1 ||
  result.snapshot.hydrationOverlay ||
  result.snapshot.fps < 10 ||
  !result.runtime.before.ready ||
  Math.abs(result.runtime.before.stepTime - (1000 / 60)) > 0.5 ||
  typeof result.runtime.before.x !== "number" ||
  Math.abs(result.runtime.after.x - result.runtime.before.x) < 20 ||
  result.runtime.stopped.running ||
  result.diagnostics.some(entry => entry.type === "exception")
) process.exitCode = 1;
