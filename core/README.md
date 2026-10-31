# @review-hub/core

The standalone core engine of Review Hub:
- **SQLite change store** (`change-store.ts`, `sqlite.ts`, `store-backend.ts`): ACID transactional storage for file baselines and multi-hunk pending/decided changes.
- **Hunk diffing algorithm** (`hunk-diff.ts`, `merged-diff.ts`): Accurate computation of diff hunks, 3-way merge resolutions, and line tracking.
- **Git baselines & snapshots** (`git-baseline.ts`, `file-snapshot.ts`): Tracking working tree checkpoints and snapshots.
- **REST Hub Server** (`hub-server.ts`, `hub-server-standalone.ts`, `registry.ts`): Local HTTP REST service communicating with IDE extensions (VS Code, JetBrains) and the MCP server.

This package has zero dependencies on any IDE or editor SDK. It can run independently under Node.js 22+.

