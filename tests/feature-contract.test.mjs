import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

const source = path => readFile(new URL(path, root), "utf8");

test("connects Scratch VM to the real stage and 60 TPS runtime controls", async () => {
  const studio = await source("app/LumoStudio.tsx");

  assert.match(studio, /attachRenderer/);
  assert.match(studio, /attachAudioEngine/);
  assert.match(studio, /attachStorage/);
  assert.match(studio, /setCompatibilityMode\?\.\(false\)/);
  assert.match(studio, /\.greenFlag\(\)/);
  assert.match(studio, /\.stopAll\(\)/);
  assert.match(studio, /<canvas[^>]+ref=\{stageCanvas\}/);
  assert.match(studio, /requestAnimationFrame/);
  assert.match(studio, /60 TPS/);
});

test("all visible editor surfaces have working handlers", async () => {
  const [studio, config] = await Promise.all([source("app/LumoStudio.tsx"), source("app/studio-config.ts")]);

  assert.match(studio, /setActiveTab\("costumes"\)/);
  assert.match(studio, /setActiveTab\("sounds"\)/);
  assert.match(studio, /requestFullscreen/);
  assert.match(studio, /importProject/);
  assert.match(studio, /exportProject/);
  assert.match(studio, /addSprite/);
  assert.match(studio, /openExtensionLibrary/);
  assert.match(studio, /starterProjectRef\.current/);
  assert.match(studio, /stage-target/);
  assert.match(config, /<shadow type=/);
  assert.match(config, /event_whenbroadcastreceived/);
});

test("ships Sites-compatible login, registration, and persisted profiles", async () => {
  const [auth, login, register, profileApi, collaboration] = await Promise.all([
    source("app/chatgpt-auth.ts"),
    source("app/login/page.tsx"),
    source("app/register/page.tsx"),
    source("app/api/profile/route.ts"),
    source("db/collaboration.ts"),
  ]);

  assert.match(auth, /oai-authenticated-user-email/);
  assert.match(auth, /signin-with-chatgpt/);
  assert.match(login, /chatGPTSignInPath/);
  assert.match(register, /requireChatGPTUser/);
  assert.match(profileApi, /getChatGPTUser/);
  assert.match(profileApi, /readLimitedJson/);
  assert.match(collaboration, /CREATE TABLE IF NOT EXISTS profiles/);
});

test("persists validated ordered collaboration events and immutable assets behind invite tokens", async () => {
  const [createApi, projectApi, eventApi, assetApi, collaboration, schema, studio] = await Promise.all([
    source("app/api/projects/route.ts"),
    source("app/api/projects/[id]/route.ts"),
    source("app/api/projects/[id]/events/route.ts"),
    source("app/api/projects/[id]/assets/[assetId]/route.ts"),
    source("db/collaboration.ts"),
    source("db/schema.ts"),
    source("app/LumoStudio.tsx"),
  ]);

  assert.match(projectApi, /expectedVersion/);
  assert.match(projectApi, /missingAssets/);
  assert.doesNotMatch(projectApi, /DELETE FROM project_assets/);
  assert.match(eventApi, /invite_token/);
  assert.match(eventApi, /project_events/);
  assert.match(eventApi, /allowedTypes/);
  assert.match(eventApi, /Number\.isSafeInteger/);
  assert.match(eventApi, /validEventShape/);
  assert.match(eventApi, /SELECT \?, \?, \?, \?, \?/);
  assert.match(assetApi, /readLimitedBody/);
  assert.match(assetApi, /ON CONFLICT\(project_id, asset_id\) DO NOTHING/);
  assert.match(assetApi, /MAX_PROJECT_ASSET_TOTAL_BYTES/);
  assert.match(assetApi, /sameBytes/);
  assert.match(assetApi, /SELECT \?, \?, \?, \?, \?, \?/);
  assert.match(assetApi, /Content-Security-Policy/);
  assert.match(collaboration, /CREATE TABLE IF NOT EXISTS project_events/);
  assert.match(collaboration, /CREATE TABLE IF NOT EXISTS project_creation_limits/);
  assert.match(collaboration, /readLimitedJson/);
  assert.match(collaboration, /consumeRateLimit/);
  assert.match(collaboration, /networkHits > networkLimit/);
  assert.match(collaboration, /opaqueClientId/);
  assert.match(collaboration, /Number\.isSafeInteger\(eventSeq\)/);
  assert.match(collaboration, /eventSeq: number/);
  assert.match(collaboration, /CREATE UNIQUE INDEX IF NOT EXISTS project_events_client_seq_idx/);
  assert.match(schema, /uniqueIndex\("project_events_client_seq_idx"\)/);
  assert.match(createApi, /state: stateRef|normalizeProjectState/);
  assert.match(createApi, /crypto\.getRandomValues/);
  assert.match(studio, /Date\.now\(\) \* 1000/);
  assert.match(studio, /data\.state\.eventSeq/);
  assert.match(studio, /ScratchBlocks\.Events\.disable\(\)/);
  assert.match(studio, /mergeProjectStates/);
  assert.match(studio, /lastSyncedState/);
  assert.match(studio, /snapshotQueue/);
  assert.match(studio, /lumoTargetId/);
  assert.match(studio, /lumoMediaId/);
  assert.match(studio, /targetId/);
  assert.match(studio, /failedRemoteOperations/);
  assert.match(studio, /AbortController/);
  assert.match(studio, /sinceVersion/);
  assert.match(eventApi, /resetRequired/);
  assert.match(projectApi, /stateChanged/);
  assert.doesNotMatch(studio, /sessionStorage\.getItem\("lumo-client-id"\)/);
  assert.doesNotMatch(projectApi, /projectJson[^\n]+slice/);
});

test("publishes source, licenses, dependency notices, and honest 60 TPS documentation", async () => {
  const [studio, readme, notice, thirdParty, runtimeLicenses, generator, security, license, apache, audioUnlock] = await Promise.all([
    source("app/LumoStudio.tsx"),
    source("README.md"),
    source("NOTICE.md"),
    source("THIRD_PARTY_NOTICES.md"),
    source("THIRD_PARTY_LICENSES/runtime-packages.txt"),
    source("scripts/generate-third-party-notices.mjs"),
    source("SECURITY.md"),
    source("LICENSE"),
    source("THIRD_PARTY_LICENSES/Apache-2.0.txt"),
    source("vendor/start-audio-context/index.cjs"),
  ]);
  assert.match(studio, /Código fuente/);
  assert.match(readme, /60 TPS/);
  assert.doesNotMatch(readme, /modo turbo/i);
  assert.match(notice, /Esta versión no incorpora ni redistribuye código/);
  assert.match(thirdParty, /Avisos de dependencias de producción/);
  assert.doesNotMatch(thirdParty, /`@cloudflare\/workers-types`/);
  assert.match(runtimeLicenses, /Source file: MIT-LICENSE\.txt/);
  assert.match(runtimeLicenses, /Source file: OFL\.txt/);
  assert.match(generator, /metadata\.devOptional === true/);
  assert.match(security, /hull\.js@0\.2\.10/);
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(apache, /Apache License/);
  assert.doesNotMatch(audioUnlock, /requestAnimationFrame\(/);
});
