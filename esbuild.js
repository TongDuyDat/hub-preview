const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

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
  entryPoints: ["src/server/hub-server-standalone.ts"],
  external: ["node:sqlite"],
  outfile: "dist/hub-server.cjs",
  banner: { js: "#!/usr/bin/env node" },
};

const allTargets = [extensionOptions, mcpOptions, hubServerOptions];

function syncMcpPackage() {
  const mcpBinDir = path.join(__dirname, "mcp", "bin");
  fs.mkdirSync(mcpBinDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "dist", "mcp-server.cjs"),
    path.join(mcpBinDir, "mcp-server.cjs")
  );
  try {
    fs.chmodSync(path.join(mcpBinDir, "mcp-server.cjs"), 0o755);
  } catch {}
}

if (watch) {
  Promise.all(allTargets.map((opt) => esbuild.context(opt)))
    .then((contexts) => Promise.all(contexts.map((ctx) => ctx.watch())))
    .catch(() => process.exit(1));
} else {
  Promise.all(allTargets.map((opt) => esbuild.build(opt)))
    .then(() => syncMcpPackage())
    .catch(() => process.exit(1));
}
