const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcemap: true,
  target: "node18",
  logLevel: "info",
};

const extensionOptions = {
  ...common,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  outfile: "dist/extension.js",
};

// The MCP server is bundled standalone (no vscode) so harnesses can run it directly.
const mcpOptions = {
  ...common,
  entryPoints: ["mcp/mcp-server.ts"],
  external: [],
  outfile: "dist/mcp-server.cjs",
  banner: { js: "#!/usr/bin/env node" },
};

if (watch) {
  Promise.all([esbuild.context(extensionOptions), esbuild.context(mcpOptions)])
    .then(([a, b]) => Promise.all([a.watch(), b.watch()]))
    .catch(() => process.exit(1));
} else {
  Promise.all([esbuild.build(extensionOptions), esbuild.build(mcpOptions)]).catch(() => process.exit(1));
}
