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
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params}));
});

const evaluate = async expression => {
  const response = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
};

const waitUntil = async (probe, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await probe();
    if (lastValue) return lastValue;
    await delay(100);
  }
  throw new Error(`Tiempo agotado esperando ${label}; último valor: ${JSON.stringify(lastValue)}`);
};

const canvasMetrics = () => evaluate(`(async () => {
  const canvas = document.querySelector('[data-testid="image-editor-canvas"]');
  if (!canvas) return null;
  const pixels = canvas.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, canvas.width, canvas.height).data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
  let opaquePixels = 0;
  let coloredPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha > 0) opaquePixels += 1;
    if (alpha > 0 && (pixels[offset] < 250 || pixels[offset + 1] < 250 || pixels[offset + 2] < 250)) coloredPixels += 1;
  }
  return {
    width: canvas.width,
    height: canvas.height,
    hash: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''),
    opaquePixels,
    coloredPixels,
  };
})()`);

const costumeState = kind => evaluate(`(() => {
  const vm = window.__LUMO_TEST__?.vm;
  const target = ${JSON.stringify(kind)} === 'backdrop'
    ? vm?.runtime?.getTargetForStage?.()
    : vm?.runtime?.targets?.find(candidate => candidate.isOriginal !== false && !candidate.isStage);
  const costume = target?.getCostumes?.()?.[target.currentCostume ?? 0];
  return target && costume ? {
    targetId: target.id,
    targetName: target.sprite?.name,
    costumeName: costume.name,
    assetId: String(costume.assetId ?? costume.asset?.assetId ?? ''),
    spriteCount: vm.runtime.targets.filter(candidate => candidate.isOriginal !== false && !candidate.isStage).length,
  } : null;
})()`);

const renderedAssetMetrics = kind => evaluate(`(async () => {
  const vm = window.__LUMO_TEST__?.vm;
  const target = ${JSON.stringify(kind)} === 'backdrop'
    ? vm?.runtime?.getTargetForStage?.()
    : vm?.runtime?.targets?.find(candidate => candidate.isOriginal !== false && !candidate.isStage);
  const costume = target?.getCostumes?.()?.[target.currentCostume ?? 0];
  const asset = costume?.asset ?? vm?.runtime?.storage?.get?.(costume?.assetId);
  if (!costume || !asset) return null;
  const source = asset.encodeDataURI?.();
  if (!source) return null;
  const image = await new Promise((resolve, reject) => {
    const candidate = new Image();
    candidate.onload = () => resolve(candidate);
    candidate.onerror = () => reject(new Error('No se pudo rasterizar el asset guardado'));
    candidate.src = source;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || 480;
  canvas.height = image.naturalHeight || 360;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let opaquePixels = 0;
  let coloredPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha > 0) opaquePixels += 1;
    if (alpha > 0 && (pixels[offset] < 250 || pixels[offset + 1] < 250 || pixels[offset + 2] < 250)) coloredPixels += 1;
  }
  return {
    assetId: String(costume.assetId ?? asset.assetId ?? ''),
    width: canvas.width,
    height: canvas.height,
    opaquePixels,
    coloredPixels,
  };
})()`);

const editingCostumeDetails = () => evaluate(`(() => {
  const target = window.__LUMO_TEST__?.vm?.editingTarget;
  const costume = target?.getCostumes?.()?.[target.currentCostume ?? 0];
  return target && costume ? {
    targetId: target.id,
    targetName: target.sprite?.name,
    assetId: String(costume.assetId ?? costume.asset?.assetId ?? ''),
    byteLength: Number(costume.asset?.data?.byteLength ?? 0),
    width: Number(costume.size?.[0] ?? 0) / Math.max(1, Number(costume.bitmapResolution) || 1),
    height: Number(costume.size?.[1] ?? 0) / Math.max(1, Number(costume.bitmapResolution) || 1),
    rotationCenterX: Number(costume.rotationCenterX ?? 0) / Math.max(1, Number(costume.bitmapResolution) || 1),
    rotationCenterY: Number(costume.rotationCenterY ?? 0) / Math.max(1, Number(costume.bitmapResolution) || 1),
  } : null;
})()`);

const click = selector => evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element || element.disabled) return false;
  element.click();
  return true;
})()`);

const clickButtonText = (containerSelector, text) => evaluate(`(() => {
  const container = document.querySelector(${JSON.stringify(containerSelector)});
  const element = [...(container?.querySelectorAll('button') ?? [])]
    .find(candidate => candidate.textContent?.trim().includes(${JSON.stringify(text)}));
  if (!element || element.disabled) return false;
  element.click();
  return true;
})()`);

const drawStroke = async (startRatio, endRatio) => {
  const bounds = await evaluate(`(() => {
    const bounds = document.querySelector('[data-testid="image-editor-canvas"]')?.getBoundingClientRect();
    return bounds ? {left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height} : null;
  })()`);
  assert.ok(bounds?.width > 0 && bounds?.height > 0, "el lienzo debe estar visible para dibujar");
  const start = {x: bounds.left + bounds.width * startRatio.x, y: bounds.top + bounds.height * startRatio.y};
  const end = {x: bounds.left + bounds.width * endRatio.x, y: bounds.top + bounds.height * endRatio.y};
  await send("Input.dispatchMouseEvent", {type: "mouseMoved", x: start.x, y: start.y});
  await send("Input.dispatchMouseEvent", {type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1});
  for (let step = 1; step <= 8; step += 1) {
    const progress = step / 8;
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress,
      button: "left",
      buttons: 1,
    });
  }
  await send("Input.dispatchMouseEvent", {type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1});
};

const selectTool = async tool => {
  const selector = `[data-testid="image-editor-tool-${tool}"]`;
  assert.equal(await click(selector), true, `debe activar la herramienta ${tool}`);
  await waitUntil(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed') === 'true'`), `activar ${tool}`);
};

const clickCanvasAt = async ratio => {
  const point = await evaluate(`(() => {
    const bounds = document.querySelector('[data-testid="image-editor-canvas"]')?.getBoundingClientRect();
    return bounds ? {x: bounds.left + bounds.width * ${ratio.x}, y: bounds.top + bounds.height * ${ratio.y}} : null;
  })()`);
  assert.ok(point, "el lienzo debe estar visible para hacer clic");
  await send("Input.dispatchMouseEvent", {type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1});
  await send("Input.dispatchMouseEvent", {type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1});
};

const setDrawingColor = color => evaluate(`(() => {
  const input = document.querySelector('[aria-label="Color de dibujo"]');
  if (!(input instanceof HTMLInputElement)) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(color)});
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
  return input.value;
})()`);

let result;
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  await send("Page.navigate", {url: appUrl});
  await waitUntil(
    () => evaluate(`Boolean(window.__LUMO_TEST__?.vm && document.querySelector('.engine-note')?.textContent?.includes('60 TPS'))`),
    "el motor de Lumo Studio",
    30_000,
  );

  const blankProject = await evaluate(`(() => {
    const vm = window.__LUMO_TEST__.vm;
    const originals = vm.runtime.targets.filter(target => target.isOriginal !== false);
    const stage = vm.runtime.getTargetForStage();
    return {
      originalTargets: originals.length,
      sprites: originals.filter(target => !target.isStage).length,
      backdrop: stage.getCostumes()[0]?.name,
      blocks: Object.keys(stage.blocks._blocks).length,
    };
  })()`);

  assert.equal(await clickButtonText(".editor-tabs", "Fondos"), true, "debe abrir el apartado Fondos");
  await waitUntil(() => evaluate(`Boolean(document.querySelector('.asset-grid .asset-card .edit'))`), "la tarjeta de Fondo 1");
  const backdropBefore = await costumeState("backdrop");

  assert.equal(await evaluate(`(() => {
    const costume = window.__LUMO_TEST__.vm.runtime.getTargetForStage().getCostumes()[0];
    const asset = costume?.asset;
    if (!asset?.encodeDataURI) return false;
    window.__LUMO_TEST__.sourceFailureFixture = {asset, encodeDataURI: asset.encodeDataURI};
    asset.encodeDataURI = () => { throw new Error('fallo de fixture'); };
    return true;
  })()`), true, "debe preparar un asset cuya URI no pueda leerse");
  assert.equal(await click(".asset-grid .asset-card .edit"), true, "debe abrir el editor con la fuente dañada");
  const sourceFailureBlocked = await waitUntil(() => evaluate(`(() => {
    const editor = document.querySelector('[data-testid="image-editor"]');
    return editor?.querySelector('[role="status"]')?.textContent?.includes('no se pudo abrir') &&
      editor.querySelector('[data-testid="image-editor-save"]')?.disabled;
  })()`), "bloquear guardado tras un fallo de carga");
  await drawStroke({x: 0.25, y: 0.3}, {x: 0.7, y: 0.65});
  const sourceFailureReplacementEnabled = await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor-save"]')?.disabled`), "permitir un reemplazo dibujado explícitamente");
  assert.equal(await click('[aria-label="Cerrar editor"]'), true, "debe cancelar el reemplazo de prueba");
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"]')`), "cerrar el editor con fuente dañada");
  assert.equal(await evaluate(`(() => {
    const fixture = window.__LUMO_TEST__.sourceFailureFixture;
    if (!fixture) return false;
    fixture.asset.encodeDataURI = fixture.encodeDataURI;
    delete window.__LUMO_TEST__.sourceFailureFixture;
    return true;
  })()`), true, "debe restaurar el asset tras la prueba");

  assert.equal(await click(".asset-grid .asset-card .edit"), true, "debe abrir el editor del fondo");
  await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-testid="image-editor-save"]:not(:disabled)'))`), "el editor de fondos");

  assert.equal(await click('[data-testid="image-editor-save"]'), true, "debe guardar el SVG intacto sin editarlo");
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"]')`), "cerrar el SVG intacto");
  const backdropUnchanged = await costumeState("backdrop");
  assert.equal(backdropUnchanged.assetId, backdropBefore.assetId, "guardar sin cambios debe conservar el vector original");
  assert.equal(await click(".asset-grid .asset-card .edit"), true, "debe reabrir el editor del fondo");
  await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-testid="image-editor-save"]:not(:disabled)'))`), "reabrir el editor de fondos");

  const backdropInitial = await canvasMetrics();
  await drawStroke({x: 0.2, y: 0.25}, {x: 0.78, y: 0.68});
  const backdropStroke = await waitUntil(async () => {
    const metrics = await canvasMetrics();
    return metrics?.hash !== backdropInitial.hash && metrics.coloredPixels > backdropInitial.coloredPixels ? metrics : null;
  }, "el trazo del fondo");

  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"] [aria-label="Deshacer"]')?.disabled`), "habilitar Deshacer");
  assert.equal(await click('[data-testid="image-editor"] [aria-label="Deshacer"]'), true);
  const backdropUndo = await waitUntil(async () => {
    const metrics = await canvasMetrics();
    return metrics?.hash === backdropInitial.hash ? metrics : null;
  }, "deshacer el trazo");

  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"] [aria-label="Rehacer"]')?.disabled`), "habilitar Rehacer");
  assert.equal(await click('[data-testid="image-editor"] [aria-label="Rehacer"]'), true);
  const backdropRedo = await waitUntil(async () => {
    const metrics = await canvasMetrics();
    return metrics?.hash === backdropStroke.hash ? metrics : null;
  }, "rehacer el trazo");

  assert.equal(await clickButtonText('[data-testid="image-editor"]', "Limpiar"), true);
  const backdropClear = await waitUntil(async () => {
    const metrics = await canvasMetrics();
    return metrics?.hash === backdropInitial.hash ? metrics : null;
  }, "limpiar el fondo");
  assert.equal(await click('[data-testid="image-editor"] [aria-label="Deshacer"]'), true);
  const backdropClearUndo = await waitUntil(async () => {
    const metrics = await canvasMetrics();
    return metrics?.hash === backdropStroke.hash ? metrics : null;
  }, "deshacer la limpieza");

  assert.equal(await click('[data-testid="image-editor-save"]'), true);
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"]')`), "guardar y cerrar el fondo");
  const backdropAfter = await waitUntil(async () => {
    const state = await costumeState("backdrop");
    return state?.assetId && state.assetId !== backdropBefore.assetId ? state : null;
  }, "un nuevo assetId para Fondo 1");
  const savedBackdropPixels = await renderedAssetMetrics("backdrop");

  assert.equal(await click(".add-sprite"), true, "debe crear el primer sprite desde su botón");
  await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-testid="image-editor-save"]:not(:disabled)'))`), "el editor del primer disfraz");
  const spriteBefore = await costumeState("costume");
  const spriteInitial = await canvasMetrics();
  await drawStroke({x: 0.32, y: 0.35}, {x: 0.68, y: 0.66});
  const spriteStroke = await waitUntil(async () => {
    const metrics = await canvasMetrics();
    return metrics?.hash !== spriteInitial.hash && metrics.opaquePixels > spriteInitial.opaquePixels ? metrics : null;
  }, "el trazo del disfraz");

  const shapeMetrics = {};
  for (const [tool, from, to] of [
    ["line", {x: 0.1, y: 0.82}, {x: 0.9, y: 0.82}],
    ["rectangle", {x: 0.08, y: 0.08}, {x: 0.28, y: 0.28}],
    ["ellipse", {x: 0.72, y: 0.08}, {x: 0.92, y: 0.28}],
  ]) {
    await selectTool(tool);
    const before = await canvasMetrics();
    await drawStroke(from, to);
    shapeMetrics[tool] = await waitUntil(async () => {
      const metrics = await canvasMetrics();
      return metrics?.hash !== before.hash ? metrics : null;
    }, `dibujar con ${tool}`);
  }

  await selectTool("fill");
  const beforeFill = await canvasMetrics();
  await clickCanvasAt({x: 0.02, y: 0.02});
  const afterFill = await waitUntil(async () => {
    const metrics = await canvasMetrics();
    return metrics?.hash !== beforeFill.hash && metrics.opaquePixels > beforeFill.opaquePixels ? metrics : null;
  }, "rellenar el disfraz");

  assert.equal(await setDrawingColor("#ff0000"), "#ff0000", "debe cambiar el color antes de usar el cuentagotas");
  await selectTool("eyedropper");
  await clickCanvasAt({x: 0.02, y: 0.02});
  const sampledColor = await waitUntil(() => evaluate(`document.querySelector('[aria-label="Color de dibujo"]')?.value !== '#ff0000' && document.querySelector('[aria-label="Color de dibujo"]')?.value`), "muestrear un color");

  await selectTool("eraser");
  await drawStroke({x: 0.36, y: 0.36}, {x: 0.64, y: 0.64});
  const afterEraser = await waitUntil(async () => {
    const metrics = await canvasMetrics();
    return metrics?.opaquePixels < afterFill.opaquePixels ? metrics : null;
  }, "borrar píxeles del disfraz");
  assert.equal(await click('[data-testid="image-editor-save"]'), true);
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"]')`), "guardar y cerrar el disfraz");
  const spriteAfter = await waitUntil(async () => {
    const state = await costumeState("costume");
    return state?.assetId && state.assetId !== spriteBefore.assetId ? state : null;
  }, "un nuevo assetId para el disfraz");
  const savedSpritePixels = await renderedAssetMetrics("costume");

  const largeUploadStarted = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter(input => input.accept.includes('image/'));
    const input = inputs.at(-1);
    if (!(input instanceof HTMLInputElement)) return false;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="3000" viewBox="0 0 5000 3000"><rect width="5000" height="3000" fill="#4b67e8"/></svg>';
    const transfer = new DataTransfer();
    transfer.items.add(new File([svg], 'sprite-grande.svg', {type: 'image/svg+xml'}));
    Object.defineProperty(input, 'files', {configurable: true, value: transfer.files});
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  })()`);
  assert.equal(largeUploadStarted, true, "debe aceptar un sprite grande desde el selector de archivos");
  await waitUntil(() => evaluate(`document.querySelectorAll('.sprite-card').length === 2 && Boolean(document.querySelector('[data-testid="image-editor-save"]:not(:disabled)'))`), "el editor del sprite grande");
  const largeBefore = await editingCostumeDetails();
  const largeCanvas = await canvasMetrics();
  const randomized = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="image-editor-canvas"]');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    const image = context.createImageData(canvas.width, canvas.height);
    let seed = 0x9e3779b9;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      image.data[offset] = seed & 255;
      image.data[offset + 1] = (seed >>> 8) & 255;
      image.data[offset + 2] = (seed >>> 16) & 255;
      image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return true;
  })()`);
  assert.equal(randomized, true, "debe preparar una imagen de alta entropía para probar la optimización");
  // Commit the direct canvas fixture through the real pointer path so the
  // editor records it as a user edit instead of preserving the untouched SVG.
  await selectTool("brush");
  await drawStroke({x: 0.48, y: 0.48}, {x: 0.52, y: 0.52});
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"] [aria-label="Deshacer"]')?.disabled`), "registrar la edición grande");
  assert.equal(await click('[data-testid="image-editor-save"]'), true);
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"]')`), "optimizar y guardar el sprite grande", 30_000);
  const largeAfter = await waitUntil(async () => {
    const state = await editingCostumeDetails();
    return state?.assetId && state.assetId !== largeBefore.assetId ? state : null;
  }, "un nuevo asset optimizado para el sprite grande", 30_000);

  assert.equal(await click(".invite-button"), true, "debe compartir el proyecto antes de probar el rollback");
  await waitUntil(
    () => evaluate(`location.search.includes('project=') && Boolean(document.querySelector('.invite-modal'))`),
    "el proyecto compartido y su enlace de invitación",
    30_000,
  );
  assert.equal(await click(".modal-close"), true, "debe cerrar el enlace de invitación");
  await waitUntil(() => evaluate(`document.querySelector('.sync-pill')?.textContent?.includes('Sincronizado')`), "el checkpoint compartido inicial");

  assert.equal(await evaluate(`(() => {
    const sprite = document.querySelector('.sprite-card');
    if (!(sprite instanceof HTMLButtonElement) || sprite.disabled) return false;
    sprite.click();
    return true;
  })()`), true, "debe seleccionar un sprite pequeño para la prueba de rollback");
  const rollbackBefore = await waitUntil(() => evaluate(`(() => {
    const test = window.__LUMO_TEST__;
    const target = test?.vm?.editingTarget;
    const costume = target?.getCostumes?.()?.[target.currentCostume ?? 0];
    const targetStableId = target ? test.targetStableIds.get(target.id) : '';
    return target && !target.isStage && costume && targetStableId && costume.lumoMediaId ? {
      targetStableId,
      mediaId: String(costume.lumoMediaId),
      assetId: String(costume.assetId ?? costume.asset?.assetId ?? ''),
    } : null;
  })()`), "la identidad estable del disfraz previo al rollback");
  assert.ok(rollbackBefore.assetId, "el disfraz previo al rollback debe tener un assetId");
  await waitUntil(() => evaluate(`Boolean(document.querySelector('.asset-grid .asset-card.selected .edit'))`), "la tarjeta del disfraz que se probará");
  assert.equal(await click(".asset-grid .asset-card.selected .edit"), true, "debe abrir el disfraz para provocar el fallo de guardado");
  await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-testid="image-editor-save"]:not(:disabled)'))`), "el editor para la prueba de rollback");
  assert.equal(await setDrawingColor("#00c878"), "#00c878", "debe usar un color distinto en la edición que fallará");
  await drawStroke({x: 0.12, y: 0.18}, {x: 0.88, y: 0.72});
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"] [aria-label="Deshacer"]')?.disabled`), "registrar la edición que debe revertirse");

  assert.equal(await evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    const targetStableId = ${JSON.stringify(rollbackBefore.targetStableId)};
    const mediaId = ${JSON.stringify(rollbackBefore.mediaId)};
    const fixture = {
      nativeFetch,
      requests: [],
      failedPatch: 0,
      restore() {
        window.fetch = nativeFetch;
        delete window.__LUMO_IMAGE_ROLLBACK__;
      },
    };
    window.__LUMO_IMAGE_ROLLBACK__ = fixture;
    window.fetch = async (input, init = {}) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const path = new URL(requestUrl, location.href).pathname;
      if (method !== 'PATCH' || !/^\\/api\\/projects\\/[^/]+$/.test(path)) return nativeFetch(input, init);
      let body = null;
      try {
        if (typeof init.body === 'string') body = JSON.parse(init.body);
      } catch {}
      let attemptedAssetId = '';
      try {
        const project = JSON.parse(body?.state?.projectJson ?? '{}');
        const target = project.targets?.find(candidate => candidate.lumoTargetId === targetStableId);
        const costume = target?.costumes?.find(candidate => candidate.lumoMediaId === mediaId);
        attemptedAssetId = String(costume?.assetId ?? '');
      } catch {}
      fixture.requests.push({expectedVersion: body?.expectedVersion, attemptedAssetId});
      if (fixture.requests.length === 2) {
        fixture.failedPatch = 2;
        return new Response(JSON.stringify({error: 'Fallo 413 controlado por la prueba'}), {
          status: 413,
          headers: {'Content-Type': 'application/json'},
        });
      }
      return nativeFetch(input, init);
    };
    return true;
  })()`), true, "debe interceptar sólo el PATCH posterior a la mutación");

  assert.equal(await click('[data-testid="image-editor-save"]'), true, "debe intentar guardar la edición que recibirá 413");
  const rollbackImmediate = await waitUntil(() => evaluate(`(() => {
    const fixture = window.__LUMO_IMAGE_ROLLBACK__;
    const test = window.__LUMO_TEST__;
    const target = test?.vm?.runtime?.targets?.find(candidate =>
      candidate.isOriginal !== false && test.targetStableIds.get(candidate.id) === ${JSON.stringify(rollbackBefore.targetStableId)}
    );
    const costume = target?.getCostumes?.()?.find(candidate => candidate.lumoMediaId === ${JSON.stringify(rollbackBefore.mediaId)});
    const attemptedAssetId = fixture?.requests?.[1]?.attemptedAssetId ?? '';
    const attemptedActive = test?.vm?.runtime?.targets?.some(candidate => candidate.isOriginal !== false &&
      candidate.getCostumes?.()?.some(item => String(item.assetId ?? item.asset?.assetId ?? '') === attemptedAssetId));
    return fixture?.failedPatch === 2 && fixture.requests.length >= 2 &&
      document.querySelector('[data-testid="image-editor"]') &&
      String(costume?.assetId ?? costume?.asset?.assetId ?? '') === ${JSON.stringify(rollbackBefore.assetId)} ? {
        requests: fixture.requests,
        editorOpen: true,
        assetId: String(costume?.assetId ?? costume?.asset?.assetId ?? ''),
        attemptedAssetId,
        attemptedActive: Boolean(attemptedActive),
      } : null;
  })()`), "el rollback del VM después del 413", 30_000);
  assert.notEqual(rollbackImmediate.attemptedAssetId, rollbackBefore.assetId, "el segundo PATCH debe contener realmente el asset editado");
  assert.equal(rollbackImmediate.attemptedActive, false, "el asset rechazado no debe quedar activo tras el rollback");
  assert.equal(
    rollbackImmediate.requests[1].expectedVersion,
    rollbackImmediate.requests[0].expectedVersion + 1,
    "el primer PATCH debe ser el preflight aceptado y el segundo la mutación rechazada",
  );

  await delay(3_500);
  const rollbackLater = await evaluate(`(() => {
    const fixture = window.__LUMO_IMAGE_ROLLBACK__;
    const test = window.__LUMO_TEST__;
    const target = test?.vm?.runtime?.targets?.find(candidate =>
      candidate.isOriginal !== false && test.targetStableIds.get(candidate.id) === ${JSON.stringify(rollbackBefore.targetStableId)}
    );
    const costume = target?.getCostumes?.()?.find(candidate => candidate.lumoMediaId === ${JSON.stringify(rollbackBefore.mediaId)});
    const attemptedAssetId = fixture?.requests?.[1]?.attemptedAssetId ?? '';
    const attemptedActive = test?.vm?.runtime?.targets?.some(candidate => candidate.isOriginal !== false &&
      candidate.getCostumes?.()?.some(item => String(item.assetId ?? item.asset?.assetId ?? '') === attemptedAssetId));
    return {
      requestCount: fixture?.requests?.length ?? -1,
      editorOpen: Boolean(document.querySelector('[data-testid="image-editor"]')),
      assetId: String(costume?.assetId ?? costume?.asset?.assetId ?? ''),
      attemptedAssetId,
      attemptedActive: Boolean(attemptedActive),
    };
  })()`);
  assert.equal(rollbackLater.requestCount, 2, "el snapshot rechazado no debe reintentarse después del rollback");
  assert.equal(rollbackLater.editorOpen, true, "el editor debe seguir abierto después del rollback");
  assert.equal(rollbackLater.assetId, rollbackBefore.assetId, "el asset anterior debe seguir activo después de esperar");
  assert.equal(rollbackLater.attemptedActive, false, "el asset rechazado no debe reaparecer después de esperar");
  assert.equal(await evaluate(`(() => {
    const fixture = window.__LUMO_IMAGE_ROLLBACK__;
    if (!fixture) return false;
    fixture.restore();
    return true;
  })()`), true, "debe retirar la intercepción de red");
  assert.equal(await click('[aria-label="Cerrar editor"]'), true, "debe cerrar el editor tras verificar el rollback");
  await waitUntil(() => evaluate(`!document.querySelector('[data-testid="image-editor"]')`), "cerrar el editor tras el rollback");

  result = {
    blankProject,
    backdrop: {
      sourceFailureBlocked,
      sourceFailureReplacementEnabled,
      before: backdropBefore,
      unchanged: backdropUnchanged,
      initial: backdropInitial,
      stroke: backdropStroke,
      undo: backdropUndo,
      redo: backdropRedo,
      clear: backdropClear,
      clearUndo: backdropClearUndo,
      after: backdropAfter,
      savedPixels: savedBackdropPixels,
    },
    sprite: {
      before: spriteBefore,
      initial: spriteInitial,
      stroke: spriteStroke,
      shapes: shapeMetrics,
      fill: afterFill,
      sampledColor,
      eraser: afterEraser,
      after: spriteAfter,
      savedPixels: savedSpritePixels,
    },
    largeImage: {before: largeBefore, canvas: largeCanvas, after: largeAfter},
    rollback: {before: rollbackBefore, immediate: rollbackImmediate, later: rollbackLater},
    diagnostics,
  };
} finally {
  await Promise.race([
    send("Target.closeTarget", {targetId: target.id}).catch(() => {}),
    delay(1000),
  ]);
  socket.close();
}

console.log(JSON.stringify(result, null, 2));
assert.equal(result.blankProject.originalTargets, 1, "el proyecto inicial solo debe contener el escenario");
assert.equal(result.blankProject.sprites, 0, "el proyecto inicial no debe incluir sprites de relleno");
assert.equal(result.blankProject.backdrop, "Fondo 1");
assert.equal(result.blankProject.blocks, 0, "el proyecto inicial no debe incluir bloques de relleno");
assert.match(result.backdrop.initial.hash, /^[0-9a-f]{64}$/, "el fondo debe producir un hash SHA-256 reproducible");
assert.equal(result.backdrop.initial.width, 480, "el fondo inicial debe medir 480 píxeles lógicos");
assert.equal(result.backdrop.initial.height, 360, "el fondo inicial debe medir 360 píxeles lógicos");
assert.equal(result.backdrop.initial.opaquePixels, 480 * 360, "el fondo inicial debe ser blanco y opaco");
assert.equal(result.backdrop.initial.coloredPixels, 0, "el fondo inicial no debe contener una imagen de relleno");
assert.equal(result.backdrop.sourceFailureBlocked, true, "una fuente ilegible debe bloquear el guardado intacto");
assert.equal(result.backdrop.sourceFailureReplacementEnabled, true, "un trazo explícito debe habilitar un reemplazo seguro");
assert.equal(result.backdrop.unchanged.assetId, result.backdrop.before.assetId, "un guardado sin cambios no debe rasterizar el SVG");
assert.equal(result.backdrop.undo.hash, result.backdrop.initial.hash);
assert.equal(result.backdrop.redo.hash, result.backdrop.stroke.hash);
assert.equal(result.backdrop.clear.hash, result.backdrop.initial.hash);
assert.equal(result.backdrop.clearUndo.hash, result.backdrop.stroke.hash);
assert.notEqual(result.backdrop.after.assetId, result.backdrop.before.assetId);
assert.ok(result.backdrop.savedPixels?.coloredPixels > 0, "el asset guardado del fondo debe conservar el trazo");
assert.equal(result.sprite.before.spriteCount, 1, "el botón debe crear exactamente el primer sprite");
assert.equal(result.sprite.initial.opaquePixels, 0, "el primer disfraz debe comenzar transparente");
assert.ok(result.sprite.stroke.opaquePixels > 0, "el trazo debe producir píxeles visibles");
assert.notEqual(result.sprite.shapes.line.hash, result.sprite.stroke.hash, "la línea debe modificar el lienzo");
assert.notEqual(result.sprite.shapes.rectangle.hash, result.sprite.shapes.line.hash, "el rectángulo debe modificar el lienzo");
assert.notEqual(result.sprite.shapes.ellipse.hash, result.sprite.shapes.rectangle.hash, "la elipse debe modificar el lienzo");
assert.ok(result.sprite.fill.opaquePixels > result.sprite.shapes.ellipse.opaquePixels, "el relleno debe cubrir el área transparente");
assert.match(result.sprite.sampledColor, /^#[0-9a-f]{6}$/i, "el cuentagotas debe recuperar un color del lienzo");
assert.ok(result.sprite.eraser.opaquePixels < result.sprite.fill.opaquePixels, "el borrador debe recuperar transparencia");
assert.notEqual(result.sprite.after.assetId, result.sprite.before.assetId);
assert.ok(result.sprite.savedPixels?.opaquePixels > 0, "el asset guardado del disfraz debe conservar píxeles visibles");
assert.ok(result.sprite.savedPixels?.coloredPixels > 0, "el asset guardado del disfraz debe conservar el color dibujado");
assert.equal(result.largeImage.canvas.width, 2048, "el editor debe reducir el lienzo de trabajo grande de forma segura");
assert.equal(result.largeImage.canvas.height, 1229, "la reducción debe conservar la proporción 5:3");
assert.equal(result.largeImage.after.width, 5000, "guardar no debe encoger el tamaño lógico del sprite");
assert.equal(result.largeImage.after.height, 3000, "guardar no debe encoger la altura lógica del sprite");
assert.equal(result.largeImage.after.rotationCenterX, 2500, "debe conservar el centro de rotación horizontal");
assert.equal(result.largeImage.after.rotationCenterY, 1500, "debe conservar el centro de rotación vertical");
assert.ok(result.largeImage.after.byteLength <= 1_750_000, "una imagen válida debe optimizarse dentro del límite de colaboración");
assert.equal(result.rollback.immediate.editorOpen, true, "un fallo 413 debe mantener el editor abierto");
assert.equal(result.rollback.immediate.assetId, result.rollback.before.assetId, "un fallo 413 debe restaurar el asset anterior en el VM");
assert.equal(result.rollback.immediate.attemptedActive, false, "el asset rechazado no debe quedar activo en el VM");
assert.equal(result.rollback.later.requestCount, 2, "el guardado rechazado no debe reaparecer mediante un reintento tardío");
assert.equal(result.rollback.later.assetId, result.rollback.before.assetId, "el rollback debe permanecer estable");
assert.equal(result.rollback.later.attemptedActive, false, "el asset rechazado no debe reaparecer en el VM");
assert.deepEqual(result.diagnostics, [], "el editor no debe producir excepciones ni errores de consola");
