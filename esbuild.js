const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");

// Generate the extension icon from its reviewable image source.
const icon = Buffer.from(fs.readFileSync(path.join(__dirname, "vscode/resources/icons/review-hub.png.base64"), "utf8"), "base64");
fs.mkdirSync(path.join(__dirname, "vscode/dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "vscode/dist/icon.png"), icon);

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
  entryPoints: ["vscode/src/extension.ts"],
  external: ["vscode", "node:sqlite"],
  outfile: "vscode/dist/extension.js",
};

// The MCP server is bundled standalone (no vscode) so harnesses can run it directly.
const mcpOptions = {
  ...common,
  entryPoints: ["mcp/mcp-server.ts"],
  external: ["node:sqlite"],
  outfile: "dist/mcp-server.cjs",
  banner: { js: "#!/usr/bin/env node" },
};

const hubServerOptions = {
  ...common,
  entryPoints: ["core/src/hub-server-standalone.ts"],
  external: ["node:sqlite"],
  outfile: "core/dist/hub-server.cjs",
  banner: { js: "#!/usr/bin/env node" },
};

const allTargets = [extensionOptions, mcpOptions, hubServerOptions];

function syncArtifacts() {
  // Sync mcp-server.cjs to mcp/bin/
  const mcpBinDir = path.join(__dirname, "mcp", "bin");
  fs.mkdirSync(mcpBinDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "dist", "mcp-server.cjs"),
    path.join(mcpBinDir, "mcp-server.cjs")
  );
  try {
    fs.chmodSync(path.join(mcpBinDir, "mcp-server.cjs"), 0o755);
  } catch {}

  // Ship exactly the same MCP implementation with VSIX: no stale global/npm dependency.
  fs.copyFileSync(path.join(__dirname, "dist", "mcp-server.cjs"), path.join(__dirname, "vscode", "dist", "mcp-server.cjs"));

  // Sync hub-server.cjs to root dist/ for JetBrains and backwards compatibility
  const distDir = path.join(__dirname, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "core", "dist", "hub-server.cjs"),
    path.join(distDir, "hub-server.cjs")
  );
  try {
    fs.chmodSync(path.join(distDir, "hub-server.cjs"), 0o755);
  } catch {}

  // Sync extension.js to root dist/ for backwards compatibility
  fs.copyFileSync(
    path.join(__dirname, "vscode", "dist", "extension.js"),
    path.join(distDir, "extension.js")
  );
  if (fs.existsSync(path.join(__dirname, "vscode", "dist", "extension.js.map"))) {
    fs.copyFileSync(
      path.join(__dirname, "vscode", "dist", "extension.js.map"),
      path.join(distDir, "extension.js.map")
    );
  }
}

if (watch) {
  Promise.all(allTargets.map((opt) => esbuild.context(opt)))
    .then((contexts) => Promise.all(contexts.map((ctx) => ctx.watch())))
    .catch(() => process.exit(1));
} else {
  Promise.all(allTargets.map((opt) => esbuild.build(opt)))
    .then(() => syncArtifacts())
    .catch(() => process.exit(1));
}
