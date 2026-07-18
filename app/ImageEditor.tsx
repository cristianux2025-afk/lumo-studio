"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type ImageEditorKind = "costume" | "backdrop";

export type ImageEditorDocument = {
  id?: string;
  name: string;
  kind: ImageEditorKind;
  dataUri?: string;
  sourceExpected?: boolean;
  width?: number;
  height?: number;
  rotationCenterX?: number;
  rotationCenterY?: number;
  background?: "transparent" | "white";
  targetId: string;
  targetStableId: string;
  mediaId: string;
  index: number;
};

export type ImageEditorResult = {
  id?: string;
  name: string;
  kind: ImageEditorKind;
  svg: string;
  svgDataUri: string;
  pngDataUri: string;
  width: number;
  height: number;
  rotationCenterX: number;
  rotationCenterY: number;
};

export type ImageEditorProps = {
  document: ImageEditorDocument;
  maxAssetBytes?: number;
  onClose: () => void;
  onSave: (result: ImageEditorResult) => Promise<boolean>;
};

type Tool = "brush" | "eraser" | "line" | "rectangle" | "ellipse" | "fill" | "eyedropper";
type Point = {x: number; y: number};
type HistorySnapshot = {image: ImageData; hash: number; bytes: number; original: boolean};

const MAX_HISTORY = 32;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const MAX_CANVAS_SIDE = 2048;
const MAX_LOGICAL_SIDE = 32_768;
const DEFAULT_MAX_ASSET_BYTES = 1_750_000;

const tools: ReadonlyArray<{id: Tool; label: string; icon: string; shortcut?: string}> = [
  {id: "brush", label: "Pincel", icon: "✎", shortcut: "B"},
  {id: "eraser", label: "Borrador", icon: "⌫", shortcut: "E"},
  {id: "line", label: "Línea", icon: "╱", shortcut: "L"},
  {id: "rectangle", label: "Rectángulo", icon: "□", shortcut: "R"},
  {id: "ellipse", label: "Elipse", icon: "○", shortcut: "O"},
  {id: "fill", label: "Relleno", icon: "▰", shortcut: "F"},
  {id: "eyedropper", label: "Cuentagotas", icon: "◉", shortcut: "I"},
];

function clampInteger(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_CANVAS_SIDE, Math.max(1, Math.round(value as number)));
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("No se pudo abrir la imagen"));
    image.src = source;
  });
}

function xmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlAttribute(value: string) {
  return xmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function svgWithRaster(width: number, height: number, name: string, dataUri: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${xmlText(name)}</title><image width="${width}" height="${height}" preserveAspectRatio="none" href="${xmlAttribute(dataUri)}"/></svg>`;
}

function svgTextFromDataUri(dataUri: string | undefined) {
  if (!dataUri?.startsWith("data:image/svg+xml")) return null;
  const separator = dataUri.indexOf(",");
  if (separator < 0) return null;
  try {
    const header = dataUri.slice(0, separator);
    const payload = dataUri.slice(separator + 1);
    if (header.includes(";base64")) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

function imageHash(data: Uint8ClampedArray) {
  let hash = 2166136261;
  const words = new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4));
  for (let index = 0; index < words.length; index += 1) {
    hash ^= words[index];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function canvasDataUri(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<string | null>(resolve => {
    canvas.toBlob(blob => {
      if (!blob) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }, type, quality);
  });
}

async function exportCanvasWithinLimit(
  source: HTMLCanvasElement,
  name: string,
  kind: ImageEditorKind,
  maxBytes: number,
  outputWidth: number,
  outputHeight: number,
) {
  const encoder = new TextEncoder();
  const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.22, 0.15, 0.1];
  const qualities = [0.92, 0.82, 0.72, 0.6, 0.48, 0.36];
  let smallest: {dataUri: string; svg: string; bytes: number; optimized: boolean} | null = null;
  const sourcePixels = source.getContext("2d", {willReadFrequently: true})?.getImageData(0, 0, source.width, source.height).data;
  let opaque = true;
  if (sourcePixels) {
    for (let offset = 3; offset < sourcePixels.length; offset += 4) {
      if (sourcePixels[offset] !== 255) {
        opaque = false;
        break;
      }
    }
  }

  const consider = (dataUri: string, scale: number) => {
    const svg = svgWithRaster(outputWidth, outputHeight, name, dataUri);
    const bytes = encoder.encode(svg).byteLength;
    const candidate = {dataUri, svg, bytes, optimized: scale !== 1 || !dataUri.startsWith("data:image/png")};
    if (!smallest || bytes < smallest.bytes) smallest = candidate;
    return bytes <= maxBytes ? candidate : null;
  };

  for (const scale of scales) {
    const canvas = scale === 1 ? source : globalThis.document.createElement("canvas");
    if (scale !== 1) {
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
    }

    if (scale === 1) {
      const pngDataUri = await canvasDataUri(canvas, "image/png");
      const png = pngDataUri ? consider(pngDataUri, scale) : null;
      if (png) return png;
    }
    for (const quality of qualities) {
      const webpDataUri = await canvasDataUri(canvas, "image/webp", quality);
      const webp = webpDataUri ? consider(webpDataUri, scale) : null;
      if (webp) return webp;
    }
    if (kind === "backdrop" && opaque) {
      for (const quality of qualities) {
        const jpegDataUri = await canvasDataUri(canvas, "image/jpeg", quality);
        const jpeg = jpegDataUri ? consider(jpegDataUri, scale) : null;
        if (jpeg) return jpeg;
      }
    }
  }

  return smallest;
}

function parseColor(color: string): [number, number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : "6756e8";
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    255,
  ];
}

function pixelMatches(data: Uint8ClampedArray, offset: number, target: readonly number[]) {
  return data[offset] === target[0]
    && data[offset + 1] === target[1]
    && data[offset + 2] === target[2]
    && data[offset + 3] === target[3];
}

function floodFill(context: CanvasRenderingContext2D, point: Point, color: string) {
  const {width, height} = context.canvas;
  const startX = Math.max(0, Math.min(width - 1, Math.floor(point.x)));
  const startY = Math.max(0, Math.min(height - 1, Math.floor(point.y)));
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const startOffset = (startY * width + startX) * 4;
  const target = [data[startOffset], data[startOffset + 1], data[startOffset + 2], data[startOffset + 3]] as const;
  const replacement = parseColor(color);
  if (target.every((channel, index) => channel === replacement[index])) return false;

  const seeds: Point[] = [{x: startX, y: startY}];
  const matches = (x: number, y: number) => pixelMatches(data, (y * width + x) * 4, target);
  const replace = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    data[offset] = replacement[0];
    data[offset + 1] = replacement[1];
    data[offset + 2] = replacement[2];
    data[offset + 3] = replacement[3];
  };

  while (seeds.length) {
    const seed = seeds.pop();
    if (!seed || !matches(seed.x, seed.y)) continue;
    let x = seed.x;
    while (x > 0 && matches(x - 1, seed.y)) x -= 1;
    let aboveOpen = false;
    let belowOpen = false;
    for (; x < width && matches(x, seed.y); x += 1) {
      replace(x, seed.y);
      if (seed.y > 0) {
        const matchesAbove = matches(x, seed.y - 1);
        if (matchesAbove && !aboveOpen) seeds.push({x, y: seed.y - 1});
        aboveOpen = matchesAbove;
      }
      if (seed.y < height - 1) {
        const matchesBelow = matches(x, seed.y + 1);
        if (matchesBelow && !belowOpen) seeds.push({x, y: seed.y + 1});
        belowOpen = matchesBelow;
      }
    }
  }
  context.putImageData(image, 0, 0);
  return true;
}

function pointOnCanvas(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.min(canvas.width - 0.001, Math.max(0, (clientX - bounds.left) * (canvas.width / Math.max(1, bounds.width)))),
    y: Math.min(canvas.height - 0.001, Math.max(0, (clientY - bounds.top) * (canvas.height / Math.max(1, bounds.height)))),
  };
}

function drawDot(context: CanvasRenderingContext2D, point: Point, color: string, width: number, erase: boolean) {
  context.save();
  context.globalCompositeOperation = erase ? "destination-out" : "source-over";
  context.fillStyle = erase ? "rgba(0,0,0,1)" : color;
  context.beginPath();
  context.arc(point.x, point.y, Math.max(0.5, width / 2), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawStroke(context: CanvasRenderingContext2D, from: Point, to: Point, color: string, width: number, erase: boolean) {
  context.save();
  context.globalCompositeOperation = erase ? "destination-out" : "source-over";
  context.strokeStyle = erase ? "rgba(0,0,0,1)" : color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.restore();
}

function drawShape(context: CanvasRenderingContext2D, tool: Tool, from: Point, to: Point, color: string, width: number) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (tool === "line") {
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
  } else if (tool === "rectangle") {
    context.rect(from.x, from.y, to.x - from.x, to.y - from.y);
  } else if (tool === "ellipse") {
    const centerX = (from.x + to.x) / 2;
    const centerY = (from.y + to.y) / 2;
    context.ellipse(centerX, centerY, Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2);
  }
  context.stroke();
  context.restore();
}

function toolCursor(tool: Tool) {
  if (tool === "fill") return "cell";
  if (tool === "eyedropper") return "copy";
  if (tool === "eraser") return "crosshair";
  return "crosshair";
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 130,
  display: "grid",
  placeItems: "center",
  padding: 16,
  background: "rgba(18,25,48,.62)",
  backdropFilter: "blur(5px)",
};

const dialogStyle: CSSProperties = {
  width: "min(1180px, 100%)",
  maxHeight: "calc(100vh - 32px)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  border: "1px solid #dce3ef",
  borderRadius: 18,
  background: "#fff",
  color: "#17223b",
  boxShadow: "0 30px 80px rgba(15,22,48,.34)",
};

const buttonStyle: CSSProperties = {
  minHeight: 36,
  border: "1px solid #dce3ef",
  borderRadius: 9,
  padding: "7px 10px",
  background: "#fff",
  color: "#536078",
  fontSize: 12,
  fontWeight: 750,
  cursor: "pointer",
};

export function ImageEditor({document, maxAssetBytes = DEFAULT_MAX_ASSET_BYTES, onClose, onSave}: ImageEditorProps) {
  const defaultWidth = document.kind === "backdrop" ? 480 : 320;
  const defaultHeight = document.kind === "backdrop" ? 360 : 320;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const historyRef = useRef<HistorySnapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const activePointerRef = useRef<number | null>(null);
  const startPointRef = useRef<Point | null>(null);
  const lastPointRef = useRef<Point | null>(null);
  const interactionBaseRef = useRef<ImageData | null>(null);
  const interactionChangedRef = useRef(false);
  const restoreTokenRef = useRef(0);
  const restoringRef = useRef(true);
  const savingRef = useRef(false);
  const rotationCenterRef = useRef<Point | null>(null);
  const outputDimensionsRef = useRef({width: defaultWidth, height: defaultHeight});
  const originalSvgRef = useRef<string | null>(null);

  const [name, setName] = useState(document.name);
  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColor] = useState("#6756e8");
  const [lineWidth, setLineWidth] = useState(8);
  const [zoom, setZoom] = useState(100);
  const [dimensions, setDimensions] = useState({
    width: clampInteger(document.width, defaultWidth),
    height: clampInteger(document.height, defaultHeight),
  });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyLength, setHistoryLength] = useState(0);
  const [historyOriginal, setHistoryOriginal] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sourceLoadFailed, setSourceLoadFailed] = useState(false);
  const [status, setStatus] = useState("Preparando el lienzo…");

  const context = useCallback(() => canvasRef.current?.getContext("2d", {willReadFrequently: true}) ?? null, []);

  const setHistoryPosition = useCallback((index: number, length = historyRef.current.length) => {
    historyIndexRef.current = index;
    setHistoryIndex(index);
    setHistoryLength(length);
    setHistoryOriginal(Boolean(historyRef.current[index]?.original));
  }, []);

  const recordHistory = useCallback(() => {
    const canvas = canvasRef.current;
    const drawingContext = context();
    if (!canvas || !drawingContext) return false;
    try {
      const image = drawingContext.getImageData(0, 0, canvas.width, canvas.height);
      const snapshot: HistorySnapshot = {image, hash: imageHash(image.data), bytes: image.data.byteLength, original: historyRef.current.length === 0};
      const current = historyRef.current[historyIndexRef.current];
      if (current && current.hash === snapshot.hash && current.image.width === image.width && current.image.height === image.height) return false;
      const next = historyRef.current.slice(0, historyIndexRef.current + 1);
      next.push(snapshot);
      let retainedBytes = next.reduce((total, item) => total + item.bytes, 0);
      while (next.length > 2 && (next.length > MAX_HISTORY || retainedBytes > MAX_HISTORY_BYTES)) {
        retainedBytes -= next.shift()?.bytes ?? 0;
      }
      historyRef.current = next;
      setHistoryPosition(next.length - 1, next.length);
      return true;
    } catch {
      setStatus("El navegador no permitió guardar esta edición en el historial.");
      return false;
    }
  }, [context, setHistoryPosition]);

  const restoreSnapshot = useCallback((source: HistorySnapshot, index: number, message: string) => {
    const canvas = canvasRef.current;
    const drawingContext = context();
    if (!canvas || !drawingContext || restoringRef.current || savingRef.current) return;
    const token = ++restoreTokenRef.current;
    restoringRef.current = true;
    setRestoring(true);
    try {
      if (token !== restoreTokenRef.current) return;
      drawingContext.clearRect(0, 0, canvas.width, canvas.height);
      drawingContext.putImageData(source.image, 0, 0);
      setHistoryPosition(index);
      setStatus(message);
    } catch {
      setStatus("No se pudo restaurar ese paso.");
    } finally {
      if (token === restoreTokenRef.current) {
        restoringRef.current = false;
        setRestoring(false);
      }
    }
  }, [context, setHistoryPosition]);

  const undo = useCallback(() => {
    const next = historyIndexRef.current - 1;
    if (next < 0 || restoringRef.current || savingRef.current || activePointerRef.current !== null) return;
    restoreSnapshot(historyRef.current[next], next, "Cambio deshecho");
  }, [restoreSnapshot]);

  const redo = useCallback(() => {
    const next = historyIndexRef.current + 1;
    if (next >= historyRef.current.length || restoringRef.current || savingRef.current || activePointerRef.current !== null) return;
    restoreSnapshot(historyRef.current[next], next, "Cambio rehecho");
  }, [restoreSnapshot]);

  const finishInteraction = useCallback((commit: boolean) => {
    const drawingContext = context();
    if (!commit && drawingContext && interactionBaseRef.current) {
      drawingContext.putImageData(interactionBaseRef.current, 0, 0);
    }
    const changed = interactionChangedRef.current;
    activePointerRef.current = null;
    startPointRef.current = null;
    lastPointRef.current = null;
    interactionBaseRef.current = null;
    interactionChangedRef.current = false;
    if (commit && changed && recordHistory()) setStatus("Edición aplicada");
  }, [context, recordHistory]);

  const updateInteraction = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    const drawingContext = context();
    if (!drawingContext) return;
    const point = pointOnCanvas(event.currentTarget, event.clientX, event.clientY);
    const start = startPointRef.current;
    const previous = lastPointRef.current;
    if (!start || !previous) return;
    if (tool === "brush" || tool === "eraser") {
      const eraseTransparency = tool === "eraser" && document.kind !== "backdrop";
      drawStroke(drawingContext, previous, point, tool === "eraser" ? "#ffffff" : color, lineWidth, eraseTransparency);
      interactionChangedRef.current = true;
    } else if ((tool === "line" || tool === "rectangle" || tool === "ellipse") && interactionBaseRef.current) {
      drawingContext.putImageData(interactionBaseRef.current, 0, 0);
      drawShape(drawingContext, tool, start, point, color, lineWidth);
      interactionChangedRef.current = Math.abs(point.x - start.x) + Math.abs(point.y - start.y) > 0.5;
    }
    lastPointRef.current = point;
  }, [color, context, document.kind, lineWidth, tool]);

  const beginInteraction = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (restoringRef.current || savingRef.current || event.button !== 0) return;
    event.preventDefault();
    const canvas = event.currentTarget;
    const drawingContext = context();
    if (!drawingContext) return;
    const point = pointOnCanvas(canvas, event.clientX, event.clientY);
    canvas.setPointerCapture(event.pointerId);

    if (tool === "eyedropper") {
      const pixel = drawingContext.getImageData(Math.floor(point.x), Math.floor(point.y), 1, 1).data;
      if (pixel[3] > 0) {
        const sampled = `#${[pixel[0], pixel[1], pixel[2]].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
        setColor(sampled);
        setStatus(`Color seleccionado: ${sampled.toUpperCase()}`);
      } else {
        setStatus("Ese punto es transparente");
      }
      canvas.releasePointerCapture(event.pointerId);
      return;
    }

    if (tool === "fill") {
      if (floodFill(drawingContext, point, color) && recordHistory()) setStatus("Área rellenada");
      canvas.releasePointerCapture(event.pointerId);
      return;
    }

    activePointerRef.current = event.pointerId;
    startPointRef.current = point;
    lastPointRef.current = point;
    interactionBaseRef.current = drawingContext.getImageData(0, 0, canvas.width, canvas.height);
    interactionChangedRef.current = false;
    if (tool === "brush" || tool === "eraser") {
      const eraseTransparency = tool === "eraser" && document.kind !== "backdrop";
      drawDot(drawingContext, point, tool === "eraser" ? "#ffffff" : color, lineWidth, eraseTransparency);
      interactionChangedRef.current = true;
    }
  }, [color, context, document.kind, lineWidth, recordHistory, tool]);

  const endInteraction = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    updateInteraction(event);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be gone when the browser cancels a touch.
    }
    finishInteraction(true);
  }, [finishInteraction, updateInteraction]);

  const cancelInteraction = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    finishInteraction(false);
    setStatus("Trazo cancelado");
  }, [finishInteraction]);

  const clearCanvas = useCallback(() => {
    if (restoringRef.current || savingRef.current) return;
    const canvas = canvasRef.current;
    const drawingContext = context();
    if (!canvas || !drawingContext) return;
    drawingContext.clearRect(0, 0, canvas.width, canvas.height);
    if ((document.background ?? (document.kind === "backdrop" ? "white" : "transparent")) === "white") {
      drawingContext.fillStyle = "#ffffff";
      drawingContext.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (recordHistory()) setStatus("Lienzo limpiado");
  }, [context, document.background, document.kind, recordHistory]);

  const save = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || savingRef.current || restoringRef.current) return;
    if (sourceLoadFailed && historyRef.current[historyIndexRef.current]?.original) {
      setStatus("La imagen original no se pudo abrir. Dibuja un reemplazo o cancela para conservarla.");
      return;
    }
    const safeName = name.trim() || (document.kind === "backdrop" ? "Fondo" : "Disfraz");
    savingRef.current = true;
    setSaving(true);
    setStatus("Guardando imagen…");
    try {
      const outputDimensions = outputDimensionsRef.current;
      const originalSvg = historyRef.current[historyIndexRef.current]?.original ? originalSvgRef.current : null;
      const originalBytes = originalSvg ? new TextEncoder().encode(originalSvg).byteLength : 0;
      const exported = originalSvg && originalBytes <= maxAssetBytes
        ? {dataUri: document.dataUri ?? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(originalSvg)}`, svg: originalSvg, bytes: originalBytes, optimized: false}
        : await exportCanvasWithinLimit(canvas, safeName, document.kind, maxAssetBytes, outputDimensions.width, outputDimensions.height);
      if (!exported || exported.bytes > maxAssetBytes) {
        setStatus("La imagen sigue siendo demasiado grande para guardarla.");
        return;
      }
      const center = rotationCenterRef.current;
      const result: ImageEditorResult = {
        id: document.id,
        name: safeName,
        kind: document.kind,
        svg: exported.svg,
        svgDataUri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exported.svg)}`,
        pngDataUri: exported.dataUri,
        width: outputDimensions.width,
        height: outputDimensions.height,
        rotationCenterX: center?.x ?? outputDimensions.width / 2,
        rotationCenterY: center?.y ?? outputDimensions.height / 2,
      };
      if (await onSave(result)) {
        setStatus(exported.optimized ? "Imagen optimizada y guardada" : "Imagen guardada");
        onClose();
      } else {
        setStatus("No se pudo guardar. Tu dibujo sigue abierto.");
      }
    } catch {
      setStatus("No se pudo guardar. Tu dibujo sigue abierto.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [document.dataUri, document.id, document.kind, maxAssetBytes, name, onClose, onSave, sourceLoadFailed]);

  useEffect(() => {
    let alive = true;
    const initialise = async () => {
      await Promise.resolve();
      const canvas = canvasRef.current;
      if (!alive || !canvas) return;
      restoringRef.current = true;
      setRestoring(true);
      setSourceLoadFailed(false);
      originalSvgRef.current = svgTextFromDataUri(document.dataUri);
      const fallbackWidth = document.kind === "backdrop" ? 480 : 320;
      const fallbackHeight = document.kind === "backdrop" ? 360 : 320;
      let image: HTMLImageElement | null = null;
      let loadFailed = Boolean(document.sourceExpected && !document.dataUri);
      if (document.dataUri) {
        try {
          image = await loadImage(document.dataUri);
        } catch {
          loadFailed = true;
        }
      }
      if (!alive) return;
      const sourceWidth = Number.isFinite(document.width) && Number(document.width) > 0
        ? Number(document.width)
        : image?.naturalWidth || fallbackWidth;
      const sourceHeight = Number.isFinite(document.height) && Number(document.height) > 0
        ? Number(document.height)
        : image?.naturalHeight || fallbackHeight;
      const logicalScale = Math.min(1, MAX_LOGICAL_SIDE / sourceWidth, MAX_LOGICAL_SIDE / sourceHeight);
      const outputWidth = Math.max(1, Math.round(sourceWidth * logicalScale));
      const outputHeight = Math.max(1, Math.round(sourceHeight * logicalScale));
      const canvasScale = Math.min(1, MAX_CANVAS_SIDE / outputWidth, MAX_CANVAS_SIDE / outputHeight);
      const width = Math.max(1, Math.round(outputWidth * canvasScale));
      const height = Math.max(1, Math.round(outputHeight * canvasScale));
      outputDimensionsRef.current = {width: outputWidth, height: outputHeight};
      canvas.width = width;
      canvas.height = height;
      setDimensions({width, height});
      setName(document.name);
      const drawingContext = canvas.getContext("2d", {willReadFrequently: true});
      if (!drawingContext) {
        setStatus("Este navegador no ofrece un lienzo 2D compatible.");
        restoringRef.current = false;
        setRestoring(false);
        return;
      }
      drawingContext.clearRect(0, 0, width, height);
      // Do not composite an existing transparent image over white. The
      // background preference applies only to a genuinely empty canvas and to
      // the explicit Clear action.
      if (!image && (document.background ?? (document.kind === "backdrop" ? "white" : "transparent")) === "white") {
        drawingContext.fillStyle = "#ffffff";
        drawingContext.fillRect(0, 0, width, height);
      }
      let drawX = 0;
      let drawY = 0;
      let drawWidth = width;
      let drawHeight = height;
      if (image) {
        const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        drawWidth = image.naturalWidth * scale;
        drawHeight = image.naturalHeight * scale;
        drawX = (width - drawWidth) / 2;
        drawY = (height - drawHeight) / 2;
        drawingContext.drawImage(image, drawX, drawY, drawWidth, drawHeight);
      }
      rotationCenterRef.current = {
        x: Number.isFinite(document.rotationCenterX)
          ? Number(document.rotationCenterX) * (outputWidth / sourceWidth)
          : outputWidth / 2,
        y: Number.isFinite(document.rotationCenterY)
          ? Number(document.rotationCenterY) * (outputHeight / sourceHeight)
          : outputHeight / 2,
      };
      historyRef.current = [];
      historyIndexRef.current = -1;
      recordHistory();
      setSourceLoadFailed(loadFailed);
      setStatus(loadFailed
        ? "La imagen original no se pudo abrir. Dibuja un reemplazo o cancela para conservarla."
        : `${document.kind === "backdrop" ? "Fondo" : "Disfraz"} listo para editar`);
      restoringRef.current = false;
      setRestoring(false);
    };
    void initialise();
    return () => {
      alive = false;
      restoreTokenRef.current += 1;
    };
  }, [document.background, document.dataUri, document.height, document.kind, document.name, document.rotationCenterX, document.rotationCenterY, document.sourceExpected, document.width, recordHistory]);

  useEffect(() => {
    previousFocusRef.current = globalThis.document.activeElement instanceof HTMLElement
      ? globalThis.document.activeElement
      : null;
    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!savingRef.current) onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [])];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && globalThis.document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && globalThis.document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      const target = event.target;
      const editingText = target instanceof HTMLInputElement && ["text", "number"].includes(target.type);
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "z" && !editingText) {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if (modifier && event.key.toLowerCase() === "y" && !editingText) {
        event.preventDefault();
        redo();
        return;
      }
      if (!modifier && !event.altKey && !editingText) {
        const selected = tools.find(candidate => candidate.shortcut?.toLowerCase() === event.key.toLowerCase());
        if (selected) setTool(selected.id);
      }
    };
    globalThis.document.addEventListener("keydown", handleKeyDown);
    return () => globalThis.document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, redo, undo]);

  const canUndo = historyIndex > 0 && !restoring && !saving;
  const canRedo = historyIndex >= 0 && historyIndex < historyLength - 1 && !restoring && !saving;
  const saveBlockedBySourceFailure = sourceLoadFailed && historyOriginal;
  const scaledWidth = Math.max(1, dimensions.width * zoom / 100);
  const scaledHeight = Math.max(1, dimensions.height * zoom / 100);

  return (
    <div
      style={overlayStyle}
      role="presentation"
      data-testid="image-editor"
      onPointerDown={event => {
        if (event.target === event.currentTarget && !savingRef.current) onClose();
      }}
    >
      <section
        ref={dialogRef}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-editor-title"
        aria-describedby="image-editor-help"
        aria-busy={saving || restoring}
      >
        <header style={{display: "flex", alignItems: "center", gap: 12, padding: "13px 15px", borderBottom: "1px solid #e7ebf2"}}>
          <div style={{minWidth: 0, flex: 1}}>
            <h2 id="image-editor-title" style={{margin: 0, fontSize: 18}}>Editor de {document.kind === "backdrop" ? "fondos" : "disfraces"}</h2>
            <p id="image-editor-help" style={{margin: "3px 0 0", color: "#6c7890", fontSize: 11}}>
              Dibuja con el puntero o con el dedo. Usa Ctrl/Cmd+Z para deshacer y Escape para cerrar.
            </p>
          </div>
          <label style={{display: "grid", gap: 3, color: "#69758b", fontSize: 9, fontWeight: 800}}>
            NOMBRE
            <input
              type="text"
              value={name}
              maxLength={80}
              onChange={event => setName(event.target.value)}
              style={{width: "min(260px, 32vw)", border: "1px solid #dce3ef", borderRadius: 8, padding: "7px 9px", color: "#17223b"}}
            />
          </label>
          <button ref={closeButtonRef} type="button" style={{...buttonStyle, width: 38, padding: 0, fontSize: 20}} onClick={onClose} disabled={saving} aria-label="Cerrar editor">×</button>
        </header>

        <div role="toolbar" aria-label="Herramientas de dibujo" style={{display: "flex", alignItems: "end", flexWrap: "wrap", gap: 7, padding: "10px 12px", borderBottom: "1px solid #e7ebf2", background: "#f8f9fc"}}>
          {tools.map(candidate => {
            const active = candidate.id === tool;
            return (
              <button
                key={candidate.id}
                type="button"
                data-testid={`image-editor-tool-${candidate.id}`}
                aria-pressed={active}
                aria-label={`${candidate.label}${candidate.shortcut ? ` (${candidate.shortcut})` : ""}`}
                title={`${candidate.label}${candidate.shortcut ? ` · ${candidate.shortcut}` : ""}`}
                onClick={() => setTool(candidate.id)}
                style={{...buttonStyle, minWidth: 42, background: active ? "#6756e8" : "#fff", borderColor: active ? "#6756e8" : "#dce3ef", color: active ? "#fff" : "#536078", fontSize: 17}}
              >
                <span aria-hidden="true">{candidate.icon}</span>
              </button>
            );
          })}
          <span aria-hidden="true" style={{width: 1, height: 36, background: "#dce3ef", marginInline: 2}} />
          <label style={{display: "grid", gap: 3, color: "#69758b", fontSize: 9, fontWeight: 800}}>
            COLOR
            <input type="color" value={color} onChange={event => setColor(event.target.value)} aria-label="Color de dibujo" style={{width: 43, height: 36, padding: 3, border: "1px solid #dce3ef", borderRadius: 8, background: "#fff", cursor: "pointer"}} />
          </label>
          <label style={{display: "grid", gap: 3, color: "#69758b", fontSize: 9, fontWeight: 800}}>
            GROSOR {lineWidth}px
            <input type="range" min={1} max={80} value={lineWidth} onChange={event => setLineWidth(Number(event.target.value))} aria-label="Grosor del trazo" style={{width: 120}} />
          </label>
          <label style={{display: "grid", gap: 3, color: "#69758b", fontSize: 9, fontWeight: 800}}>
            ZOOM {zoom}%
            <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={25} value={zoom} onChange={event => setZoom(Number(event.target.value))} aria-label="Zoom del lienzo" style={{width: 120}} />
          </label>
          <span style={{flex: 1}} />
          <button type="button" style={buttonStyle} onClick={undo} disabled={!canUndo} aria-label="Deshacer" aria-keyshortcuts="Control+Z Meta+Z">↶ Deshacer</button>
          <button type="button" style={buttonStyle} onClick={redo} disabled={!canRedo} aria-label="Rehacer" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z">↷ Rehacer</button>
          <button type="button" style={{...buttonStyle, color: "#b44755"}} onClick={clearCanvas} disabled={restoring || saving}>Limpiar</button>
        </div>

        <main style={{minHeight: 240, flex: 1, overflow: "auto", display: "grid", placeItems: "center", padding: 24, background: "#e8ecf3"}}>
          <div style={{lineHeight: 0, boxShadow: "0 8px 28px rgba(31,40,70,.19)", background: "repeating-conic-gradient(#e5e8ee 0 25%,#fff 0 50%) 0 / 18px 18px"}}>
            <canvas
              ref={canvasRef}
              data-testid="image-editor-canvas"
              tabIndex={0}
              aria-label={`Lienzo para editar ${document.kind === "backdrop" ? "el fondo" : "el disfraz"} ${name || "sin nombre"}`}
              onPointerDown={beginInteraction}
              onPointerMove={updateInteraction}
              onPointerUp={endInteraction}
              onPointerCancel={cancelInteraction}
              style={{display: "block", width: scaledWidth, height: scaledHeight, maxWidth: "none", touchAction: "none", cursor: toolCursor(tool), background: "transparent"}}
            />
          </div>
        </main>

        <footer style={{display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderTop: "1px solid #e7ebf2", background: "#fff"}}>
          <span role="status" aria-live="polite" style={{minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#68758b", fontSize: 11}}>{status}</span>
          <small style={{color: "#8b96a8"}}>{dimensions.width} × {dimensions.height}px</small>
          <button type="button" style={buttonStyle} onClick={onClose} disabled={saving}>Cancelar</button>
          <button
            type="button"
            data-testid="image-editor-save"
            style={{...buttonStyle, minWidth: 120, borderColor: "#6756e8", background: "#6756e8", color: "#fff"}}
            onClick={() => void save()}
            disabled={saving || restoring || saveBlockedBySourceFailure}
          >
            {saving ? "Guardando…" : "Guardar imagen"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default ImageEditor;
