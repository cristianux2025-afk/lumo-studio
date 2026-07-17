import vinext from "vinext";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  // Supplying a deterministic local name also avoids Wrangler project-name
  // discovery in Vite's bundled config loader on Windows.
  name: "lumo-studio-local",
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    resolve: {
      // scratch-storage only exposes legacy `main`/`browser` fields. The SSR
      // graph otherwise selects its Node bundle while analysing this client
      // component, which pulls in minilog's non-browser formatter and fails
      // to parse. Pin the same browser build Scratch GUI uses.
      alias: [
        {
          // The 2016 helper bundled by scratch-audio calls resume() every
          // animation frame until a gesture. Use a gesture-driven equivalent
          // so an idle editor does not spam warnings or waste CPU.
          find: /^startaudiocontext$/,
          replacement: fileURLToPath(
            new URL("./vendor/start-audio-context/index.cjs", import.meta.url),
          ),
        },
        {
          find: /^scratch-storage$/,
          replacement: fileURLToPath(
            new URL("./node_modules/scratch-storage/dist/web/scratch-storage.js", import.meta.url),
          ),
        },
        {
          // scratch-audio leaves minilog external in its distributable. Force
          // the browser backend so the SSR analyser never follows ANSI-only
          // Node formatters containing legacy octal escapes.
          find: /^minilog$/,
          replacement: fileURLToPath(
            new URL("./node_modules/minilog/lib/web/index.js", import.meta.url),
          ),
        },
      ],
    },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
