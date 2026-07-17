"use strict";

// Drop-in replacement for startaudiocontext's legacy requestAnimationFrame
// polling. Browsers require a trusted user gesture; retrying resume() on every
// frame only creates console noise and needless CPU usage while the tab waits.
module.exports = function startAudioContext(context, elements, callback) {
  if (typeof document === "undefined") return Promise.resolve(context);
  const targets = elements
    ? (typeof elements === "string" ? [...document.querySelectorAll(elements)] : (Symbol.iterator in Object(elements) && !(elements instanceof Element) ? [...elements] : [elements]))
    : [document.body];
  const eventNames = ["pointerup", "touchend", "keydown"];
  let settled = false;
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });

  const cleanup = () => {
    for (const target of targets) {
      for (const eventName of eventNames) target?.removeEventListener?.(eventName, unlock, true);
    }
    context.removeEventListener?.("statechange", finish);
  };
  const finish = () => {
    if (settled || context.state !== "running") return;
    settled = true;
    cleanup();
    callback?.();
    resolveStarted(context);
  };
  const unlock = () => {
    try {
      const buffer = context.createBuffer(1, 1, context.sampleRate);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0);
    } catch {}
    Promise.resolve(context.resume?.()).then(finish).catch(() => undefined);
  };

  if (context.state === "running") {
    finish();
  } else {
    context.addEventListener?.("statechange", finish);
    for (const target of targets) {
      for (const eventName of eventNames) target?.addEventListener?.(eventName, unlock, {capture: true, passive: true});
    }
  }
  return started;
};
