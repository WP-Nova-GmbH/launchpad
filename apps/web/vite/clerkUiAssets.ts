// @effect-diagnostics nodeBuiltinImport:off - Vite loads these files before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { Plugin } from "vite-plus";

const version = "1.33.1";
const entry = "ui.browser.js";
const assetPrefix = `/assets/clerk-ui/${version}/`;

export function clerkUiAssets(): Plugin {
  const require = NodeModule.createRequire(import.meta.url);
  const packageFile = require.resolve("@clerk/ui/package.json");
  const dist = NodePath.join(NodePath.dirname(packageFile), "dist");
  // The browser entry resolves lazy chunks beside itself, using this build hash.
  const chunkSuffix = `_ui_28ebeb_${version}.js`;
  const entries = NodeFS.readdirSync(dist);
  const chunks = entries.filter((name) => name.endsWith(chunkSuffix));
  if (chunks.length === 0 || !entries.includes(entry)) {
    throw new Error(
      `Update Clerk UI assets to match the installed @clerk/ui release (${version}).`,
    );
  }
  const assets = new Map(
    [entry, ...chunks].map((name) => [assetPrefix + name, NodePath.join(dist, name)]),
  );

  return {
    name: "t3code:clerk-ui-assets",
    config: () => ({
      define: { __T3CODE_DESKTOP_CLERK_UI_URL__: JSON.stringify(assetPrefix + entry) },
    }),
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const asset = assets.get(request.url?.split("?", 1)[0] ?? "");
        if (!asset || (request.method !== "GET" && request.method !== "HEAD")) {
          return next();
        }
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        if (request.method === "HEAD") return response.end();
        void NodeFSP.readFile(asset).then((source) => response.end(source), next);
      });
    },
    async generateBundle() {
      for (const [url, asset] of assets) {
        this.emitFile({
          type: "asset",
          fileName: url.slice(1),
          source: await NodeFSP.readFile(asset),
        });
      }
    },
  };
}
