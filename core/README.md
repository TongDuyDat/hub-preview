# @review-hub/core

The standalone core engine of Review Hub:
- **SQLite change store** (`change-store.ts`, `sqlite.ts`, `store-backend.ts`): ACID transactional storage for file baselines and multi-hunk pending/decided changes.
- **Hunk diffing algorithm** (`hunk-diff.ts`, `merged-diff.ts`): Accurate computation of diff hunks, 3-way merge resolutions, and line tracking.
- **Git baselines & snapshots** (`git-baseline.ts`, `file-snapshot.ts`): Tracking working tree checkpoints and snapshots.
- **REST Hub Server** (`hub-server.ts`, `hub-server-standalone.ts`, `registry.ts`): Local HTTP REST service communicating with IDE extensions (VS Code, JetBrains) and the MCP server.

This package has zero dependencies on any IDE or editor SDK. It runs independently under Node.js 22+.

## Exports
- `HubServer`: The HTTP REST server instance.
- `ChangeStore`: The state and SQLite management engine.
- `computeHunks`, `splitContent`, `diffContent`, `resolveLines`: Hunk diffing algorithms.
- `createRegistry`: Discovery registry for `~/.review-hub/hub.json`.
- `writeWindowState`, `readWindowStates`: Window tracking for multi-window IDE routing.

## Building
```bash
npm run build
```
Produces `dist/hub-server.cjs` and `core/dist/hub-server.cjs`.
