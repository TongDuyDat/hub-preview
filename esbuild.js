const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcemap: true,
  target: "node22",
  logLevel: "info",
};

const extensionOptions = {
  ...common,
  entryPoints: ["src/extension.ts"],
  external: ["vscode", "node:sqlite"],
  outfile: "dist/extension.js",
};

// The MCP server is bundled standalone (no vscode) so harnesses can run it directly.
// It never imports the store, so it needs no node:sqlite external — but listing it is
// harmless and keeps the two bundles' rules identical.
const mcpOptions = {
  ...common,
  entryPoints: ["mcp/mcp-server.ts"],
  external: ["node:sqlite"],
  outfile: "dist/mcp-server.cjs",
  banner: { js: "#!/usr/bin/env node" },
};

const hubServerOptions = {
  ...common,
  entryPoints: ["src/hub-server-standalone.ts"],
  external: ["node:sqlite"],
  outfile: "dist/hub-server.cjs",
  banner: { js: "#!/usr/bin/env node" },
};

const allTargets = [extensionOptions, mcpOptions, hubServerOptions];

if (watch) {
  Promise.all(allTargets.map((opt) => esbuild.context(opt)))
    .then((contexts) => Promise.all(contexts.map((ctx) => ctx.watch())))
    .catch(() => process.exit(1));
} else {
  Promise.all(allTargets.map((opt) => esbuild.build(opt))).catch(() => process.exit(1));
}
