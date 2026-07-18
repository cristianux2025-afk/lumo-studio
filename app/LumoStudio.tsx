"use client";

import Link from "next/link";
import {ChangeEvent, useCallback, useEffect, useRef, useState} from "react";
import type {ChatGPTUser} from "./chatgpt-auth";
import {connectScratchBlocks} from "./connect-scratch-blocks";
import ImageEditor, {type ImageEditorDocument, type ImageEditorResult} from "./ImageEditor";
import {blankSpriteSvg, buildBlankSprite, buildStarterProject, coreToolbox, makeCoreToolbox, MAX_PROJECT_ASSET_BYTES, MAX_PROJECT_ASSETS, MAX_PROJECT_ASSET_TOTAL_BYTES, MAX_PROJECT_STATE_BYTES, scratchThemeBlockStyles, scratchThemeComponents, stageSvg, starterXml, type ProjectAssetRef, type ProjectState} from "./studio-config";

type Profile = {handle: string; displayName: string; avatarColor: string};
type Props = {user: ChatGPTUser | null; profile: Profile | null; signOutPath: string};
type ActiveTab = "code" | "costumes" | "backdrops" | "sounds";
type Member = {clientId: string; name: string; color: string; cursorX: number; cursorY: number; lastSeen: number};
type Comment = {id: string; author: string; color: string; message: string; createdAt: number};
type TargetSummary = {id: string; name: string; thumbnail: string; x: number; y: number; size: number; direction: number; visible: boolean; rotationStyle: "all around" | "left-right" | "don't rotate"; isStage: boolean};
type AssetSummary = {index: number; name: string; dataUri: string; assetId: string; mediaId: string; selected: boolean};
type RemoteOperation = {seq: number; clientId: string; payload: {targetName?: string; targetId?: string; event?: Record<string, unknown>}};

class AssetSyncError extends Error {
  retryable: boolean;
  retryAfterMs: number;

  constructor(message: string, retryable: boolean, retryAfterMs = 1500) {
    super(message);
    this.name = "AssetSyncError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function responseRetryAfterMs(response: Response, fallback = 1500) {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return fallback;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(raw) - Date.now();
  return Number.isFinite(delay) && delay > 0
    ? Math.min(60_000, Math.max(250, delay))
    : fallback;
}

const colors = ["#6756E8", "#E34884", "#159A80", "#E87817", "#2878D0"];
const guestNames = ["Luna", "Pixel", "Nova", "Milo", "Sol"];
const MAX_STRUCTURAL_VERSION = 1_000_000_000_000;
const collaborativeBlockEventTypes = new Set([
  "create", "change", "move", "delete",
  "var_create", "var_rename", "var_delete",
  "block_comment_create", "block_comment_change", "block_comment_move",
  "block_comment_collapse", "block_comment_resize", "block_comment_delete",
  "comment_create", "comment_change", "comment_move", "comment_collapse",
  "comment_resize", "comment_delete", "block_field_intermediate_change",
]);
// sessionStorage is copied when a browser tab is opened from another tab. A
// module-scoped ID is unique to this page realm, so two tabs never mistake one
// collaborator's operations for their own.
let pageClientId = "";
const emptyState = (createdAt = 0): ProjectState => ({
  // The VM starter already owns the initial blocks. Keeping this empty avoids
  // importing a second Blockly copy whose regenerated IDs would diverge from
  // Scratch VM's block model before the first share.
  blocksXml: "",
  eventSeq: 0,
  structuralVersion: 0,
  assets: [],
  selectedSprite: "Stage",
  stageBackdrop: "Fondo 1",
  activity: [{id: createdAt ? crypto.randomUUID() : "lumo-welcome", text: "Proyecto listo para crear", at: createdAt}],
});

function visibleAccountName(user: ChatGPTUser | null, profile: Profile | null) {
  return profile?.displayName ?? user?.fullName ?? (user ? "Miembro de Lumo" : "");
}

function readIdentity(user: ChatGPTUser | null, profile: Profile | null) {
  const clientId = pageClientId ||= crypto.randomUUID();
  const source = user?.email ?? clientId;
  const seed = [...source].reduce((sum, letter) => sum + letter.charCodeAt(0), 0);
  return {clientId, name: visibleAccountName(user, profile) || `${guestNames[seed % guestNames.length]} ${String(seed).slice(-2)}`, color: profile?.avatarColor ?? colors[seed % colors.length]};
}

function moduleDefault(module: any) {
  return module?.default ?? module;
}

function assetDataUri(asset: any) {
  try {
    return asset?.encodeDataURI?.() ?? "";
  } catch {
    return "";
  }
}

function asciiBytes(data: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function validWavBytes(data: Uint8Array) {
  if (data.byteLength < 44 || asciiBytes(data, 0, 4) !== "RIFF" || asciiBytes(data, 8, 4) !== "WAVE") return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let hasFormat = false;
  let hasSamples = false;
  for (let offset = 12; offset + 8 <= data.byteLength;) {
    const id = asciiBytes(data, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > data.byteLength) return false;
    if (id === "fmt " && size >= 16) {
      const format = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      hasFormat = format > 0 && channels > 0 && channels <= 32 && sampleRate > 0 && sampleRate <= 768_000;
    }
    if (id === "data" && size > 0) hasSamples = true;
    offset = end + (size % 2);
  }
  return hasFormat && hasSamples;
}

function validMp3Bytes(data: Uint8Array) {
  if (data.byteLength < 4) return false;
  let start = 0;
  if (data.byteLength >= 10 && asciiBytes(data, 0, 3) === "ID3") {
    const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
    start = Math.min(data.byteLength, 10 + size);
  }
  for (let index = start; index + 3 < data.byteLength; index += 1) {
    const second = data[index + 1];
    const third = data[index + 2];
    if (data[index] === 0xff && (second & 0xe0) === 0xe0 && (second & 0x18) !== 0x08 &&
        (second & 0x06) !== 0 && (third & 0xf0) !== 0 && (third & 0xf0) !== 0xf0 && (third & 0x0c) !== 0x0c) return true;
  }
  return false;
}

function validAudioBytes(data: Uint8Array, extension: string) {
  return extension === "wav" ? validWavBytes(data) : extension === "mp3" ? validMp3Bytes(data) : false;
}

function collectProjectAssets(vm: any): ProjectAssetRef[] {
  const assets = new Map<string, ProjectAssetRef>();
  const add = (record: any, fallbackType: ProjectAssetRef["assetType"]) => {
    const assetId = String(record?.assetId ?? record?.asset?.assetId ?? "");
    const asset = record?.asset ?? vm.runtime?.storage?.get?.(assetId);
    if (!assetId || !asset?.data || assets.has(assetId)) return;
    const assetType = asset.assetType?.name;
    assets.set(assetId, {
      assetId,
      dataFormat: String(record?.dataFormat ?? asset.dataFormat ?? ""),
      assetType: assetType === "ImageVector" || assetType === "ImageBitmap" || assetType === "Sound" ? assetType : fallbackType,
      byteLength: Number(asset.data.byteLength ?? asset.data.length ?? 0),
    });
  };
  for (const target of vm.runtime?.targets ?? []) {
    if (target.isOriginal === false) continue;
    for (const costume of target.getCostumes?.() ?? []) add(costume, costume.dataFormat === "svg" ? "ImageVector" : "ImageBitmap");
    for (const sound of target.getSounds?.() ?? []) add(sound, "Sound");
  }
  return [...assets.values()];
}

function runtimeAssetById(vm: any, assetId: string) {
  for (const target of vm?.runtime?.targets ?? []) {
    if (target.isOriginal === false) continue;
    for (const record of [...(target.getCostumes?.() ?? []), ...(target.getSounds?.() ?? [])]) {
      const recordAssetId = String(record?.assetId ?? record?.asset?.assetId ?? "");
      if (recordAssetId === assetId && record?.asset?.data) return record.asset;
    }
  }
  return null;
}

function legacyTargetId(target: any, index: number) {
  const costume = target?.costumes?.[0];
  const asset = String(costume?.assetId ?? costume?.md5ext ?? "no-asset");
  return target?.isStage ? "legacy:stage" : `legacy:${index}:${String(target?.name ?? "sprite")}:${asset}`;
}

function projectTargets(projectJson: string) {
  try {
    const parsed = JSON.parse(projectJson || "{}");
    return {parsed, targets: Array.isArray(parsed.targets) ? parsed.targets : [] as any[]};
  } catch {
    return {parsed: null, targets: [] as any[]};
  }
}

function vmProjectJson(vm: any) {
  const raw = vm.toJSON?.() ?? "";
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

function legacyMediaId(targetId: string, collection: "costumes" | "sounds", item: any, index: number) {
  return `legacy-media:${targetId}:${collection}:${index}:${String(item?.assetId ?? item?.md5ext ?? "asset")}`;
}

function runtimeMedia(runtime: any, collection: "costumes" | "sounds") {
  return collection === "costumes" ? runtime.getCostumes?.() ?? [] : runtime.getSounds?.() ?? [];
}

function bindStableMediaIds(serializedTarget: any, runtime: any, targetId: string) {
  for (const collection of ["costumes", "sounds"] as const) {
    const serializedItems = Array.isArray(serializedTarget?.[collection]) ? serializedTarget[collection] : [];
    const runtimeItems = runtimeMedia(runtime, collection);
    runtimeItems.forEach((item: any, index: number) => {
      const serialized = serializedItems[index];
      item.lumoMediaId = typeof serialized?.lumoMediaId === "string" && serialized.lumoMediaId
        ? serialized.lumoMediaId
        : legacyMediaId(targetId, collection, serialized ?? item, index);
    });
  }
}

function serializeStableMediaIds(serializedTarget: any, runtime: any, usedMediaIds: Set<string>) {
  for (const collection of ["costumes", "sounds"] as const) {
    const serializedItems = Array.isArray(serializedTarget?.[collection]) ? serializedTarget[collection] : [];
    const runtimeItems = runtimeMedia(runtime, collection);
    serializedItems.forEach((serialized: any, index: number) => {
      const runtimeItem = runtimeItems[index];
      if (!runtimeItem) return;
      let mediaId = typeof runtimeItem.lumoMediaId === "string" && runtimeItem.lumoMediaId
        ? runtimeItem.lumoMediaId
        : typeof serialized.lumoMediaId === "string" && serialized.lumoMediaId
          ? serialized.lumoMediaId
          : crypto.randomUUID();
      // Scratch duplicates the entire costume/sound record when cloning a
      // sprite, including unknown extension fields. Re-key the second copy so
      // two media instances never collapse during a three-way merge.
      if (usedMediaIds.has(mediaId)) mediaId = crypto.randomUUID();
      usedMediaIds.add(mediaId);
      runtimeItem.lumoMediaId = mediaId;
      serialized.lumoMediaId = mediaId;
    });
  }
}

function bindStableTargetIds(vm: any, projectJson: string, stableIds: Map<string, string>) {
  const {targets: serializedTargets} = projectTargets(projectJson);
  const runtimeTargets = (vm.runtime?.targets ?? []).filter((target: any) => target.isOriginal !== false);
  const usedRuntimeIds = new Set<string>();
  stableIds.clear();
  serializedTargets.forEach((target: any, index: number) => {
    const runtime = runtimeTargets.find((candidate: any) => !usedRuntimeIds.has(candidate.id) &&
      Boolean(candidate.isStage) === Boolean(target.isStage) && candidate.sprite?.name === target.name) ?? runtimeTargets[index];
    if (!runtime) return;
    usedRuntimeIds.add(runtime.id);
    const stableId = typeof target.lumoTargetId === "string" && target.lumoTargetId
      ? target.lumoTargetId
      : legacyTargetId(target, index);
    stableIds.set(runtime.id, stableId);
    bindStableMediaIds(target, runtime, stableId);
  });
  runtimeTargets.forEach((target: any, index: number) => {
    if (stableIds.has(target.id)) return;
    const stableId = legacyTargetId({isStage: target.isStage, name: target.sprite?.name}, index);
    stableIds.set(target.id, stableId);
    bindStableMediaIds({}, target, stableId);
  });
}

type ProjectReferenceKind = "target" | "costume" | "backdrop" | "sound";
type ProjectReference = {kind: ProjectReferenceKind; id: string};

const blockReferenceFields: Record<string, Record<string, ProjectReferenceKind>> = {
  motion_goto_menu: {TO: "target"},
  motion_glideto_menu: {TO: "target"},
  motion_pointtowards_menu: {TOWARDS: "target"},
  sensing_touchingobjectmenu: {TOUCHINGOBJECTMENU: "target"},
  event_touchingobjectmenu: {TOUCHINGOBJECTMENU: "target"},
  sensing_distancetomenu: {DISTANCETOMENU: "target"},
  sensing_of_object_menu: {OBJECT: "target"},
  control_create_clone_of_menu: {CLONE_OPTION: "target"},
  videoSensing_menu_SUBJECT: {SUBJECT: "target"},
  looks_costume: {COSTUME: "costume"},
  looks_backdrops: {BACKDROP: "backdrop"},
  event_whenbackdropswitchesto: {BACKDROP: "backdrop"},
  sound_sounds_menu: {SOUND_MENU: "sound"},
};

const projectReferenceSentinels: Record<ProjectReferenceKind, Set<string>> = {
  target: new Set(["_mouse_", "_edge_", "_random_", "_myself_", "_stage_", "_all_"]),
  costume: new Set(["next costume", "previous costume", "random costume"]),
  backdrop: new Set(["next backdrop", "previous backdrop", "random backdrop"]),
  sound: new Set(),
};

const monitorReferenceParams: Record<string, Record<string, ProjectReferenceKind>> = {
  sensing_of: {OBJECT: "target"},
  sensing_distanceto: {DISTANCETOMENU: "target"},
  sensing_touchingobject: {TOUCHINGOBJECTMENU: "target"},
  videoSensing_videoOn: {SUBJECT: "target"},
};

function fieldText(field: any) {
  if (Array.isArray(field)) return typeof field[0] === "string" ? field[0] : "";
  if (field && typeof field === "object") return typeof field.value === "string" ? field.value : "";
  return typeof field === "string" ? field : "";
}

function setFieldText(block: any, fieldName: string, value: string) {
  const field = block?.fields?.[fieldName];
  if (Array.isArray(field)) field[0] = value;
  else if (field && typeof field === "object") field.value = value;
  else if (typeof field === "string") block.fields[fieldName] = value;
}

function uniqueNameIds(records: any[], idKey: "lumoTargetId" | "lumoMediaId") {
  const ids = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const record of records) {
    const name = String(record?.name ?? "");
    const id = String(record?.[idKey] ?? "");
    if (!name || !id) continue;
    if (ids.has(name) && ids.get(name) !== id) ambiguous.add(name);
    else ids.set(name, id);
  }
  for (const name of ambiguous) ids.delete(name);
  return ids;
}

function annotateProjectReferences(project: any) {
  const targets = Array.isArray(project?.targets) ? project.targets : [];
  // Scratch encodes the stage as sentinels such as `_stage_`; visible target
  // names in menus always mean sprites. Excluding Stage also keeps a legacy
  // sprite named "Stage" unambiguous so it can be renamed safely on merge.
  const targetIdsByName = uniqueNameIds(targets.filter((target: any) => !target?.isStage), "lumoTargetId");
  const stage = targets.find((target: any) => target?.isStage);
  const backdropIdsByName = uniqueNameIds(Array.isArray(stage?.costumes) ? stage.costumes : [], "lumoMediaId");
  for (const target of targets) {
    const costumeIdsByName = uniqueNameIds(Array.isArray(target?.costumes) ? target.costumes : [], "lumoMediaId");
    const soundIdsByName = uniqueNameIds(Array.isArray(target?.sounds) ? target.sounds : [], "lumoMediaId");
    for (const block of Object.values(target?.blocks ?? {}) as any[]) {
      const definitions = blockReferenceFields[String(block?.opcode ?? "")];
      if (!definitions) continue;
      const previous = block.lumoFieldRefs && typeof block.lumoFieldRefs === "object" ? block.lumoFieldRefs : {};
      const references: Record<string, ProjectReference> = {};
      for (const [fieldName, kind] of Object.entries(definitions)) {
        const value = fieldText(block?.fields?.[fieldName]);
        const id = kind === "target"
          ? targetIdsByName.get(value)
          : kind === "costume"
            ? costumeIdsByName.get(value)
            : kind === "backdrop"
              ? backdropIdsByName.get(value)
              : soundIdsByName.get(value);
        const oldReference = previous[fieldName] as ProjectReference | undefined;
        if (id) references[fieldName] = {kind, id};
        else if (!projectReferenceSentinels[kind].has(value) && oldReference?.kind === kind && typeof oldReference.id === "string" && oldReference.id) references[fieldName] = oldReference;
      }
      if (Object.keys(references).length) block.lumoFieldRefs = references;
      else delete block.lumoFieldRefs;
    }
  }
  for (const monitor of Array.isArray(project?.monitors) ? project.monitors : []) {
    const targetId = targetIdsByName.get(String(monitor?.spriteName ?? ""));
    if (targetId) monitor.lumoTargetId = targetId;
    const definitions = monitorReferenceParams[String(monitor?.opcode ?? "")];
    if (definitions) {
      const previous = monitor.lumoParamRefs && typeof monitor.lumoParamRefs === "object" ? monitor.lumoParamRefs : {};
      const references: Record<string, ProjectReference> = {};
      for (const [paramName, kind] of Object.entries(definitions)) {
        const value = String(monitor?.params?.[paramName] ?? "");
        const id = kind === "target" ? targetIdsByName.get(value) : undefined;
        const oldReference = previous[paramName] as ProjectReference | undefined;
        if (id) references[paramName] = {kind, id};
        else if (!projectReferenceSentinels[kind].has(value) && oldReference?.kind === kind && typeof oldReference.id === "string" && oldReference.id) references[paramName] = oldReference;
      }
      if (Object.keys(references).length) monitor.lumoParamRefs = references;
      else delete monitor.lumoParamRefs;
    }
  }
  return project;
}

function duplicateSafeName(requested: string, suffix: number, used: Set<string>, reserved: Set<string>, maximum: number) {
  let number = Math.max(2, suffix);
  while (number < 100_000) {
    const ending = ` ${number++}`;
    const candidate = `${requested.slice(0, Math.max(1, maximum - ending.length))}${ending}`;
    if (!used.has(candidate) && !reserved.has(candidate)) return candidate;
  }
  return `${requested.slice(0, Math.max(1, maximum - 9))} ${crypto.randomUUID().slice(0, 7)}`;
}

function assignUniqueNames(
  records: any[],
  idKey: "lumoTargetId" | "lumoMediaId",
  baseIds: Set<string>,
  fallback: string,
  initiallyReserved: string[] = [],
  baseNames: Map<string, string> = new Map(),
) {
  const groups = new Map<string, any[]>();
  const ids = new Map<any, string>();
  const requestedNames = new Map<any, string>();
  records.forEach((record, index) => {
    const requested = (String(record?.name ?? "").trim() || fallback).slice(0, 40);
    const id = String(record?.[idKey] ?? `missing:${index}:${requested}`);
    ids.set(record, id);
    requestedNames.set(record, requested);
    const group = groups.get(requested) ?? [];
    group.push(record);
    groups.set(requested, group);
  });
  const reserved = new Set([...initiallyReserved, ...groups.keys()]);
  const used = new Set(initiallyReserved);
  const assigned = new Map<string, string>();
  const ordered = (recordsToOrder: any[]) => [...recordsToOrder].sort((left, right) => {
    const leftId = ids.get(left) ?? "";
    const rightId = ids.get(right) ?? "";
    const leftOwnsName = baseNames.get(leftId) === requestedNames.get(left);
    const rightOwnsName = baseNames.get(rightId) === requestedNames.get(right);
    return Number(rightOwnsName) - Number(leftOwnsName) ||
      Number(baseIds.has(rightId)) - Number(baseIds.has(leftId)) ||
      leftId.localeCompare(rightId);
  });
  for (const [requested, group] of groups) {
    const winner = ordered(group)[0];
    const id = ids.get(winner) ?? "";
    if (!used.has(requested)) {
      winner.name = requested;
      used.add(requested);
      assigned.set(id, requested);
    }
  }
  for (const [requested, group] of groups) {
    let suffix = 2;
    for (const record of ordered(group).filter(item => !assigned.has(ids.get(item) ?? ""))) {
      const id = ids.get(record) ?? "";
      const name = duplicateSafeName(requested, suffix, used, reserved, 40);
      suffix = Number(name.match(/ (\d+)$/)?.[1] ?? suffix) + 1;
      record.name = name;
      used.add(name);
      assigned.set(id, name);
    }
  }
  return assigned;
}

function normalizeMergedProjectNames(project: any, baseProject: any) {
  const targets = Array.isArray(project?.targets) ? project.targets : [];
  const baseTargets = Array.isArray(baseProject?.targets) ? baseProject.targets : [];
  const sprites = targets.filter((target: any) => target && !target.isStage);
  const baseTargetIds = new Set<string>(baseTargets.map((target: any) => String(target?.lumoTargetId ?? "")).filter(Boolean));
  const baseTargetNames = new Map<string, string>(baseTargets.map((target: any): [string, string] => [String(target?.lumoTargetId ?? ""), String(target?.name ?? "")]).filter(([id]: [string, string]) => Boolean(id)));
  const stageNames = targets.filter((target: any) => target?.isStage).map((target: any) => String(target.name || "Stage"));
  const targetNames = assignUniqueNames(sprites, "lumoTargetId", baseTargetIds, "Objeto", stageNames, baseTargetNames);
  for (const target of targets) {
    const targetId = String(target?.lumoTargetId ?? "");
    if (target?.isStage && targetId) targetNames.set(targetId, String(target.name || "Stage"));
  }

  const costumeNames = new Map<string, Map<string, string>>();
  const soundNames = new Map<string, Map<string, string>>();
  for (const target of targets) {
    const targetId = String(target?.lumoTargetId ?? "");
    const baseTarget = baseTargets.find((candidate: any) => String(candidate?.lumoTargetId ?? "") === targetId);
    const baseCostumeIds = new Set<string>((Array.isArray(baseTarget?.costumes) ? baseTarget.costumes : []).map((item: any) => String(item?.lumoMediaId ?? "")).filter(Boolean));
    const baseSoundIds = new Set<string>((Array.isArray(baseTarget?.sounds) ? baseTarget.sounds : []).map((item: any) => String(item?.lumoMediaId ?? "")).filter(Boolean));
    const baseCostumeNames = new Map<string, string>((Array.isArray(baseTarget?.costumes) ? baseTarget.costumes : []).map((item: any): [string, string] => [String(item?.lumoMediaId ?? ""), String(item?.name ?? "")]).filter(([id]: [string, string]) => Boolean(id)));
    const baseSoundNames = new Map<string, string>((Array.isArray(baseTarget?.sounds) ? baseTarget.sounds : []).map((item: any): [string, string] => [String(item?.lumoMediaId ?? ""), String(item?.name ?? "")]).filter(([id]: [string, string]) => Boolean(id)));
    costumeNames.set(targetId, assignUniqueNames(Array.isArray(target?.costumes) ? target.costumes : [], "lumoMediaId", baseCostumeIds, target?.isStage ? "Fondo" : "Disfraz", [], baseCostumeNames));
    soundNames.set(targetId, assignUniqueNames(Array.isArray(target?.sounds) ? target.sounds : [], "lumoMediaId", baseSoundIds, "Sonido", [], baseSoundNames));
  }
  const stage = targets.find((target: any) => target?.isStage);
  const stageId = String(stage?.lumoTargetId ?? "");
  const backdropNames = costumeNames.get(stageId) ?? new Map<string, string>();

  for (const target of targets) {
    const targetId = String(target?.lumoTargetId ?? "");
    for (const block of Object.values(target?.blocks ?? {}) as any[]) {
      const references = block?.lumoFieldRefs && typeof block.lumoFieldRefs === "object" ? block.lumoFieldRefs : {};
      for (const [fieldName, rawReference] of Object.entries(references)) {
        const reference = rawReference as ProjectReference;
        const resolved = reference.kind === "target"
          ? targetNames.get(reference.id)
          : reference.kind === "costume"
            ? costumeNames.get(targetId)?.get(reference.id)
            : reference.kind === "backdrop"
              ? backdropNames.get(reference.id)
              : reference.kind === "sound"
                ? soundNames.get(targetId)?.get(reference.id)
                : undefined;
        if (resolved) setFieldText(block, fieldName, resolved);
      }
    }
  }
  for (const monitor of Array.isArray(project?.monitors) ? project.monitors : []) {
    const ownerName = targetNames.get(String(monitor?.lumoTargetId ?? ""));
    if (ownerName) monitor.spriteName = ownerName;
    for (const [paramName, rawReference] of Object.entries(monitor?.lumoParamRefs ?? {})) {
      const reference = rawReference as ProjectReference;
      const resolved = reference.kind === "target" ? targetNames.get(reference.id) : undefined;
      if (resolved && monitor.params) monitor.params[paramName] = resolved;
    }
  }
  return project;
}

function serializeProjectWithTargetIds(vm: any, stableIds: Map<string, string>) {
  const json = vmProjectJson(vm);
  const {parsed, targets} = projectTargets(json);
  if (!parsed) return json;
  const runtimeTargets = (vm.runtime?.targets ?? []).filter((target: any) => target.isOriginal !== false);
  const usedRuntimeIds = new Set<string>();
  const usedMediaIds = new Set<string>();
  targets.forEach((target: any, index: number) => {
    const runtime = runtimeTargets.find((candidate: any) => !usedRuntimeIds.has(candidate.id) &&
      Boolean(candidate.isStage) === Boolean(target.isStage) && candidate.sprite?.name === target.name) ?? runtimeTargets[index];
    if (!runtime) return;
    usedRuntimeIds.add(runtime.id);
    let stableId = stableIds.get(runtime.id);
    if (!stableId) {
      stableId = crypto.randomUUID();
      stableIds.set(runtime.id, stableId);
    }
    target.lumoTargetId = stableId;
    serializeStableMediaIds(target, runtime, usedMediaIds);
  });
  annotateProjectReferences(parsed);
  return JSON.stringify(parsed);
}

const missingJsonValue = Symbol("missing-json-value");

function sameJsonValue(left: any, right: any) {
  if (left === missingJsonValue || right === missingJsonValue) return left === right;
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function arrayItemKey(item: any, collection: string) {
  if (!item || typeof item !== "object") return "";
  if (collection === "targets") return item.isStage ? "stage" : `sprite:${item.lumoTargetId ?? item.name ?? ""}`;
  if (collection === "costumes" || collection === "sounds") {
    return String(item.lumoMediaId ?? `${item.assetId ?? item.md5ext ?? "asset"}:${item.name ?? "media"}`);
  }
  if (collection === "monitors") return String(item.id ?? `${item.opcode ?? ""}:${JSON.stringify(item.params ?? {})}`);
  return "";
}

function mergeJsonValue(base: any, local: any, remote: any, collection = ""): any {
  if (sameJsonValue(local, base)) return remote;
  if (sameJsonValue(remote, base) || sameJsonValue(local, remote)) return local;
  if (local === missingJsonValue) return missingJsonValue;
  if (remote === missingJsonValue) return local;
  if (Array.isArray(local) && Array.isArray(remote)) {
    if (collection === "extensions") return [...new Set([...remote, ...local])];
    const baseArray = Array.isArray(base) ? base : [];
    const allItems = [...baseArray, ...remote, ...local];
    const keyed = allItems.length > 0 && allItems.every(item => Boolean(arrayItemKey(item, collection)));
    if (!keyed) return local;
    const toMap = (items: any[]) => new Map(items.map(item => [arrayItemKey(item, collection), item]));
    const baseMap = toMap(baseArray);
    const localMap = toMap(local);
    const remoteMap = toMap(remote);
    const order = [...new Set([...remoteMap.keys(), ...localMap.keys(), ...baseMap.keys()])];
    return order.flatMap(key => {
      const merged = mergeJsonValue(
        baseMap.has(key) ? baseMap.get(key) : missingJsonValue,
        localMap.has(key) ? localMap.get(key) : missingJsonValue,
        remoteMap.has(key) ? remoteMap.get(key) : missingJsonValue,
        collection === "targets" ? "target" : collection.slice(0, -1),
      );
      return merged === missingJsonValue ? [] : [merged];
    });
  }
  const localObject = local && typeof local === "object" && !Array.isArray(local);
  const remoteObject = remote && typeof remote === "object" && !Array.isArray(remote);
  if (localObject && remoteObject) {
    const baseObject = base && typeof base === "object" && !Array.isArray(base) ? base : {};
    const result: Record<string, any> = {};
    for (const key of new Set([...Object.keys(baseObject), ...Object.keys(remote), ...Object.keys(local)])) {
      const merged = mergeJsonValue(
        Object.hasOwn(baseObject, key) ? baseObject[key] : missingJsonValue,
        Object.hasOwn(local, key) ? local[key] : missingJsonValue,
        Object.hasOwn(remote, key) ? remote[key] : missingJsonValue,
        key,
      );
      if (merged !== missingJsonValue) result[key] = merged;
    }
    return result;
  }
  // Both sides changed the same scalar. The local action is the later writer
  // from this client's perspective.
  return local;
}

function mergeProjectJson(base = "", local = "", remote = "") {
  if (!base && !local && !remote) return "";
  try {
    const baseJson = base ? JSON.parse(base) : {};
    const localJson = local ? JSON.parse(local) : {};
    const remoteJson = remote ? JSON.parse(remote) : {};
    annotateProjectReferences(baseJson);
    annotateProjectReferences(localJson);
    annotateProjectReferences(remoteJson);
    const merged = mergeJsonValue(baseJson, localJson, remoteJson);
    return JSON.stringify(normalizeMergedProjectNames(merged, baseJson));
  } catch {
    return local || remote;
  }
}

function projectJsonAssets(projectJson = ""): ProjectAssetRef[] | null {
  try {
    const parsed = projectJson ? JSON.parse(projectJson) : {};
    const assets = new Map<string, ProjectAssetRef>();
    const add = (record: any, assetType: ProjectAssetRef["assetType"]) => {
      const md5ext = String(record?.md5ext ?? "");
      const assetId = String(record?.assetId ?? md5ext.split(".")[0] ?? "");
      const dataFormat = String(record?.dataFormat ?? md5ext.split(".").at(-1) ?? "").toLowerCase();
      if (!/^[a-zA-Z0-9_-]{16,128}$/.test(assetId)) return;
      if (!/^(svg|png|jpg|jpeg|wav|mp3)$/.test(dataFormat)) return;
      assets.set(assetId, {assetId, dataFormat, assetType, byteLength: 0});
    };
    for (const target of Array.isArray(parsed?.targets) ? parsed.targets : []) {
      for (const costume of Array.isArray(target?.costumes) ? target.costumes : []) {
        const format = String(costume?.dataFormat ?? String(costume?.md5ext ?? "").split(".").at(-1) ?? "").toLowerCase();
        add(costume, format === "svg" ? "ImageVector" : "ImageBitmap");
      }
      for (const sound of Array.isArray(target?.sounds) ? target.sounds : []) add(sound, "Sound");
    }
    return [...assets.values()];
  } catch {
    return null;
  }
}

function mergeProjectStates(base: ProjectState, local: ProjectState, remote: ProjectState): ProjectState {
  const choose = <T,>(baseValue: T, localValue: T, remoteValue: T) => sameJsonValue(localValue, baseValue) ? remoteValue : localValue;
  const projectJson = mergeProjectJson(base.projectJson, local.projectJson, remote.projectJson);
  const assetCandidates = new Map<string, ProjectAssetRef>();
  for (const asset of [...(remote.assets ?? []), ...(local.assets ?? [])]) assetCandidates.set(asset.assetId, asset);
  const referencedAssets = projectJsonAssets(projectJson);
  const assets = referencedAssets === null
    ? [...assetCandidates.values()]
    : referencedAssets.map(asset => assetCandidates.get(asset.assetId) ?? asset);
  const activity = new Map<string, ProjectState["activity"][number]>();
  for (const item of [...(remote.activity ?? []), ...(local.activity ?? [])]) activity.set(item.id, item);
  return {
    blocksXml: choose(base.blocksXml, local.blocksXml, remote.blocksXml),
    projectJson,
    eventSeq: Math.min(Math.max(0, local.eventSeq ?? 0), Math.max(0, remote.eventSeq ?? 0)),
    structuralVersion: Math.min(MAX_STRUCTURAL_VERSION, Math.max(local.structuralVersion ?? 0, remote.structuralVersion ?? 0) + 1),
    assets,
    selectedSprite: choose(base.selectedSprite, local.selectedSprite, remote.selectedSprite),
    stageBackdrop: choose(base.stageBackdrop, local.stageBackdrop, remote.stageBackdrop),
    activity: [...activity.values()].sort((a, b) => a.at - b.at).slice(-20),
  };
}

export default function LumoStudio({user, profile, signOutPath}: Props) {
  const blocklyHost = useRef<HTMLDivElement>(null);
  const blocklyWrap = useRef<HTMLDivElement>(null);
  const stageCanvas = useRef<HTMLCanvasElement>(null);
  const stageContainer = useRef<HTMLDivElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const costumeInput = useRef<HTMLInputElement>(null);
  const backdropInput = useRef<HTMLInputElement>(null);
  const spriteInput = useRef<HTMLInputElement>(null);
  const soundInput = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<any>(null);
  const scratchRef = useRef<any>(null);
  const vmRef = useRef<any>(null);
  const rendererRef = useRef<any>(null);
  const storageRef = useRef<any>(null);
  const targetStableIds = useRef(new Map<string, string>());
  const remoteDepth = useRef(0);
  const disposedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursor = useRef({x: 50, y: 50});
  const eventCursor = useRef(0);
  const clientSequence = useRef(0);
  const operationQueue = useRef<Promise<void>>(Promise.resolve());
  const snapshotQueue = useRef<Promise<void>>(Promise.resolve());
  const projectLoadQueue = useRef<Promise<void>>(Promise.resolve());
  const projectCreation = useRef<Promise<{id: string; inviteToken: string; version: number}> | null>(null);
  const projectEpoch = useRef(0);
  const localRevision = useRef(0);
  const uploadedAssets = useRef(new Set<string>());
  const localDirty = useRef(false);
  const restoringProject = useRef(false);
  const replayOwnOperations = useRef(false);
  const pendingRemoteOperations = useRef(new Map<number, RemoteOperation>());
  const failedRemoteOperations = useRef(new Map<number, number>());
  const drainRemoteOperationsRef = useRef<() => void>(() => {});
  const fpsFrames = useRef(0);
  const connection = useRef({projectId: "", token: "", version: 0, name: "Mi proyecto Lumo"});
  const stateRef = useRef<ProjectState>(emptyState());
  const lastSyncedState = useRef<ProjectState>(emptyState());
  const restoreProjectRef = useRef<(state: ProjectState, expectedEpoch?: number, preserveSelection?: boolean) => Promise<boolean>>(async () => false);
  const starterProjectRef = useRef<ReturnType<typeof buildStarterProject> | null>(null);
  const refreshRuntimeRef = useRef<() => void>(() => {});
  const [identity, setIdentity] = useState(() => ({
    clientId: "pending",
    name: visibleAccountName(user, profile) || "Creador",
    color: profile?.avatarColor ?? colors[0],
  }));

  const [projectId, setProjectId] = useState("");
  const [token, setToken] = useState("");
  const [projectName, setProjectName] = useState("Mi proyecto Lumo");
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<ProjectState>(() => emptyState());
  const [members, setMembers] = useState<Member[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [targets, setTargets] = useState<TargetSummary[]>([]);
  const [costumes, setCostumes] = useState<AssetSummary[]>([]);
  const [backdrops, setBackdrops] = useState<AssetSummary[]>([]);
  const [sounds, setSounds] = useState<AssetSummary[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>("code");
  const [running, setRunning] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const [fps, setFps] = useState(0);
  const [syncStatus, setSyncStatus] = useState("Preparando motor…");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [installedExtensions, setInstalledExtensions] = useState<string[]>([]);
  const [activityOpen, setActivityOpen] = useState(true);
  const [commentText, setCommentText] = useState("");
  const [toast, setToast] = useState("");
  const [loadError, setLoadError] = useState("");
  const [imageEditor, setImageEditor] = useState<ImageEditorDocument | null>(null);

  useEffect(() => {
    setIdentity(readIdentity(user, profile));
  }, [profile, user]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    connection.current = {projectId, token, version, name: projectName};
  }, [projectId, projectName, token, version]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const uploadAssets = useCallback(async (id: string, inviteToken: string, assets: ProjectAssetRef[], force = false) => {
    const storage = storageRef.current;
    if (!storage || !assets.length) return;
    for (const reference of assets) {
      const cacheKey = `${id}:${reference.assetId}`;
      if (!force && uploadedAssets.current.has(cacheKey)) continue;
      const asset = storage.get?.(reference.assetId) ?? runtimeAssetById(vmRef.current, reference.assetId);
      if (!asset?.data) throw new Error(`Asset local ausente: ${reference.assetId}`);
      const query = new URLSearchParams({token: inviteToken, format: reference.dataFormat, type: reference.assetType});
      const response = await fetch(`/api/projects/${id}/assets/${encodeURIComponent(reference.assetId)}?${query}`, {
        method: "PUT",
        headers: {"Content-Type": "application/octet-stream"},
        body: asset.data,
      }).catch(() => null);
      if (!response) throw new AssetSyncError("Sin conexión para sincronizar los recursos", true);
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as {error?: string};
        const retryable = response.status === 429 || response.status >= 500;
        const retryAfterMs = responseRetryAfterMs(response);
        throw new AssetSyncError(result.error ?? `No se pudo sincronizar ${reference.assetId}`, retryable, retryAfterMs);
      }
      uploadedAssets.current.add(cacheKey);
    }
  }, []);

  const persistSnapshot = useCallback((next: ProjectState, immediate = false): Promise<boolean> => {
    const editBase = lastSyncedState.current;
    stateRef.current = next;
    setState(next);
    localDirty.current = Boolean(connection.current.projectId && connection.current.token);
    const revision = ++localRevision.current;
    const epoch = projectEpoch.current;
    const schedule = (): Promise<boolean> => {
      saveTimer.current = null;
      const save = async (): Promise<{ok: boolean; retryable: boolean; retryAfterMs?: number; savedState?: ProjectState; rebased?: boolean}> => {
        const original = connection.current;
        if (epoch !== projectEpoch.current) return {ok: false, retryable: false};
        if (!original.projectId || !original.token) return {ok: true, retryable: false};
        let baseState = lastSyncedState.current;
        let desiredState = sameJsonValue(editBase, baseState) ? next : mergeProjectStates(editBase, next, baseState);
        let rebased = !sameJsonValue(desiredState, next);
        const stateError = () => {
          if (desiredState.assets.length > MAX_PROJECT_ASSETS) return "El proyecto supera 100 recursos activos";
          if (desiredState.assets.reduce((total, asset) => total + asset.byteLength, 0) > MAX_PROJECT_ASSET_TOTAL_BYTES) {
            return "El proyecto supera 50 MB de recursos activos";
          }
          if (new TextEncoder().encode(JSON.stringify(desiredState)).byteLength > MAX_PROJECT_STATE_BYTES) {
            return "Proyecto demasiado grande para sincronizar";
          }
          return "";
        };
        const initialStateError = stateError();
        if (initialStateError) {
          setSyncStatus(initialStateError);
          showToast(initialStateError);
          return {ok: false, retryable: false};
        }
        localDirty.current = true;
        setSyncStatus("Guardando…");
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const current = connection.current;
          if (epoch !== projectEpoch.current || current.projectId !== original.projectId || current.token !== original.token) {
            return {ok: false, retryable: false};
          }
          try {
            const baseAssetIds = new Set((baseState.assets ?? []).map(asset => asset.assetId));
            // PUT is idempotent. Force it before every CAS attempt so a
            // concurrent snapshot/cleanup can never leave the retried state
            // pointing at bytes which disappeared between attempts.
            await uploadAssets(
              current.projectId,
              current.token,
              desiredState.assets.filter(asset => !baseAssetIds.has(asset.assetId)),
            );
          } catch (error) {
            const failure = error instanceof AssetSyncError
              ? error
              : new AssetSyncError("Assets pendientes", true);
            if (epoch === projectEpoch.current) {
              setSyncStatus(failure.message);
              if (!failure.retryable) showToast(failure.message);
            }
            return {ok: false, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs};
          }
          const response = await fetch(`/api/projects/${current.projectId}`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
              token: current.token,
              clientId: identity.clientId,
              name: current.name,
              state: desiredState,
              expectedVersion: current.version,
            }),
          }).catch(() => null);
          if (epoch !== projectEpoch.current) return {ok: false, retryable: false};
          if (!response) {
            if (attempt < 3) await new Promise(resolve => window.setTimeout(resolve, 250 * (attempt + 1)));
            continue;
          }
          const result = await response.json().catch(() => ({})) as {version?: number; error?: string; state?: ProjectState; missingAssets?: string[]};
          if (response.ok && result.version) {
            connection.current.version = result.version;
            setVersion(result.version);
            lastSyncedState.current = desiredState;
            return {ok: true, retryable: false, savedState: desiredState, rebased};
          }
          if (response.status === 409 && result.version && result.state) {
            const remoteState: ProjectState = {
              ...result.state,
              structuralVersion: Math.max(0, result.state.structuralVersion ?? 0),
              assets: Array.isArray(result.state.assets) ? result.state.assets : [],
              activity: Array.isArray(result.state.activity) ? result.state.activity : [],
            };
            desiredState = mergeProjectStates(baseState, desiredState, remoteState);
            baseState = remoteState;
            rebased = true;
            connection.current.version = result.version;
            lastSyncedState.current = remoteState;
            setVersion(result.version);
            setSyncStatus("Integrando cambios concurrentes…");
            const mergeError = stateError();
            if (mergeError) {
              setSyncStatus(mergeError);
              showToast(mergeError);
              return {ok: false, retryable: false};
            }
            continue;
          }
          if (response.status === 424 && Array.isArray(result.missingAssets)) {
            const missing = new Set(result.missingAssets);
            try {
              await uploadAssets(
                current.projectId,
                current.token,
                desiredState.assets.filter(asset => missing.has(asset.assetId)),
                true,
              );
            } catch (error) {
              const failure = error instanceof AssetSyncError
                ? error
                : new AssetSyncError("No se pudieron reparar los recursos pendientes", true);
              setSyncStatus(failure.message);
              if (!failure.retryable) showToast(failure.message);
              return {ok: false, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs};
            }
            setSyncStatus("Reparando recursos del proyecto…");
            continue;
          }
          if (response.status === 429) {
            const retryAfterMs = responseRetryAfterMs(response);
            setSyncStatus(result.error ?? "Guardado en espera por límite temporal");
            return {ok: false, retryable: true, retryAfterMs};
          }
          if (response.status === 409) {
            setSyncStatus("No se pudo integrar la versión remota");
            return {ok: false, retryable: true};
          }
          if (response.status === 400 || response.status === 413) {
            setSyncStatus(result.error ?? "Proyecto demasiado grande");
            return {ok: false, retryable: false};
          }
          if (response.status === 403 || response.status === 404) {
            setSyncStatus("Invitación inválida");
            return {ok: false, retryable: false};
          }
          if (response.status >= 500 && response.headers.has("Retry-After")) {
            return {ok: false, retryable: true, retryAfterMs: responseRetryAfterMs(response)};
          }
          if (attempt < 3) await new Promise(resolve => window.setTimeout(resolve, 250 * (attempt + 1)));
        }
        setSyncStatus("Sin conexión");
        return {ok: false, retryable: true};
      };
      const job = snapshotQueue.current.catch(() => {}).then(save).then(async result => {
        if (epoch !== projectEpoch.current) return result;
        if (result.ok) {
          if (revision === localRevision.current) {
            if (result.savedState && result.rebased && !sameJsonValue(stateRef.current, result.savedState)) {
              localDirty.current = true;
              stateRef.current = result.savedState;
              setState(result.savedState);
              eventCursor.current = Math.max(0, result.savedState.eventSeq ?? 0);
              pendingRemoteOperations.current.clear();
              failedRemoteOperations.current.clear();
              replayOwnOperations.current = true;
              await restoreProjectRef.current(result.savedState, epoch, true);
              if (epoch === projectEpoch.current) drainRemoteOperationsRef.current();
              // If a user managed to edit while the asynchronous VM restore was
              // running, put that newer local snapshot back into the runtime.
              if (revision !== localRevision.current && epoch === projectEpoch.current) {
                await restoreProjectRef.current(stateRef.current, epoch, true);
              }
            }
            if (revision === localRevision.current) {
              localDirty.current = false;
              setSyncStatus("Sincronizado");
            }
          }
          return result;
        }
        if (result.retryable && revision === localRevision.current && !saveTimer.current) {
          localDirty.current = true;
          saveTimer.current = setTimeout(() => void schedule(), result.retryAfterMs ?? 1500);
        }
        return result;
      });
      snapshotQueue.current = job.then(() => undefined, () => undefined);
      return job.then(result => result.ok);
    };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (immediate) return schedule();
    saveTimer.current = setTimeout(() => void schedule(), 680);
    return Promise.resolve(true);
  }, [identity.clientId, showToast, uploadAssets]);

  const snapshotRuntime = useCallback((message?: string, immediate = false, structural = false) => {
    const vm = vmRef.current;
    const ScratchBlocks = scratchRef.current;
    const workspace = workspaceRef.current;
    if (!vm || !workspace || !ScratchBlocks) return Promise.resolve(false);
    const blocksXml = ScratchBlocks.Xml.domToText(ScratchBlocks.Xml.workspaceToDom(workspace));
    const next: ProjectState = {
      ...stateRef.current,
      blocksXml,
      projectJson: serializeProjectWithTargetIds(vm, targetStableIds.current),
      eventSeq: eventCursor.current,
      structuralVersion: structural ? Math.min(MAX_STRUCTURAL_VERSION, stateRef.current.structuralVersion + 1) : stateRef.current.structuralVersion,
      assets: collectProjectAssets(vm),
      selectedSprite: vm.editingTarget?.sprite?.name ?? stateRef.current.selectedSprite,
      stageBackdrop: vm.runtime?.getTargetForStage?.()?.getCostumes?.()?.[vm.runtime.getTargetForStage().currentCostume]?.name ?? stateRef.current.stageBackdrop,
      activity: message ? [...stateRef.current.activity, {id: crypto.randomUUID(), text: message, at: Date.now()}].slice(-30) : stateRef.current.activity,
    };
    if (next.assets.length > MAX_PROJECT_ASSETS || next.assets.reduce((total, asset) => total + asset.byteLength, 0) > MAX_PROJECT_ASSET_TOTAL_BYTES) {
      setSyncStatus("El proyecto supera la cuota de recursos");
      showToast("Máximo: 100 recursos y 50 MB por proyecto compartido");
      return Promise.resolve(false);
    }
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_PROJECT_STATE_BYTES) {
      setSyncStatus("Proyecto demasiado grande para sincronizar");
      showToast("El proyecto supera 1,75 MB sin contar sus recursos");
      return Promise.resolve(false);
    }
    return persistSnapshot(next, immediate);
  }, [persistSnapshot, showToast]);

  const sendBlockOperation = useCallback(async (eventJson: Record<string, unknown>, targetName: string, targetId: string) => {
    const current = connection.current;
    if (!current.projectId || !current.token) return 0;
    const epoch = projectEpoch.current;
    const clientSeq = clientSequence.current = Math.max(clientSequence.current + 1, Date.now() * 1000);
    let resolveResult: (value: number) => void = () => {};
    const result = new Promise<number>(resolve => { resolveResult = resolve; });
    operationQueue.current = operationQueue.current.catch(() => {}).then(async () => {
      let seq = 0;
      try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (epoch !== projectEpoch.current || connection.current.projectId !== current.projectId) break;
          const response = await fetch(`/api/projects/${current.projectId}/events`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({token: current.token, clientId: identity.clientId, clientSeq, event: {targetName, targetId, event: eventJson}}),
          }).catch(() => null);
          if (response?.ok) {
            const body = await response.json() as {seq: number};
            seq = body.seq || 0;
            break;
          }
          if (response && [400, 403, 404].includes(response.status)) break;
          if (response?.status === 429) {
            const retryAfter = response.headers.get("Retry-After");
            // A full event log returns 429 without a delay and should fall
            // back to a structural checkpoint immediately. Rate limiting
            // provides Retry-After; wait once while preserving queue order.
            if (!retryAfter || attempt >= 3) break;
            await new Promise(resolve => window.setTimeout(resolve, responseRetryAfterMs(response)));
            continue;
          }
          if (response && response.status >= 500 && response.headers.has("Retry-After") && attempt < 3) {
            await new Promise(resolve => window.setTimeout(resolve, responseRetryAfterMs(response)));
            continue;
          }
          if (attempt < 3) await new Promise(resolve => window.setTimeout(resolve, 200 * (attempt + 1)));
        }
      } finally {
        resolveResult(seq);
      }
    });
    return result;
  }, [identity.clientId]);

  useEffect(() => {
    if (identity.clientId === "pending") return;
    disposedRef.current = false;
    let animationFrame = 0;
    let runtimeRefreshTimer = 0;
    const boot = async () => {
      try {
        const [blocksModule, vmModule, renderModule, audioModule, storageModule, svgModule] = await Promise.all([
          import("scratch-blocks"),
          import("@scratch/scratch-vm"),
          import("@scratch/scratch-render"),
          import("scratch-audio"),
          import("scratch-storage"),
          import("@scratch/scratch-svg-renderer"),
        ]);
        if (disposedRef.current || !blocklyHost.current || !stageCanvas.current) return;
        const ScratchBlocks = moduleDefault(blocksModule);
        const VirtualMachine = moduleDefault(vmModule);
        const RenderWebGL = moduleDefault(renderModule);
        const AudioEngine = moduleDefault(audioModule);
        const ScratchStorage = (storageModule as any).ScratchStorage ?? (storageModule as any).default?.ScratchStorage ?? moduleDefault(storageModule);
        const svgRenderer = moduleDefault(svgModule);
        const BitmapAdapter = svgRenderer.BitmapAdapter ?? (svgModule as any).BitmapAdapter;
        ScratchBlocks.ScratchMsgs.setLocale("es");

        const vm = new VirtualMachine();
        connectScratchBlocks(ScratchBlocks, vm);
        const storage = new ScratchStorage();
        const renderer = new RenderWebGL(stageCanvas.current);
        const audioEngine = new AudioEngine();
        renderer.resize?.(480, 360);
        vm.attachStorage(storage);
        vm.attachRenderer(renderer);
        vm.attachAudioEngine(audioEngine);
        vm.attachV2BitmapAdapter(new BitmapAdapter());
        vm.setCompatibilityMode?.(false);
        vm.setTurboMode?.(false);

        scratchRef.current = ScratchBlocks;
        vmRef.current = vm;
        rendererRef.current = renderer;
        storageRef.current = storage;

        const workspace = ScratchBlocks.inject(blocklyHost.current, {
          toolbox: coreToolbox,
          theme: new ScratchBlocks.Theme("lumo", scratchThemeBlockStyles, {}, scratchThemeComponents),
          scratchTheme: "classic",
          media: "https://cdn.jsdelivr.net/npm/scratch-blocks@2.1.19/media/",
          trashcan: true,
          comments: true,
          // Workspace click sounds are optional and trigger autoplay/decode
          // failures in locked-down browsers. Project audio remains attached
          // to Scratch VM through AudioEngine.
          sounds: false,
          zoom: {controls: true, wheel: true, startScale: 0.82, maxScale: 1.4, minScale: 0.35},
          grid: {spacing: 28, length: 2, colour: "#d7ddeb", snap: false},
        });
        workspaceRef.current = workspace;
        if (import.meta.env.DEV) (window as any).__LUMO_TEST__ = {
          workspace,
          vm,
          ScratchBlocks,
          clientId: identity.clientId,
          mergeProjectStates,
          annotateProjectReferences,
          targetStableIds: targetStableIds.current,
        };
        workspace.registerToolboxCategoryCallback("VARIABLE", ScratchBlocks.ScratchVariables.getVariablesCategory);
        workspace.registerToolboxCategoryCallback("PROCEDURE", ScratchBlocks.ScratchProcedures.getProceduresCategory);
        const flyoutWorkspace = workspace.getFlyout().getWorkspace();
        flyoutWorkspace.registerButtonCallback("MAKE_A_VARIABLE", () => ScratchBlocks.ScratchVariables.createVariable(workspace, null, ""));
        flyoutWorkspace.registerButtonCallback("MAKE_A_LIST", () => ScratchBlocks.ScratchVariables.createVariable(workspace, null, "list"));
        flyoutWorkspace.registerButtonCallback("MAKE_A_PROCEDURE", () => ScratchBlocks.ScratchProcedures.createProcedureDefCallback(workspace));
        workspace.addChangeListener(vm.blockListener);
        flyoutWorkspace.addChangeListener(vm.flyoutBlockListener);
        flyoutWorkspace.addChangeListener(vm.monitorBlockListener);

        // scratch-blocks 2.x exposes the XML parser through Blockly.utils;
        // older Scratch GUI builds exposed the same helper on Blockly.Xml.
        const textToDom = (xml: string) =>
          (ScratchBlocks.utils?.xml?.textToDom ?? ScratchBlocks.Xml.textToDom)(xml);

        const renderWorkspace = (xml: string) => {
          if (!xml || disposedRef.current) return;
          remoteDepth.current += 1;
          ScratchBlocks.Events.disable();
          try {
            workspace.clear();
            ScratchBlocks.Xml.domToWorkspace(textToDom(xml), workspace);
            workspace.clearUndo?.();
          } finally {
            ScratchBlocks.Events.enable();
            remoteDepth.current = Math.max(0, remoteDepth.current - 1);
          }
        };

        let targetSignature = "";
        let costumeSignature = "";
        let backdropSignature = "";
        let soundSignature = "";
        let toolboxSignature = "";
        const assetUriCache = new Map<string, string>();
        const cachedAssetDataUri = (asset: any, activeKeys: Set<string>) => {
          const key = String(asset?.assetId ?? "");
          if (!key) return assetDataUri(asset);
          activeKeys.add(key);
          const cached = assetUriCache.get(key);
          if (cached !== undefined) return cached;
          const uri = assetDataUri(asset);
          assetUriCache.set(key, uri);
          return uri;
        };
        const refreshRuntime = () => {
          const activeAssetUriKeys = new Set<string>();
          const editing = vm.editingTarget;
          const runtimeTargets = (vm.runtime?.targets ?? []).filter((target: any) => target.isOriginal !== false);
          const targetKeys: unknown[] = [];
          const nextTargets = runtimeTargets.map((target: any) => {
            const asset = target.getCostumes?.()?.[target.currentCostume]?.asset;
            const summary = {
              id: target.id,
              name: target.sprite?.name ?? "Objeto",
              thumbnail: cachedAssetDataUri(asset, activeAssetUriKeys),
              x: Math.round(target.x ?? 0),
              y: Math.round(target.y ?? 0),
              size: Math.round(target.size ?? 100),
              direction: Math.round(target.direction ?? 90),
              visible: target.visible !== false,
              rotationStyle: target.rotationStyle ?? "all around",
              isStage: Boolean(target.isStage),
            };
            targetKeys.push([summary.id, summary.name, summary.x, summary.y, summary.size, summary.direction, summary.visible, summary.rotationStyle, summary.isStage, asset?.assetId ?? ""]);
            return summary;
          });
          const nextTargetSignature = JSON.stringify(targetKeys);
          if (nextTargetSignature !== targetSignature) {
            targetSignature = nextTargetSignature;
            setTargets(nextTargets);
          }
          if (editing) {
            const editingCostumes = editing.getCostumes?.() ?? [];
            const nextCostumes = editingCostumes.map((costume: any, index: number) => {
              costume.lumoMediaId ||= crypto.randomUUID();
              return {index, name: costume.name, dataUri: cachedAssetDataUri(costume.asset, activeAssetUriKeys), assetId: String(costume.assetId ?? costume.asset?.assetId ?? ""), mediaId: costume.lumoMediaId, selected: index === editing.currentCostume};
            });
            const nextCostumeSignature = JSON.stringify(nextCostumes.map((costume: AssetSummary) => [costume.index, costume.name, costume.assetId, costume.mediaId, costume.selected]));
            if (nextCostumeSignature !== costumeSignature) {
              costumeSignature = nextCostumeSignature;
              setCostumes(nextCostumes);
            }
            const editingSounds = editing.getSounds?.() ?? [];
            const nextSounds = editingSounds.map((sound: any, index: number) => {
              sound.lumoMediaId ||= crypto.randomUUID();
              return {index, name: sound.name, dataUri: cachedAssetDataUri(sound.asset, activeAssetUriKeys), assetId: String(sound.assetId ?? sound.asset?.assetId ?? ""), mediaId: sound.lumoMediaId, selected: false};
            });
            const nextSoundSignature = JSON.stringify(nextSounds.map((sound: AssetSummary) => [sound.index, sound.name, sound.assetId, sound.mediaId]));
            if (nextSoundSignature !== soundSignature) {
              soundSignature = nextSoundSignature;
              setSounds(nextSounds);
            }
            const selectedSprite = editing.sprite?.name ?? "Escenario";
            if (stateRef.current.selectedSprite !== selectedSprite) {
              const next = {...stateRef.current, selectedSprite};
              stateRef.current = next;
              setState(next);
            }
            const extensionXml = vm.runtime.getBlocksXML?.(editing) ?? [];
            const nextToolboxSignature = `${editing.id}:${JSON.stringify(extensionXml)}`;
            if (nextToolboxSignature !== toolboxSignature) {
              toolboxSignature = nextToolboxSignature;
              workspace.updateToolbox(makeCoreToolbox(Boolean(editing.isStage), extensionXml));
            }
          }
          const stage = vm.runtime?.getTargetForStage?.();
          const stageCostumes = stage?.getCostumes?.() ?? [];
          const nextBackdrops = stageCostumes.map((backdrop: any, index: number) => {
            backdrop.lumoMediaId ||= crypto.randomUUID();
            return {index, name: backdrop.name, dataUri: cachedAssetDataUri(backdrop.asset, activeAssetUriKeys), assetId: String(backdrop.assetId ?? backdrop.asset?.assetId ?? ""), mediaId: backdrop.lumoMediaId, selected: index === stage.currentCostume};
          });
          const nextBackdropSignature = JSON.stringify(nextBackdrops.map((backdrop: AssetSummary) => [backdrop.index, backdrop.name, backdrop.assetId, backdrop.mediaId, backdrop.selected]));
          if (nextBackdropSignature !== backdropSignature) {
            backdropSignature = nextBackdropSignature;
            setBackdrops(nextBackdrops);
          }
          for (const key of assetUriCache.keys()) {
            if (!activeAssetUriKeys.has(key)) assetUriCache.delete(key);
          }
        };
        const scheduleRuntimeRefresh = () => {
          if (runtimeRefreshTimer) return;
          runtimeRefreshTimer = window.setTimeout(() => {
            runtimeRefreshTimer = 0;
            refreshRuntime();
          }, 100);
        };
        refreshRuntimeRef.current = refreshRuntime;

        vm.on("EXTENSION_ADDED", (categoryInfo: any) => {
          const definitions = [...(categoryInfo.menus ?? []), ...(categoryInfo.blocks ?? [])].map((item: any) => item.json).filter(Boolean);
          if (definitions.length) ScratchBlocks.defineBlocksWithJsonArray(definitions);
          setInstalledExtensions(previous => previous.includes(categoryInfo.id) ? previous : [...previous, categoryInfo.id]);
          refreshRuntime();
        });
        vm.on("workspaceUpdate", (data: {xml?: string}) => {
          if (data?.xml) renderWorkspace(data.xml);
          refreshRuntime();
        });
        vm.on("targetsUpdate", scheduleRuntimeRefresh);
        vm.on("PROJECT_RUN_START", () => setRunning(true));
        vm.on("PROJECT_RUN_STOP", () => setRunning(false));

        workspace.addChangeListener((event: any) => {
          if (disposedRef.current || remoteDepth.current > 0 || event?.isUiEvent || !collaborativeBlockEventTypes.has(event?.type)) return;
          const eventJson = event.toJson?.() ?? event.toJson?.call(event);
          if (!eventJson) return;
          const targetName = vm.editingTarget?.sprite?.name ?? "Escenario";
          const runtimeTargetId = String(vm.editingTarget?.id ?? "");
          let targetId = targetStableIds.current.get(runtimeTargetId) ?? "";
          if (!targetId && runtimeTargetId) {
            targetId = crypto.randomUUID();
            targetStableIds.current.set(runtimeTargetId, targetId);
          }
          void sendBlockOperation(eventJson, targetName, targetId).then(seq => {
            // A structural checkpoint is the fallback when the ordered event
            // endpoint remains unavailable after its idempotent retries.
            window.setTimeout(() => void snapshotRuntime(`${identity.name} editó los bloques`, false, seq === 0), 0);
          });
        });

        const cacheSvg = (svg: string) => {
          const data = new TextEncoder().encode(svg);
          const asset = storage.createAsset(storage.AssetType.ImageVector, storage.DataFormat.SVG, data, undefined, true);
          storage.builtinHelper._store(storage.AssetType.ImageVector, storage.DataFormat.SVG, data, asset.assetId);
          return String(asset.assetId);
        };
        const stageAssetId = cacheSvg(stageSvg);
        const starterProject = buildStarterProject(stageAssetId);
        starterProjectRef.current = starterProject;

        const hydrateProjectAssets = async (projectState: ProjectState) => {
          const current = connection.current;
          for (const reference of projectState.assets ?? []) {
            if (storage.get?.(reference.assetId)) continue;
            if (!current.projectId || !current.token) throw new Error("No hay invitación para descargar assets");
            const response = await fetch(`/api/projects/${current.projectId}/assets/${encodeURIComponent(reference.assetId)}?token=${encodeURIComponent(current.token)}`, {cache: "no-store"});
            if (!response.ok) throw new Error(`Asset remoto ausente: ${reference.assetId}`);
            const data = new Uint8Array(await response.arrayBuffer());
            const assetType = storage.AssetType[reference.assetType];
            storage.builtinHelper._store(assetType, reference.dataFormat, data, reference.assetId);
            uploadedAssets.current.add(`${current.projectId}:${reference.assetId}`);
          }
        };

        restoreProjectRef.current = (projectState: ProjectState, expectedEpoch = projectEpoch.current, preserveSelection = false) => {
          const restore = projectLoadQueue.current.catch(() => {}).then(async () => {
            if (expectedEpoch !== projectEpoch.current) return false;
            restoringProject.current = true;
            try {
              const selectedBeforeRestore = vm.editingTarget?.sprite?.name;
              await hydrateProjectAssets(projectState);
              if (expectedEpoch !== projectEpoch.current) return false;
              if (projectState.projectJson) await vm.loadProject(projectState.projectJson);
              else {
                await vm.loadProject(starterProject);
                if (expectedEpoch !== projectEpoch.current) return false;
                remoteDepth.current += 1;
                try {
                  workspace.clear();
                  ScratchBlocks.Xml.domToWorkspace(textToDom(projectState.blocksXml || starterXml), workspace);
                  workspace.clearUndo?.();
                } finally {
                  remoteDepth.current = Math.max(0, remoteDepth.current - 1);
                }
              }
              if (expectedEpoch !== projectEpoch.current) return false;
              bindStableTargetIds(vm, projectState.projectJson || vmProjectJson(vm), targetStableIds.current);
              const wantedName = preserveSelection ? selectedBeforeRestore : projectState.selectedSprite;
              const wanted = vm.runtime.targets.find((target: any) => target.sprite?.name === wantedName);
              if (wanted) vm.setEditingTarget(wanted.id);
              refreshRuntime();
              return true;
            } finally {
              restoringProject.current = false;
            }
          });
          projectLoadQueue.current = restore.then(() => undefined, () => undefined);
          return restore;
        };

        vm.start();
        await vm.loadProject(starterProject);
        bindStableTargetIds(vm, vmProjectJson(vm), targetStableIds.current);
        if (stateRef.current.projectJson || stateRef.current.blocksXml) await restoreProjectRef.current(stateRef.current);
        refreshRuntime();
        setRuntimeReady(true);
        setSyncStatus(connection.current.projectId ? "En vivo" : "Listo para crear");
        window.dispatchEvent(new Event("resize"));

        const frame = () => {
          fpsFrames.current += 1;
          animationFrame = requestAnimationFrame(frame);
        };
        animationFrame = requestAnimationFrame(frame);
      } catch (error) {
        console.error(error);
        setRuntimeError("El motor Scratch no pudo iniciarse en este navegador.");
        setSyncStatus("Motor no disponible");
      }
    };
    void boot();
    const fpsTimer = window.setInterval(() => {
      setFps(fpsFrames.current);
      fpsFrames.current = 0;
    }, 1000);
    return () => {
      disposedRef.current = true;
      window.clearInterval(fpsTimer);
      window.clearTimeout(runtimeRefreshTimer);
      cancelAnimationFrame(animationFrame);
      workspaceRef.current?.dispose?.();
      if (import.meta.env.DEV) delete (window as any).__LUMO_TEST__;
      vmRef.current?.quit?.();
      rendererRef.current?.dispose?.();
    };
  }, [identity.clientId, identity.name, sendBlockOperation, snapshotRuntime]);

  const loadProject = useCallback(async (id: string, inviteToken: string, restore = true) => {
    const epoch = projectEpoch.current + 1;
    projectEpoch.current = epoch;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    localDirty.current = false;
    const query = new URLSearchParams({token: inviteToken, viewer: identity.clientId});
    const response = await fetch(`/api/projects/${id}?${query}`, {cache: "no-store"}).catch(() => null);
    if (epoch !== projectEpoch.current) return false;
    if (!response?.ok) {
      setLoadError("Este enlace de invitación no es válido o ya no está disponible.");
      return false;
    }
    const data = await response.json() as {name: string; state: ProjectState; version: number; members: Member[]; comments: Comment[]; lastEventSeq?: number};
    connection.current = {projectId: id, token: inviteToken, version: data.version, name: data.name};
    setProjectId(id);
    setToken(inviteToken);
    setProjectName(data.name);
    setVersion(data.version);
    setMembers(data.members ?? []);
    setComments(data.comments ?? []);
    data.state.structuralVersion = Math.max(0, data.state.structuralVersion ?? 0);
    data.state.assets = Array.isArray(data.state.assets) ? data.state.assets : [];
    eventCursor.current = Math.max(0, data.state.eventSeq ?? 0);
    pendingRemoteOperations.current.clear();
    failedRemoteOperations.current.clear();
    replayOwnOperations.current = false;
    stateRef.current = data.state;
    lastSyncedState.current = data.state;
    setState(data.state);
    if (restore && vmRef.current) await restoreProjectRef.current(data.state, epoch);
    setSyncStatus("En vivo");
    return true;
  }, [identity.clientId]);

  useEffect(() => {
    if (identity.clientId === "pending") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("project") ?? "";
    const invite = params.get("invite") ?? "";
    if (id && invite) void loadProject(id, invite, true);
  }, [identity.clientId, loadProject]);

  useEffect(() => {
    if (!projectId || !token) return;
    const epoch = projectEpoch.current;
    let cancelled = false;
    let polling = false;
    let refreshing = false;
    const controllers = new Set<AbortController>();
    const isCurrent = () => !cancelled && epoch === projectEpoch.current && connection.current.projectId === projectId && connection.current.token === token;
    const scopedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!isCurrent()) return null;
      const controller = new AbortController();
      controllers.add(controller);
      const response = await fetch(input, {...init, signal: controller.signal}).catch(() => null);
      controllers.delete(controller);
      return isCurrent() ? response : null;
    };
    const heartbeat = async () => {
      await scopedFetch(`/api/projects/${projectId}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({action: "presence", token, clientId: identity.clientId, name: identity.name, color: identity.color, cursorX: cursor.current.x, cursorY: cursor.current.y}),
      });
    };
    const applyOperation = (operation: RemoteOperation) => {
      const vm = vmRef.current;
      const ScratchBlocks = scratchRef.current;
      const workspace = workspaceRef.current;
      const eventJson = operation.payload?.event;
      const targetName = operation.payload?.targetName;
      const targetId = operation.payload?.targetId;
      if (!vm || !ScratchBlocks || !workspace || !eventJson || (!targetId && !targetName)) return false;
      const target = vm.runtime.targets.find((item: any) => item.isOriginal !== false && targetId && targetStableIds.current.get(item.id) === targetId) ??
        vm.runtime.targets.find((item: any) => item.isOriginal !== false && item.sprite?.name === targetName);
      if (!target) {
        pendingRemoteOperations.current.set(operation.seq, operation);
        failedRemoteOperations.current.set(operation.seq, (failedRemoteOperations.current.get(operation.seq) ?? 0) + 1);
        return false;
      }
      const previousTarget = vm.editingTarget;
      const switchedTarget = previousTarget?.id !== target.id;
      try {
        remoteDepth.current += 1;
        if (switchedTarget) vm.setEditingTarget(target.id);
        const eventType = String(eventJson.type ?? "");
        const blockId = typeof eventJson.blockId === "string" ? eventJson.blockId : "";
        const variableId = typeof eventJson.varId === "string" ? eventJson.varId : "";
        if ((eventType === "create" && blockId && workspace.getBlockById(blockId)) ||
          (eventType === "delete" && blockId && !workspace.getBlockById(blockId)) ||
          (eventType === "var_create" && variableId && workspace.getVariableById?.(variableId)) ||
          (eventType === "var_delete" && variableId && !workspace.getVariableById?.(variableId))) {
          pendingRemoteOperations.current.delete(operation.seq);
          failedRemoteOperations.current.delete(operation.seq);
          return true;
        }
        const remoteEvent = ScratchBlocks.Events.fromJson(eventJson, workspace);
        remoteEvent.recordUndo = false;
        // Event.run can generate fresh Blockly events while rebuilding XML.
        // Suppress those queued echoes and send only the original operation to
        // the VM listeners below.
        ScratchBlocks.Events.disable();
        try {
          remoteEvent.run(true);
        } finally {
          ScratchBlocks.Events.enable();
        }
        workspace.fireChangeListener(remoteEvent);
        workspace.clearUndo?.();
        pendingRemoteOperations.current.delete(operation.seq);
        failedRemoteOperations.current.delete(operation.seq);
        return true;
      } catch (error) {
        pendingRemoteOperations.current.set(operation.seq, operation);
        failedRemoteOperations.current.set(operation.seq, (failedRemoteOperations.current.get(operation.seq) ?? 0) + 1);
        console.warn("No se pudo aplicar una operación remota; se reintentará", error);
        return false;
      } finally {
        if (switchedTarget && previousTarget && vm.runtime.getTargetById(previousTarget.id)) vm.setEditingTarget(previousTarget.id);
        remoteDepth.current = Math.max(0, remoteDepth.current - 1);
      }
    };
    const drainRemoteOperations = () => {
      if (restoringProject.current || !isCurrent()) return;
      let applied = false;
      for (const operation of [...pendingRemoteOperations.current.values()].sort((a, b) => a.seq - b.seq)) {
        const accepted = applyOperation(operation);
        applied = accepted || applied;
        if (!accepted) break;
      }
      if (applied) {
        snapshotRuntime();
        setSyncStatus("En vivo");
      }
    };
    drainRemoteOperationsRef.current = drainRemoteOperations;
    const syncOperations = async () => {
      if (polling || restoringProject.current || !workspaceRef.current || !scratchRef.current || !isCurrent()) return;
      polling = true;
      try {
        const operationQuery = new URLSearchParams({token, after: String(eventCursor.current), viewer: identity.clientId});
        const response = await scopedFetch(`/api/projects/${projectId}/events?${operationQuery}`, {cache: "no-store"});
        if (response?.ok) {
          const result = await response.json() as {events: RemoteOperation[]; resetRequired?: boolean};
          if (!isCurrent() || restoringProject.current) return;
          if (result.resetRequired) {
            await refreshPresence(true);
            return;
          }
          let appliedRemote = false;
          let processed = 0;
          for (const operation of result.events) {
            if (operation.seq <= eventCursor.current) continue;
            let accepted = true;
            if (operation.clientId !== identity.clientId || replayOwnOperations.current) {
              accepted = applyOperation(operation);
              appliedRemote = accepted || appliedRemote;
            }
            // Never cross a failed operation: later delete/change events must
            // not overtake a create that is waiting for its target.
            if (!accepted) {
              if ((failedRemoteOperations.current.get(operation.seq) ?? 0) >= 2) {
                const recovered = await refreshPresence(true);
                if (recovered && isCurrent()) {
                  pendingRemoteOperations.current.delete(operation.seq);
                  failedRemoteOperations.current.delete(operation.seq);
                  eventCursor.current = Math.max(eventCursor.current, operation.seq);
                  processed += 1;
                }
              }
              break;
            }
            // Advance only after the ordered GET has observed the event. POST
            // acknowledgements never move this cursor, so interleaved edits
            // from collaborators cannot be skipped.
            eventCursor.current = Math.max(eventCursor.current, operation.seq);
            processed += 1;
          }
          if (processed && replayOwnOperations.current && pendingRemoteOperations.current.size === 0) replayOwnOperations.current = false;
          drainRemoteOperations();
          if (appliedRemote) {
            void snapshotRuntime();
            setSyncStatus("En vivo");
          }
        }
      } finally {
        polling = false;
      }
    };
    const refreshPresence = async (forceRestore = false): Promise<boolean> => {
      if (refreshing || !isCurrent()) return false;
      refreshing = true;
      try {
        const refreshQuery = new URLSearchParams({token});
        refreshQuery.set("viewer", identity.clientId);
        if (!forceRestore) refreshQuery.set("sinceVersion", String(connection.current.version));
        const response = await scopedFetch(`/api/projects/${projectId}?${refreshQuery}`, {cache: "no-store"});
        if (!response?.ok) return false;
        const data = await response.json() as {name: string; state?: ProjectState; members: Member[]; comments: Comment[]; version: number};
        if (!isCurrent()) return false;
        setMembers(data.members ?? []);
        setComments(data.comments ?? []);
        if (!data.state) return !forceRestore;
        if ((forceRestore || data.version > connection.current.version) && !localDirty.current) {
          data.state.structuralVersion = Math.max(0, data.state.structuralVersion ?? 0);
          data.state.assets = Array.isArray(data.state.assets) ? data.state.assets : [];
          const structuralRestore = forceRestore || data.state.structuralVersion > stateRef.current.structuralVersion;
          // Do not advance the CAS base past ordered block operations that the
          // VM has not observed yet. Once the cursor reaches the checkpoint,
          // stateRef and lastSyncedState can move together without a reload.
          if (!structuralRestore && eventCursor.current < Math.max(0, data.state.eventSeq ?? 0)) return false;
          connection.current.version = data.version;
          connection.current.name = data.name;
          lastSyncedState.current = data.state;
          setVersion(data.version);
          setProjectName(data.name);
          if (structuralRestore) {
            stateRef.current = data.state;
            setState(data.state);
            eventCursor.current = Math.max(0, data.state.eventSeq ?? 0);
            pendingRemoteOperations.current.clear();
            failedRemoteOperations.current.clear();
            replayOwnOperations.current = true;
            if (!await restoreProjectRef.current(data.state, epoch, true)) return false;
            if (isCurrent()) drainRemoteOperations();
          } else {
            // The ordered log already made the VM equivalent to this snapshot;
            // align the serializable baseline without disrupting the editor.
            stateRef.current = data.state;
            setState(data.state);
          }
          return true;
        }
        return !forceRestore;
      } finally {
        refreshing = false;
      }
    };
    void heartbeat();
    void syncOperations();
    const operationTimer = window.setInterval(syncOperations, 350);
    const presenceTimer = window.setInterval(heartbeat, 2500);
    const refreshTimer = window.setInterval(refreshPresence, 2500);
    return () => {
      cancelled = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      drainRemoteOperationsRef.current = () => {};
      window.clearInterval(operationTimer);
      window.clearInterval(presenceTimer);
      window.clearInterval(refreshTimer);
    };
  }, [identity, projectId, snapshotRuntime, token]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const rect = blocklyWrap.current?.getBoundingClientRect();
      if (!rect || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      cursor.current = {x: Math.round(((event.clientX - rect.left) / rect.width) * 100), y: Math.round(((event.clientY - rect.top) / rect.height) * 100)};
    };
    const key = (event: KeyboardEvent, isDown: boolean) => {
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (isDown && (element?.closest("input, textarea, select, button, [role='dialog']") || imageEditor)) return;
      vmRef.current?.postIOData?.("keyboard", {key: (!event.key || event.key === "Dead") ? event.keyCode : event.key, isDown});
    };
    const down = (event: KeyboardEvent) => key(event, true);
    const up = (event: KeyboardEvent) => key(event, false);
    window.addEventListener("pointermove", move, {passive: true});
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [imageEditor]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector('[data-testid="image-editor"]')) return;
        setInviteOpen(false);
        setExtensionOpen(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const ensureProject = async (): Promise<{id: string; inviteToken: string; version: number}> => {
    if (!runtimeReady || !vmRef.current) throw new Error("El motor todavía está cargando");
    const current = connection.current;
    if (current.projectId && current.token) {
      // A previous creation attempt may already have assigned an id while its
      // first canonical PATCH failed. Never reveal that invite until the
      // current VM state and manifest have both been confirmed by the server.
      const saved = await snapshotRuntime(undefined, true);
      if (!saved) throw new Error("No se pudo confirmar el proyecto compartido");
      const url = new URL(window.location.href);
      url.searchParams.set("project", current.projectId);
      url.searchParams.set("invite", current.token);
      window.history.replaceState({}, "", url);
      return {id: current.projectId, inviteToken: current.token, version: current.version};
    }
    if (projectCreation.current) return projectCreation.current;
    const epoch = projectEpoch.current;
    const creation = (async () => {
      setSyncStatus("Creando proyecto…");
      const captured = await snapshotRuntime(undefined, true);
      if (!captured) throw new Error("No se pudo preparar el proyecto compartido");
      const creationState = stateRef.current;
      const response = await fetch("/api/projects", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: projectName, clientId: identity.clientId, state: creationState})});
      if (!response.ok) throw new Error("No se pudo crear el proyecto");
      const data = await response.json() as {id: string; inviteToken: string; version: number; state: ProjectState};
      if (epoch !== projectEpoch.current) throw new Error("La creación del proyecto fue cancelada");
      connection.current = {projectId: data.id, token: data.inviteToken, version: data.version, name: projectName};
      lastSyncedState.current = data.state;
      const stateAfterRequest = stateRef.current;
      // POST deliberately creates an empty manifest because blobs cannot be
      // uploaded before a project id exists. Preserve the local snapshot,
      // upload its assets, then make the first size-checked PATCH canonical.
      const reconciledState = sameJsonValue(stateAfterRequest, creationState)
        ? creationState
        : mergeProjectStates(creationState, stateAfterRequest, data.state);
      stateRef.current = reconciledState;
      setState(reconciledState);
      setProjectId(data.id);
      setToken(data.inviteToken);
      setVersion(data.version);
      await uploadAssets(data.id, data.inviteToken, reconciledState.assets);
      if (epoch !== projectEpoch.current) throw new Error("La creación del proyecto fue cancelada");
      if (!sameJsonValue(data.state, stateRef.current)) {
        const saved = await persistSnapshot(stateRef.current, true);
        if (!saved) throw new Error("No se pudo confirmar el proyecto compartido");
      }
      const url = new URL(window.location.href);
      url.searchParams.set("project", data.id);
      url.searchParams.set("invite", data.inviteToken);
      window.history.replaceState({}, "", url);
      return {...data, version: connection.current.version};
    })();
    projectCreation.current = creation;
    try {
      return await creation;
    } finally {
      if (projectCreation.current === creation) projectCreation.current = null;
    }
  };

  const shareProject = async () => {
    try {
      const data = await ensureProject();
      const url = `${window.location.origin}/?project=${encodeURIComponent(data.id)}&invite=${encodeURIComponent(data.inviteToken)}`;
      setInviteOpen(true);
      try {
        await navigator.clipboard.writeText(url);
        showToast("Enlace de invitación copiado");
      } catch {
        showToast("Selecciona y copia el enlace manualmente");
      }
    } catch {
      showToast("No pudimos crear la invitación");
    }
  };

  const addComment = async () => {
    const message = commentText.trim();
    if (!message) return;
    try {
      const data = await ensureProject();
      const response = await fetch(`/api/projects/${data.id}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({action: "comment", token: data.inviteToken, clientId: identity.clientId, name: identity.name, color: identity.color, message})});
      if (!response.ok) throw new Error();
      const result = await response.json() as {comment?: Comment};
      setCommentText("");
      if (result.comment) setComments(previous => [result.comment!, ...previous.filter(comment => comment.id !== result.comment!.id)].slice(0, 20));
    } catch {
      showToast("No se pudo enviar el comentario");
    }
  };

  const runProject = () => {
    if (!runtimeReady) return showToast("El motor todavía está cargando");
    vmRef.current.greenFlag();
  };
  const stopProject = () => {
    vmRef.current?.stopAll();
    setRunning(false);
  };

  const selectSprite = (targetId: string) => {
    const vm = vmRef.current;
    const target = vm?.runtime?.getTargetById?.(targetId);
    vm?.setEditingTarget(targetId);
    if (target?.isStage && activeTab === "costumes") setActiveTab("backdrops");
    if (target && !target.isStage && activeTab === "backdrops") setActiveTab("costumes");
    refreshRuntimeRef.current();
  };

  const openTab = (tab: ActiveTab) => {
    const vm = vmRef.current;
    if (tab === "backdrops") {
      const stage = vm?.runtime?.getTargetForStage?.();
      if (stage) vm.setEditingTarget(stage.id);
    } else if (tab === "costumes" && vm?.editingTarget?.isStage) {
      const firstSprite = vm.runtime?.targets?.find((target: any) => target.isOriginal !== false && !target.isStage);
      if (firstSprite) vm.setEditingTarget(firstSprite.id);
    }
    setActiveTab(tab);
    refreshRuntimeRef.current();
  };

  const createBlankSpriteTarget = async (name?: string) => {
    const vm = vmRef.current;
    const storage = storageRef.current;
    if (!runtimeReady || !vm || !storage) throw new Error("Motor no disponible");
    const number = vm.runtime.targets.filter((target: any) => target.isOriginal !== false && !target.isStage).length + 1;
    const data = new TextEncoder().encode(blankSpriteSvg);
    const asset = storage.createAsset(storage.AssetType.ImageVector, storage.DataFormat.SVG, data, undefined, true);
    storage.builtinHelper._store(storage.AssetType.ImageVector, storage.DataFormat.SVG, data, asset.assetId);
    await vm.addSprite(buildBlankSprite(String(asset.assetId), (name || `Sprite ${number}`).slice(0, 40)));
    const target = vm.editingTarget;
    if (!target || target.isStage) throw new Error("El sprite no se creó");
    return target;
  };

  const ensureImageIdentity = (target: any, index: number) => {
    const costume = target?.getCostumes?.()?.[index];
    if (!target || !costume) return null;
    let targetStableId = targetStableIds.current.get(target.id);
    if (!targetStableId) {
      targetStableId = crypto.randomUUID();
      targetStableIds.current.set(target.id, targetStableId);
    }
    costume.lumoMediaId ||= crypto.randomUUID();
    return {targetStableId, mediaId: String(costume.lumoMediaId)};
  };

  const openImageEditor = (target: any, index: number, kind: ImageEditorDocument["kind"]) => {
    const costume = target?.getCostumes?.()?.[index];
    if (!target || !costume) return showToast(kind === "backdrop" ? "Ese fondo ya no existe" : "Ese disfraz ya no existe");
    const identity = ensureImageIdentity(target, index);
    if (!identity) return showToast(kind === "backdrop" ? "Ese fondo ya no existe" : "Ese disfraz ya no existe");
    const resolution = Math.max(1, Number(costume.bitmapResolution) || 1);
    const logicalWidth = Number(costume.size?.[0]) / resolution;
    const logicalHeight = Number(costume.size?.[1]) / resolution;
    const rotationCenterX = Number(costume.rotationCenterX) / resolution;
    const rotationCenterY = Number(costume.rotationCenterY) / resolution;
    setImageEditor({
      kind,
      name: costume.name,
      dataUri: assetDataUri(costume.asset),
      sourceExpected: true,
      ...(Number.isFinite(logicalWidth) && logicalWidth > 0 ? {width: Math.round(logicalWidth)} : {}),
      ...(Number.isFinite(logicalHeight) && logicalHeight > 0 ? {height: Math.round(logicalHeight)} : {}),
      ...(Number.isFinite(rotationCenterX) ? {rotationCenterX} : {}),
      ...(Number.isFinite(rotationCenterY) ? {rotationCenterY} : {}),
      background: kind === "backdrop" ? "white" : "transparent",
      targetId: target.id,
      targetStableId: identity.targetStableId,
      mediaId: identity.mediaId,
      index,
    });
  };

  const reopenImageEditor = (identity: {targetStableId: string; mediaId: string}, kind: ImageEditorDocument["kind"]) => {
    const vm = vmRef.current;
    const target = vm?.runtime?.targets?.find((candidate: any) => candidate.isOriginal !== false && targetStableIds.current.get(candidate.id) === identity.targetStableId);
    const index = target?.getCostumes?.().findIndex((costume: any) => costume.lumoMediaId === identity.mediaId) ?? -1;
    if (!target || index < 0) {
      showToast(kind === "backdrop" ? "Ese fondo ya no existe" : "Ese disfraz ya no existe");
      return;
    }
    openImageEditor(target, index, kind);
  };

  const addSprite = async () => {
    if (!runtimeReady) return showToast("El motor todavía está cargando");
    try {
      const target = await createBlankSpriteTarget();
      const imageIdentity = ensureImageIdentity(target, 0);
      if (!imageIdentity) throw new Error("El disfraz inicial no se creó");
      setActiveTab("costumes");
      refreshRuntimeRef.current();
      await snapshotRuntime(`${identity.name} añadió un sprite en blanco`, true, true);
      refreshRuntimeRef.current();
      reopenImageEditor(imageIdentity, "costume");
    } catch {
      showToast("No se pudo añadir el sprite");
    }
  };

  const deleteSelectedSprite = () => {
    const vm = vmRef.current;
    if (!vm?.editingTarget || vm.editingTarget.isStage) return showToast("Selecciona un sprite para eliminarlo");
    if (!window.confirm(`¿Eliminar ${vm.editingTarget.sprite.name}?`)) return;
    vm.deleteSprite(vm.editingTarget.id);
    refreshRuntimeRef.current();
    snapshotRuntime(`${identity.name} eliminó un sprite`, true, true);
  };

  const setSpriteProperty = (property: "x" | "y" | "size" | "direction", value: string) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    vmRef.current?.postSpriteInfo?.({[property]: number});
    refreshRuntimeRef.current();
    snapshotRuntime(undefined, false, true);
  };

  const renameSelectedSprite = (value: string) => {
    const vm = vmRef.current;
    const target = vm?.editingTarget;
    const name = value.trim().slice(0, 40);
    if (!target || target.isStage || !name || name === target.sprite?.name) return;
    vm.renameSprite(target.id, name);
    refreshRuntimeRef.current();
    snapshotRuntime(`${identity.name} renombró un sprite`, true, true);
  };

  const setSpriteOption = (property: "visible" | "rotationStyle", value: boolean | TargetSummary["rotationStyle"]) => {
    if (!vmRef.current?.editingTarget || vmRef.current.editingTarget.isStage) return;
    vmRef.current.postSpriteInfo({[property]: value});
    refreshRuntimeRef.current();
    snapshotRuntime(undefined, false, true);
  };

  const importProject = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!runtimeReady || !vmRef.current) return showToast("El motor todavía está cargando");
    try {
      stopProject();
      const projectBytes = await file.arrayBuffer();
      const importEpoch = projectEpoch.current;
      const imported = projectLoadQueue.current.catch(() => {}).then(async () => {
        if (importEpoch !== projectEpoch.current) return false;
        restoringProject.current = true;
        try {
          await vmRef.current.loadProject(projectBytes);
          bindStableTargetIds(vmRef.current, vmProjectJson(vmRef.current), targetStableIds.current);
          return importEpoch === projectEpoch.current;
        } finally {
          restoringProject.current = false;
        }
      });
      projectLoadQueue.current = imported.then(() => undefined, () => undefined);
      if (!await imported) return;
      workspaceRef.current?.clearUndo?.();
      setProjectName(file.name.replace(/\.sb3$/i, "").slice(0, 70) || "Proyecto importado");
      refreshRuntimeRef.current();
      const saved = await snapshotRuntime(`${identity.name} importó ${file.name}`, true, true);
      showToast(saved ? "Proyecto Scratch importado y sincronizado" : "Importado localmente; no se pudo sincronizar");
    } catch {
      showToast("Ese archivo .sb3 no es válido");
    }
  };

  const exportProject = async () => {
    if (!runtimeReady || !vmRef.current) return showToast("El motor todavía está cargando");
    try {
      const content = await vmRef.current.saveProjectSb3();
      const blob = content instanceof Blob ? content : new Blob([content], {type: "application/x.scratch.sb3"});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${projectName.replace(/[^a-z0-9áéíóúñ _-]/gi, "").trim() || "lumo-proyecto"}.sb3`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Proyecto .sb3 exportado");
    } catch {
      showToast("No se pudo exportar el proyecto");
    }
  };

  const cacheAsset = (file: File, assetType: any, dataFormat: string, data: Uint8Array) => {
    const storage = storageRef.current;
    const asset = storage.createAsset(assetType, dataFormat, data, undefined, true);
    storage.builtinHelper._store(assetType, dataFormat, data, asset.assetId);
    return {asset, name: file.name.replace(/\.[^.]+$/, "").slice(0, 40), assetId: String(asset.assetId), dataFormat, md5: `${asset.assetId}.${dataFormat}`, md5ext: `${asset.assetId}.${dataFormat}`};
  };

  const imageRecordForFile = async (file: File) => {
    if (file.size > MAX_PROJECT_ASSET_BYTES) {
      showToast("Cada recurso puede pesar hasta 1,75 MB");
      return null;
    }
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["svg", "png", "jpg", "jpeg"].includes(extension)) {
      showToast("Usa un SVG, PNG o JPG");
      return null;
    }
    const format = extension === "jpeg" ? "jpg" : extension;
    const storage = storageRef.current;
    if (!storage) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    return cacheAsset(file, format === "svg" ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap, format, data);
  };

  const targetForImageKind = (kind: ImageEditorDocument["kind"]) => {
    const vm = vmRef.current;
    return kind === "backdrop" ? vm?.runtime?.getTargetForStage?.() : (vm?.editingTarget && !vm.editingTarget.isStage ? vm.editingTarget : null);
  };

  const addCostumeFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const target = targetForImageKind("costume");
    if (!runtimeReady || !target) return showToast("Añade o selecciona primero un sprite");
    try {
      const record = await imageRecordForFile(file);
      if (!record) return;
      await vmRef.current.addCostume(record.md5ext, {...record, bitmapResolution: record.dataFormat === "svg" ? 1 : 2}, target.id);
      const imageIdentity = ensureImageIdentity(target, target.getCostumes().length - 1);
      if (!imageIdentity) throw new Error("El disfraz no se creó");
      refreshRuntimeRef.current();
      await snapshotRuntime(`${identity.name} añadió el disfraz ${record.name}`, true, true);
      refreshRuntimeRef.current();
      reopenImageEditor(imageIdentity, "costume");
    } catch {
      showToast("No se pudo cargar ese disfraz");
    }
  };

  const addBackdropFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const vm = vmRef.current;
    const stage = targetForImageKind("backdrop");
    if (!runtimeReady || !vm || !stage) return showToast("El motor todavía está cargando");
    try {
      const record = await imageRecordForFile(file);
      if (!record) return;
      setActiveTab("backdrops");
      vm.setEditingTarget(stage.id);
      await vm.addBackdrop(record.md5ext, {...record, bitmapResolution: record.dataFormat === "svg" ? 1 : 2});
      const imageIdentity = ensureImageIdentity(stage, stage.getCostumes().length - 1);
      if (!imageIdentity) throw new Error("El fondo no se creó");
      refreshRuntimeRef.current();
      await snapshotRuntime(`${identity.name} añadió el fondo ${record.name}`, true, true);
      refreshRuntimeRef.current();
      reopenImageEditor(imageIdentity, "backdrop");
    } catch {
      showToast("No se pudo cargar ese fondo");
    }
  };

  const addSpriteFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!runtimeReady) return showToast("El motor todavía está cargando");
    try {
      const record = await imageRecordForFile(file);
      if (!record) return;
      const vm = vmRef.current;
      const target = await createBlankSpriteTarget(record.name);
      await vm.addCostume(record.md5ext, {...record, bitmapResolution: record.dataFormat === "svg" ? 1 : 2}, target.id);
      vm.setEditingTarget(target.id);
      vm.deleteCostume(0);
      const imageIdentity = ensureImageIdentity(target, 0);
      if (!imageIdentity) throw new Error("El disfraz no se creó");
      setActiveTab("costumes");
      refreshRuntimeRef.current();
      await snapshotRuntime(`${identity.name} subió el sprite ${target.sprite.name}`, true, true);
      refreshRuntimeRef.current();
      reopenImageEditor(imageIdentity, "costume");
    } catch {
      showToast("No se pudo crear el sprite con esa imagen");
    }
  };

  const createImage = async (kind: ImageEditorDocument["kind"]) => {
    const vm = vmRef.current;
    const storage = storageRef.current;
    const target = targetForImageKind(kind);
    if (!runtimeReady || !vm || !storage || !target) return showToast(kind === "backdrop" ? "El motor todavía está cargando" : "Añade o selecciona primero un sprite");
    try {
      const number = (target.getCostumes?.()?.length ?? 0) + 1;
      const svg = kind === "backdrop" ? stageSvg : blankSpriteSvg;
      const data = new TextEncoder().encode(svg);
      const baseName = kind === "backdrop" ? `Fondo ${number}` : `Disfraz ${number}`;
      const file = new File([data], `${baseName}.svg`, {type: "image/svg+xml"});
      const record = cacheAsset(file, storage.AssetType.ImageVector, "svg", data);
      if (kind === "backdrop") {
        setActiveTab("backdrops");
        vm.setEditingTarget(target.id);
        await vm.addBackdrop(record.md5ext, {...record, bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180});
      } else {
        await vm.addCostume(record.md5ext, {...record, bitmapResolution: 1, rotationCenterX: 160, rotationCenterY: 160}, target.id);
      }
      const imageIdentity = ensureImageIdentity(target, target.getCostumes().length - 1);
      if (!imageIdentity) throw new Error("La imagen no se creó");
      refreshRuntimeRef.current();
      await snapshotRuntime(`${identity.name} creó ${kind === "backdrop" ? "un fondo" : "un disfraz"} en blanco`, true, true);
      refreshRuntimeRef.current();
      reopenImageEditor(imageIdentity, kind);
    } catch {
      showToast(kind === "backdrop" ? "No se pudo crear el fondo" : "No se pudo crear el disfraz");
    }
  };

  const createCostume = () => createImage("costume");
  const createBackdrop = () => createImage("backdrop");

  const renameCostume = (index: number, current: string, kind: ImageEditorDocument["kind"]) => {
    const name = window.prompt(kind === "backdrop" ? "Nombre del fondo" : "Nombre del disfraz", current)?.trim();
    if (!name) return;
    const target = targetForImageKind(kind);
    if (!target) return showToast("Ese recurso ya no existe");
    vmRef.current?.setEditingTarget(target.id);
    vmRef.current?.renameCostume(index, name.slice(0, 40));
    refreshRuntimeRef.current();
    snapshotRuntime(`${identity.name} renombró ${kind === "backdrop" ? "un fondo" : "un disfraz"}`, true, true);
  };
  const deleteCostume = (index: number, kind: ImageEditorDocument["kind"]) => {
    const target = targetForImageKind(kind);
    if (!target) return showToast("Ese recurso ya no existe");
    if ((target.getCostumes?.()?.length ?? 0) <= 1) return showToast(kind === "backdrop" ? "El escenario necesita al menos un fondo" : "Cada sprite necesita al menos un disfraz");
    vmRef.current?.setEditingTarget(target.id);
    vmRef.current?.deleteCostume(index);
    refreshRuntimeRef.current();
    snapshotRuntime(`${identity.name} eliminó ${kind === "backdrop" ? "un fondo" : "un disfraz"}`, true, true);
  };
  const selectCostume = (index: number, kind: ImageEditorDocument["kind"]) => {
    const target = targetForImageKind(kind);
    if (!target) return;
    vmRef.current?.setEditingTarget(target.id);
    target.setCostume?.(index);
    refreshRuntimeRef.current();
    snapshotRuntime(`${identity.name} cambió ${kind === "backdrop" ? "el fondo" : "el disfraz"}`, true, true);
  };

  const saveImageEdit = async (result: ImageEditorResult) => {
    const editor = imageEditor;
    const vm = vmRef.current;
    if (!editor || !vm) return false;
    if (new TextEncoder().encode(result.svg).byteLength > MAX_PROJECT_ASSET_BYTES) {
      showToast("El dibujo supera el máximo de 1,75 MB");
      return false;
    }
    let mutationStarted = false;
    let beforeState = stateRef.current;
    const epoch = projectEpoch.current;
    const rollback = async () => {
      // A retry timer owns the edited snapshot closure. Invalidate and cancel
      // it before restoring so an image the user cancelled cannot appear later.
      localRevision.current += 1;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const rollbackState = connection.current.projectId ? lastSyncedState.current : beforeState;
      stateRef.current = rollbackState;
      setState(rollbackState);
      localDirty.current = false;
      await restoreProjectRef.current(rollbackState, epoch, true);
      setSyncStatus(connection.current.projectId ? "Sincronizado" : "Listo para crear");
    };
    try {
      // Start the edit from a confirmed checkpoint. This makes the following
      // VM mutation transactional and gives rollback an exact canonical base.
      if (!await snapshotRuntime(undefined, true)) {
        showToast("Primero termina de sincronizar los cambios pendientes");
        return false;
      }
      beforeState = stateRef.current;
      const target = vm.runtime.targets.find((candidate: any) => candidate.isOriginal !== false && targetStableIds.current.get(candidate.id) === editor.targetStableId) ?? vm.runtime.getTargetById(editor.targetId);
      if (!target) {
        showToast(editor.kind === "backdrop" ? "Ese fondo fue eliminado durante la edición" : "Ese sprite fue eliminado durante la edición");
        return false;
      }
      const index = target.getCostumes?.().findIndex((costume: any) => costume.lumoMediaId === editor.mediaId) ?? -1;
      if (index < 0) {
        showToast(editor.kind === "backdrop" ? "Ese fondo fue eliminado durante la edición" : "Ese disfraz fue eliminado durante la edición");
        return false;
      }
      mutationStarted = true;
      vm.setEditingTarget(target.id);
      vm.renameCostume(index, (result.name.trim() || editor.name).slice(0, 40));
      vm.updateSvg(index, result.svg, result.rotationCenterX, result.rotationCenterY);
      target.getCostumes()[index].lumoMediaId = editor.mediaId;
      target.setCostume(index);
      refreshRuntimeRef.current();
      const saved = await snapshotRuntime(`${identity.name} editó ${editor.kind === "backdrop" ? `el fondo ${editor.name}` : `el disfraz ${editor.name}`}`, true, true);
      if (!saved) {
        await rollback();
        showToast("No se guardó el dibujo; se restauró la versión anterior");
        return false;
      }
      setImageEditor(null);
      showToast(editor.kind === "backdrop" ? "Fondo guardado" : "Disfraz guardado");
      return true;
    } catch {
      if (mutationStarted) await rollback().catch(() => undefined);
      showToast(mutationStarted ? "No se guardó el dibujo; se restauró la versión anterior" : "No se pudo guardar el dibujo");
      return false;
    }
  };

  const addSoundFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!runtimeReady || !vmRef.current?.editingTarget) return showToast("El motor todavía está cargando");
    if (file.size > MAX_PROJECT_ASSET_BYTES) return showToast("Cada recurso puede pesar hasta 1,75 MB");
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["wav", "mp3"].includes(extension)) return showToast("Usa un archivo WAV o MP3");
    try {
      const storage = storageRef.current;
      const data = new Uint8Array(await file.arrayBuffer());
      if (!validAudioBytes(data, extension)) throw new Error("Firma de audio inválida");
      const target = vmRef.current.editingTarget;
      const previousCount = target.getSounds?.().length ?? 0;
      const record = cacheAsset(file, storage.AssetType.Sound, extension, data);
      await vmRef.current.addSound({...record, md5: record.md5ext, format: "", rate: 0, sampleCount: 0}, target.id);
      const added = target.getSounds?.()[previousCount];
      if (!added || !Number.isFinite(Number(added.rate)) || Number(added.rate) <= 0 || !Number.isFinite(Number(added.sampleCount)) || Number(added.sampleCount) <= 0) {
        if ((target.getSounds?.().length ?? 0) > previousCount) {
          vmRef.current.setEditingTarget(target.id);
          vmRef.current.deleteSound(previousCount);
        }
        throw new Error("El sonido no contiene muestras reproducibles");
      }
      refreshRuntimeRef.current();
      await snapshotRuntime(`${identity.name} añadió el sonido ${record.name}`, true, true);
    } catch {
      showToast("No se pudo decodificar ese sonido");
    }
  };
  const playSound = async (dataUri: string) => {
    try {
      await new Audio(dataUri).play();
    } catch {
      showToast("El navegador bloqueó el audio");
    }
  };
  const renameSound = (index: number, current: string) => {
    const name = window.prompt("Nombre del sonido", current)?.trim();
    if (!name) return;
    vmRef.current?.renameSound(index, name.slice(0, 40));
    refreshRuntimeRef.current();
    snapshotRuntime(`${identity.name} renombró un sonido`, true, true);
  };
  const deleteSound = (index: number) => {
    vmRef.current?.deleteSound(index);
    refreshRuntimeRef.current();
    snapshotRuntime(`${identity.name} eliminó un sonido`, true, true);
  };

  const openExtensionLibrary = () => setExtensionOpen(true);
  const installExtension = (id: string) => {
    if (!runtimeReady || !vmRef.current) return showToast("El motor todavía está cargando");
    try {
      vmRef.current.extensionManager.loadExtensionIdSync(id);
      snapshotRuntime(`${identity.name} añadió la extensión ${id}`, true, true);
      showToast("Extensión añadida al toolbox");
    } catch {
      showToast("No se pudo cargar esa extensión");
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageContainer.current?.requestFullscreen();
    } catch {
      showToast("Pantalla completa no está disponible");
    }
  };

  const postMouse = (event: React.PointerEvent<HTMLCanvasElement>, isDown?: boolean) => {
    const rect = event.currentTarget.getBoundingClientRect();
    vmRef.current?.postIOData?.("mouse", {x: event.clientX - rect.left, y: event.clientY - rect.top, canvasWidth: rect.width, canvasHeight: rect.height, ...(typeof isDown === "boolean" ? {isDown} : {})});
  };

  const newProject = async () => {
    const hasWork = Boolean(projectId || projectName !== "Mi proyecto Lumo" || stateRef.current.projectJson || stateRef.current.blocksXml || stateRef.current.structuralVersion > 0);
    if (hasWork && !window.confirm(projectId
      ? "¿Crear un proyecto nuevo? Primero confirmaremos los cambios del proyecto actual."
      : "¿Crear un proyecto nuevo? Se descartarán los cambios locales de este proyecto.")) return;
    if (projectId && runtimeReady && !await snapshotRuntime(undefined, true) &&
        !window.confirm("No se pudo confirmar el último cambio. ¿Crear el proyecto nuevo y descartarlo de todos modos?")) return;
    const next = emptyState(Date.now());
    projectEpoch.current += 1;
    localRevision.current += 1;
    projectCreation.current = null;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    connection.current = {projectId: "", token: "", version: 0, name: "Mi proyecto Lumo"};
    setProjectId("");
    setToken("");
    setVersion(0);
    setProjectName("Mi proyecto Lumo");
    setMembers([]);
    setComments([]);
    eventCursor.current = 0;
    clientSequence.current = 0;
    operationQueue.current = Promise.resolve();
    pendingRemoteOperations.current.clear();
    failedRemoteOperations.current.clear();
    replayOwnOperations.current = false;
    localDirty.current = false;
    stateRef.current = next;
    lastSyncedState.current = next;
    setState(next);
    window.history.replaceState({}, "", "/");
    if (vmRef.current && starterProjectRef.current) {
      await restoreProjectRef.current(next, projectEpoch.current);
      workspaceRef.current?.clearUndo?.();
      refreshRuntimeRef.current();
    }
    setLoadError("");
    setSyncStatus("Listo para crear");
  };

  const inviteUrl = typeof window === "undefined" || !projectId ? "" : `${window.location.origin}/?project=${encodeURIComponent(projectId)}&invite=${encodeURIComponent(token)}`;
  const accountReturnTo = projectId && token ? `/?project=${encodeURIComponent(projectId)}&invite=${encodeURIComponent(token)}` : "/";
  const accountQuery = `?returnTo=${encodeURIComponent(accountReturnTo)}`;
  const accountSignOutPath = projectId && token ? `/signout-with-chatgpt?return_to=${encodeURIComponent(accountReturnTo)}` : signOutPath;
  const remoteMembers = members.filter(member => member.clientId !== identity.clientId);
  const selectedTarget = targets.find(target => target.name === state.selectedSprite) ?? targets[0];
  const spriteTargets = targets.filter(target => !target.isStage);
  const selectedDisplayName = selectedTarget?.isStage ? "Escenario" : selectedTarget?.name ?? "Escenario";
  const extensionOptions = [
    {id: "pen", icon: "✎", name: "Lápiz", text: "Dibuja, estampa y cambia color."},
    {id: "music", icon: "♫", name: "Música", text: "Notas, instrumentos y ritmo."},
    {id: "text2speech", icon: "◖", name: "Texto a voz", text: "Haz que los personajes hablen."},
    {id: "translate", icon: "文", name: "Traducir", text: "Traduce texto dentro del proyecto."},
  ];

  return (
    <main className="studio-shell">
      <header className="topbar">
        <button className="brand brand-button" onClick={newProject} aria-label="Crear proyecto nuevo"><span className="brand-mark">L</span><span>Lumo <b>Studio</b></span></button>
        <div className="project-title-wrap"><span className="project-label">PROYECTO</span><input aria-label="Nombre del proyecto" value={projectName} onChange={event => {const value = event.target.value.slice(0, 70); setProjectName(value); connection.current.name = value;}} onBlur={() => snapshotRuntime(undefined, true)} /></div>
        <div className="sync-pill"><span className={syncStatus.includes("Sin") || runtimeError ? "sync-dot offline" : "sync-dot"}/>{syncStatus}</div>
        <div className="top-actions">
          <button className="toolbar-button" disabled={!runtimeReady} onClick={() => importInput.current?.click()}>Importar .sb3</button>
          <button className="toolbar-button" disabled={!runtimeReady} onClick={exportProject}>Exportar</button>
          <input ref={importInput} hidden type="file" accept=".sb3,application/x.scratch.sb3" onChange={importProject}/>
          <button className="icon-button" disabled={!runtimeReady} aria-label="Deshacer" onClick={() => workspaceRef.current?.undo?.(false)}>↶</button>
          <button className="icon-button" disabled={!runtimeReady} aria-label="Rehacer" onClick={() => workspaceRef.current?.undo?.(true)}>↷</button>
          <div className="avatar-stack" aria-label={`${members.length || 1} personas conectadas`}>{(members.length ? members : [{clientId: identity.clientId, name: identity.name, color: identity.color} as Member]).slice(0, 4).map(member => <span key={member.clientId} className="mini-avatar" style={{background: member.color}} title={member.name}>{member.name.charAt(0)}</span>)}</div>
          <button className="invite-button" disabled={!runtimeReady} onClick={shareProject}><span>＋</span> Invitar</button>
          {user ? <div className="account-actions"><Link href={`/register${accountQuery}`} title="Editar perfil">{visibleAccountName(user, profile).split(" ")[0]}</Link><a href={accountSignOutPath}>Salir</a></div> : <div className="account-actions"><Link href={`/login${accountQuery}`}>Entrar</Link><Link className="register-link" href={`/register${accountQuery}`}>Registrarse</Link></div>}
        </div>
      </header>

      {loadError && <div className="error-banner">{loadError} <button onClick={newProject}>Crear uno nuevo</button></div>}
      {runtimeError && <div className="error-banner">{runtimeError} Revisa que WebGL y audio estén habilitados.</div>}

      <section className="editor-grid">
        <aside className="left-panel">
          <div className="editor-tabs"><button className={activeTab === "code" ? "active" : ""} onClick={() => openTab("code")}>Código</button><button className={activeTab === "costumes" ? "active" : ""} onClick={() => openTab("costumes")}>Disfraces</button><button className={activeTab === "backdrops" ? "active" : ""} onClick={() => openTab("backdrops")}>Fondos</button><button className={activeTab === "sounds" ? "active" : ""} onClick={() => openTab("sounds")}>Sonidos</button></div>
          <div className="engine-note"><span>●</span>{runtimeReady ? "Scratch VM conectado · 60 TPS" : "Cargando motor Scratch…"}</div>
          {activeTab === "code" && <><div className="tool-hint"><strong>Programa a {selectedDisplayName}</strong><span>Arrastra bloques. La bandera ejecuta exactamente lo que construyas.</span></div><div className="quick-actions"><button disabled={!runtimeReady} onClick={() => workspaceRef.current?.cleanUp?.()}>Ordenar bloques</button><button disabled={!runtimeReady} onClick={() => workspaceRef.current?.zoomToFit?.()}>Ver todo</button></div><div className="feature-list"><span>✓ Variables y listas</span><span>✓ Mis bloques</span><span>✓ Importación Scratch 3</span><span>✓ Operaciones colaborativas</span></div><button className="extensions-button" disabled={!runtimeReady} onClick={openExtensionLibrary}>▦ Añadir extensión</button></>}
          {activeTab === "costumes" && (selectedTarget && !selectedTarget.isStage ? <><div className="tool-hint"><strong>Disfraces de {selectedDisplayName}</strong><span>Dibuja desde cero o sube una imagen y edítala.</span></div><button className="panel-primary" disabled={!runtimeReady} onClick={createCostume}>✎ Dibujar disfraz</button><button className="panel-secondary" disabled={!runtimeReady} onClick={() => costumeInput.current?.click()}>Subir SVG/PNG/JPG</button><input ref={costumeInput} hidden type="file" accept="image/svg+xml,image/png,image/jpeg" onChange={addCostumeFile}/></> : <><div className="tool-hint"><strong>Proyecto sin sprites</strong><span>Añade un sprite vacío para dibujar su primer disfraz.</span></div><button className="panel-primary" disabled={!runtimeReady} onClick={addSprite}>＋ Dibujar primer sprite</button><button className="panel-secondary" disabled={!runtimeReady} onClick={() => spriteInput.current?.click()}>Subir sprite</button></>)}
          {activeTab === "backdrops" && <><div className="tool-hint"><strong>Fondos del escenario</strong><span>Edita el fondo blanco, dibuja otro o sube una imagen.</span></div><button className="panel-primary" disabled={!runtimeReady} onClick={createBackdrop}>✎ Dibujar fondo</button><button className="panel-secondary" disabled={!runtimeReady} onClick={() => backdropInput.current?.click()}>Subir SVG/PNG/JPG</button><input ref={backdropInput} hidden type="file" accept="image/svg+xml,image/png,image/jpeg" onChange={addBackdropFile}/></>}
          {activeTab === "sounds" && <><div className="tool-hint"><strong>Sonidos de {selectedDisplayName}</strong><span>Sube WAV o MP3 para usarlos desde los bloques.</span></div><button className="panel-primary" disabled={!runtimeReady} onClick={() => soundInput.current?.click()}>＋ Subir sonido</button><input ref={soundInput} hidden type="file" accept="audio/wav,audio/mpeg,.wav,.mp3" onChange={addSoundFile}/></>}
          <input ref={spriteInput} hidden type="file" accept="image/svg+xml,image/png,image/jpeg" onChange={addSpriteFile}/>
        </aside>

        <section className="workspace-panel">
          <div className="workspace-toolbar"><strong>{activeTab === "code" ? "Bloques" : activeTab === "costumes" ? "Biblioteca de disfraces" : activeTab === "backdrops" ? "Biblioteca de fondos" : "Biblioteca de sonidos"}</strong><span>{projectId ? "Edición compartida activa" : "Los cambios se guardan al invitar"}</span></div>
          <div className={activeTab === "code" ? "blockly-wrap" : "blockly-wrap hidden-workspace"} ref={blocklyWrap}>
            <div ref={blocklyHost} className="blockly-host" aria-label="Editor visual de bloques"/>
            {activeTab === "code" && remoteMembers.map(member => <div key={member.clientId} className="remote-cursor" style={{left: `${member.cursorX}%`, top: `${member.cursorY}%`, color: member.color}}><span>➤</span><b style={{background: member.color}}>{member.name}</b></div>)}
          </div>
          {activeTab === "costumes" && <div className="asset-grid">{selectedTarget && !selectedTarget.isStage ? costumes.map(costume => <article className={costume.selected ? "asset-card selected" : "asset-card"} key={costume.mediaId}><div className="asset-preview">{costume.dataUri ? <img src={costume.dataUri} alt={costume.name}/> : <span>Transparente</span>}</div><strong>{costume.name}</strong>{costume.selected && <span className="asset-badge">En uso</span>}<div><button disabled={!runtimeReady} onClick={() => selectCostume(costume.index, "costume")}>Usar</button><button className="edit" disabled={!runtimeReady} onClick={() => {const target = targetForImageKind("costume"); if (target) openImageEditor(target, costume.index, "costume");}}>✎ Editar</button><button disabled={!runtimeReady} onClick={() => renameCostume(costume.index, costume.name, "costume")}>Renombrar</button><button className="danger" disabled={!runtimeReady} onClick={() => deleteCostume(costume.index, "costume")}>Eliminar</button></div></article>) : <div className="asset-empty"><strong>El proyecto empieza completamente en blanco.</strong><span>No hay sprites ni disfraces de relleno.</span><button onClick={addSprite} disabled={!runtimeReady}>Dibujar primer sprite</button></div>}</div>}
          {activeTab === "backdrops" && <div className="asset-grid">{backdrops.map(backdrop => <article className={backdrop.selected ? "asset-card selected" : "asset-card"} key={backdrop.mediaId}><div className="asset-preview backdrop-preview">{backdrop.dataUri ? <img src={backdrop.dataUri} alt={backdrop.name}/> : <span>Blanco</span>}</div><strong>{backdrop.name}</strong>{backdrop.selected && <span className="asset-badge">Visible</span>}<div><button disabled={!runtimeReady} onClick={() => selectCostume(backdrop.index, "backdrop")}>Usar</button><button className="edit" disabled={!runtimeReady} onClick={() => {const target = targetForImageKind("backdrop"); if (target) openImageEditor(target, backdrop.index, "backdrop");}}>✎ Editar</button><button disabled={!runtimeReady} onClick={() => renameCostume(backdrop.index, backdrop.name, "backdrop")}>Renombrar</button><button className="danger" disabled={!runtimeReady} onClick={() => deleteCostume(backdrop.index, "backdrop")}>Eliminar</button></div></article>)}</div>}
          {activeTab === "sounds" && <div className="asset-grid">{sounds.map(sound => <article className="asset-card sound-card" key={sound.mediaId}><div className="sound-wave">▂▅▇▄▆▃▇▅</div><strong>{sound.name}</strong><div><button disabled={!runtimeReady} onClick={() => playSound(sound.dataUri)}>▶ Oír</button><button disabled={!runtimeReady} onClick={() => renameSound(sound.index, sound.name)}>Renombrar</button><button className="danger" disabled={!runtimeReady} onClick={() => deleteSound(sound.index)}>Eliminar</button></div></article>)}{!sounds.length && <div className="asset-empty">Todavía no hay sonidos. Sube uno desde el panel izquierdo.</div>}</div>}
        </section>

        <aside className="stage-panel">
          <div className="stage-toolbar"><div><button className={`run-button ${running ? "running" : ""}`} disabled={!runtimeReady} onClick={runProject} aria-label="Ejecutar proyecto">▶</button><button className="stop-button" disabled={!runtimeReady} onClick={stopProject} aria-label="Detener proyecto">■</button></div><span>{state.stageBackdrop}<small>60 TPS · {fps || "—"} FPS pantalla</small></span><button disabled={!runtimeReady} onClick={toggleFullscreen} aria-label="Pantalla completa">⛶</button></div>
          <div className="stage" ref={stageContainer}><canvas ref={stageCanvas} width={480} height={360} aria-label="Vista previa real del proyecto" onPointerMove={event => postMouse(event)} onPointerDown={event => {event.currentTarget.setPointerCapture(event.pointerId); postMouse(event, true);}} onPointerUp={event => postMouse(event, false)} onPointerCancel={event => postMouse(event, false)}/>{!runtimeReady && <div className="stage-loading">Iniciando Scratch VM…</div>}</div>
          <section className="sprite-section" aria-labelledby="sprites-heading"><div className="sprite-heading"><strong id="sprites-heading">Sprites</strong>{selectedTarget && !selectedTarget.isStage && <span>x {selectedTarget.x} · y {selectedTarget.y} · {selectedTarget.size}%</span>}</div><div className="sprite-list">{spriteTargets.map(target => <button key={target.id} disabled={!runtimeReady} className={state.selectedSprite === target.name ? "sprite-card selected" : "sprite-card"} onClick={() => selectSprite(target.id)}>{target.thumbnail ? <img src={target.thumbnail} alt=""/> : <span>□</span>}<b>{target.name}</b></button>)}{!spriteTargets.length && <div className="sprite-empty-state"><b>Sin sprites</b><span>Tu proyecto comienza vacío.</span></div>}<button className="add-sprite" disabled={!runtimeReady} onClick={addSprite} aria-label="Dibujar sprite nuevo">＋<small>Dibujar</small></button><button className="add-sprite upload-sprite" disabled={!runtimeReady} onClick={() => spriteInput.current?.click()} aria-label="Subir sprite desde una imagen">↑<small>Subir</small></button></div></section>
          <section className="backdrop-section" aria-labelledby="backdrops-heading"><div className="backdrop-heading"><strong id="backdrops-heading">Fondos</strong><button onClick={() => openTab("backdrops")} disabled={!runtimeReady}>Administrar</button></div><div className="backdrop-list">{backdrops.map(backdrop => <button key={backdrop.mediaId} className={backdrop.selected ? "backdrop-card selected" : "backdrop-card"} disabled={!runtimeReady} onClick={() => {selectCostume(backdrop.index, "backdrop"); if (activeTab === "costumes") setActiveTab("backdrops");}}>{backdrop.dataUri ? <img src={backdrop.dataUri} alt=""/> : <span/>}<b>{backdrop.name}</b></button>)}<button className="add-backdrop" disabled={!runtimeReady} onClick={createBackdrop} aria-label="Dibujar fondo nuevo">＋</button></div></section>
          {selectedTarget && !selectedTarget.isStage && <><div className="sprite-properties"><label className="sprite-name-field">Nombre<input key={`${selectedTarget.id}:${selectedTarget.name}`} aria-label="Nombre del sprite" disabled={!runtimeReady} defaultValue={selectedTarget.name} maxLength={40} onBlur={event => {renameSelectedSprite(event.target.value); event.currentTarget.value = vmRef.current?.editingTarget?.sprite?.name ?? selectedTarget.name;}} onKeyDown={event => {if (event.key === "Enter") event.currentTarget.blur();}}/></label><label>X<input aria-label="Posición X" disabled={!runtimeReady} type="number" value={selectedTarget.x} onChange={event => setSpriteProperty("x", event.target.value)}/></label><label>Y<input aria-label="Posición Y" disabled={!runtimeReady} type="number" value={selectedTarget.y} onChange={event => setSpriteProperty("y", event.target.value)}/></label><label>Tamaño<input aria-label="Tamaño del sprite" disabled={!runtimeReady} type="number" min="1" max="1000" value={selectedTarget.size} onChange={event => setSpriteProperty("size", event.target.value)}/></label><label>Dirección<input aria-label="Dirección del sprite" disabled={!runtimeReady} type="number" min="-179" max="180" value={selectedTarget.direction} onChange={event => setSpriteProperty("direction", event.target.value)}/></label><button className="delete-sprite" disabled={!runtimeReady} onClick={deleteSelectedSprite}>Eliminar</button></div><div className="sprite-options"><button disabled={!runtimeReady} aria-pressed={selectedTarget.visible} onClick={() => setSpriteOption("visible", !selectedTarget.visible)}>{selectedTarget.visible ? "◉ Visible" : "○ Oculto"}</button><label>Giro<select aria-label="Estilo de rotación" disabled={!runtimeReady} value={selectedTarget.rotationStyle} onChange={event => setSpriteOption("rotationStyle", event.target.value as TargetSummary["rotationStyle"])}><option value="all around">Libre</option><option value="left-right">Izquierda/derecha</option><option value="don't rotate">Sin girar</option></select></label></div></>}
          <div className="team-panel"><div className="team-tabs"><button className={!activityOpen ? "active" : ""} onClick={() => setActivityOpen(false)}>Comentarios <span>{comments.length}</span></button><button className={activityOpen ? "active" : ""} onClick={() => setActivityOpen(true)}>Actividad</button></div>{activityOpen ? <div className="activity-list">{[...state.activity].reverse().slice(0, 5).map(item => <div key={item.id}><span className="activity-icon">✓</span><p>{item.text}<small>{item.at ? new Date(item.at).toLocaleTimeString("es", {hour: "2-digit", minute: "2-digit"}) : "ahora"}</small></p></div>)}</div> : <div className="comments-list">{comments.slice(0, 5).map(comment => <div key={comment.id}><span className="comment-avatar" style={{background: comment.color}}>{comment.author.charAt(0)}</span><p><b>{comment.author}</b>{comment.message}</p></div>)}{!comments.length && <p className="empty-comments">Comenta una idea para tu equipo.</p>}<div className="comment-compose"><input disabled={!runtimeReady} value={commentText} maxLength={240} onChange={event => setCommentText(event.target.value)} onKeyDown={event => {if (event.key === "Enter") void addComment();}} placeholder="Escribe un comentario…" aria-label="Nuevo comentario"/><button disabled={!runtimeReady || !commentText.trim()} onClick={addComment} aria-label="Enviar comentario">↑</button></div></div>}</div>
        </aside>
      </section>

      <footer className="source-footer">Lumo Studio es software libre AGPL-3.0-only, sin garantía · <a href="https://github.com/cristianux2025-afk/lumo-studio" target="_blank" rel="noreferrer">Código fuente</a> · <a href="https://github.com/cristianux2025-afk/lumo-studio/blob/main/LICENSE" target="_blank" rel="noreferrer">Licencia</a> · <a href="https://github.com/cristianux2025-afk/lumo-studio/blob/main/NOTICE.md" target="_blank" rel="noreferrer">Créditos</a> · Proyecto independiente, no afiliado a Scratch Foundation.</footer>

      {inviteOpen && <div className="modal-backdrop" role="presentation" onMouseDown={event => {if (event.target === event.currentTarget) setInviteOpen(false);}}><section className="invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-title"><button className="modal-close" onClick={() => setInviteOpen(false)} aria-label="Cerrar">×</button><span className="modal-icon">↗</span><h2 id="invite-title">Crea en equipo</h2><p>Cualquier persona con este enlace podrá entrar y editar. Los bloques viajan como operaciones ordenadas para no reemplazar todo el lienzo.</p><label>Enlace de invitación</label><div className="invite-link"><input readOnly value={inviteUrl} onFocus={event => event.currentTarget.select()}/><button onClick={async () => {try {await navigator.clipboard.writeText(inviteUrl); showToast("Enlace copiado");} catch {showToast("Selecciona y copia el enlace");}}}>Copiar</button></div><div className="live-proof"><div className="avatar-stack">{[identity, ...remoteMembers].slice(0, 3).map(member => <span key={member.clientId} className="mini-avatar" style={{background: member.color}}>{member.name.charAt(0)}</span>)}</div><span><b>{Math.max(1, members.length)} en línea</b> · sincronización subsegundo</span></div><small>Abre el enlace en otra ventana para trabajar simultáneamente.</small></section></div>}
      {extensionOpen && <div className="modal-backdrop" role="presentation" onMouseDown={event => {if (event.target === event.currentTarget) setExtensionOpen(false);}}><section className="invite-modal extension-modal" role="dialog" aria-modal="true" aria-labelledby="extension-title"><button className="modal-close" onClick={() => setExtensionOpen(false)} aria-label="Cerrar">×</button><span className="modal-icon">▦</span><h2 id="extension-title">Extensiones Scratch</h2><p>Añade capacidades oficiales al motor y sus bloques al toolbox.</p><div className="extension-grid">{extensionOptions.map(option => <button key={option.id} onClick={() => installExtension(option.id)} disabled={!runtimeReady || installedExtensions.includes(option.id)}><span>{option.icon}</span><strong>{option.name}</strong><small>{installedExtensions.includes(option.id) ? "Añadida" : option.text}</small></button>)}</div></section></div>}
      {imageEditor && <ImageEditor document={imageEditor} maxAssetBytes={MAX_PROJECT_ASSET_BYTES} onClose={() => setImageEditor(null)} onSave={saveImageEdit}/>}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}
