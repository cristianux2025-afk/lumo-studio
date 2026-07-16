import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the finished Lumo Studio editor", async () => {
  const [page, studio, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/LumoStudio.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  assert.match(page, /<LumoStudio/);
  assert.match(studio, /scratch-blocks/);
  assert.match(studio, /@scratch\/scratch-vm/);
  assert.match(studio, /Invitar/);
  assert.match(studio, /Edición compartida activa/);
  assert.match(layout, /lang="es"/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(page, /codex-preview|SkeletonPreview/i);
});

test("includes collaboration APIs, persistence, and production output", async () => {
  const [hosting, projectApi, collaboration] = await Promise.all([
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("app/api/projects/[id]/route.ts", root), "utf8"),
    readFile(new URL("db/collaboration.ts", root), "utf8"),
  ]);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(projectApi, /action === "comment"/);
  assert.match(projectApi, /INSERT INTO presence/);
  assert.match(collaboration, /CREATE TABLE IF NOT EXISTS projects/);
  await access(new URL("dist/server/index.js", root));
  await access(new URL("public/og.png", root));
});
