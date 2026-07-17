import {readdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const packages = new Map();
const licenseTexts = new Map();
const licenseFilename = /^(?:(?:[a-z0-9]+[-_.])?licen[cs]e|copying|notice|ofl)(?:[-_.].*)?$/i;
const normalizeLicenseText = value => String(value)
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map(line => line.trimEnd())
  .join("\n")
  .trim();

const normalizeLicense = value => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeLicense).join(" OR ");
  if (value && typeof value === "object") return normalizeLicense(value.type ?? value.name);
  return "No declarado";
};

const repositoryUrl = value => {
  const raw = typeof value === "string" ? value : value?.url;
  const normalized = String(raw ?? "")
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(normalized)) return `https://github.com/${normalized}`;
  return /^https?:\/\//.test(normalized) ? normalized : "";
};

for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (
    !packagePath.startsWith("node_modules/") ||
    metadata.dev === true ||
    metadata.devOptional === true ||
    metadata.link === true
  ) {
    continue;
  }
  const directory = path.join(root, packagePath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) continue;
  packages.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: normalizeLicense(manifest.license ?? metadata.license ?? manifest.licenses),
    repository: repositoryUrl(manifest.repository ?? manifest.homepage),
  });

  let files = [];
  try {
    files = await readdir(directory);
  } catch {}
  for (const filename of files.filter(name => licenseFilename.test(name)).sort()) {
    try {
      const contents = normalizeLicenseText(await readFile(path.join(directory, filename), "utf8"));
      if (contents && !licenseTexts.has(contents)) licenseTexts.set(contents, {packages: [key], filename});
      else if (contents) licenseTexts.get(contents).packages.push(key);
    } catch {}
  }
}

const rows = [...packages.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const escapeCell = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const notice = [
  "# Avisos de dependencias de producción",
  "",
  "Este archivo se genera desde `package-lock.json` y los manifiestos instalados mediante `npm run licenses:generate`.",
  "Los textos conservados de licencia y NOTICE están en [`THIRD_PARTY_LICENSES/runtime-packages.txt`](./THIRD_PARTY_LICENSES/runtime-packages.txt).",
  "",
  "| Paquete | Versión | Licencia declarada | Repositorio |",
  "| --- | ---: | --- | --- |",
  ...rows.map(item => {
    const repository = item.repository ? `[enlace](${item.repository})` : "—";
    return `| \`${escapeCell(item.name)}\` | ${escapeCell(item.version)} | ${escapeCell(item.license)} | ${repository} |`;
  }),
  "",
  `Total: ${rows.length} paquetes de producción instalados. Los paquetes opcionales no instalados en esta plataforma no aparecen en el inventario.`,
  "",
].join("\n");

const fullTexts = [
  "THIRD-PARTY LICENSE AND NOTICE TEXTS",
  "Generated from the installed production dependency tree.",
  "",
  ...[...licenseTexts.entries()].flatMap(([contents, metadata]) => [
    "================================================================================",
    `Packages: ${metadata.packages.sort().join(", ")}`,
    `Source file: ${metadata.filename}`,
    "--------------------------------------------------------------------------------",
    contents,
    "",
  ]),
].join("\n");

await Promise.all([
  writeFile(path.join(root, "THIRD_PARTY_NOTICES.md"), notice, "utf8"),
  writeFile(path.join(root, "THIRD_PARTY_LICENSES", "runtime-packages.txt"), fullTexts, "utf8"),
]);

console.log(`Inventariados ${rows.length} paquetes y ${licenseTexts.size} textos únicos de licencia.`);
