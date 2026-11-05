# review-hub-mcp

The stdio MCP bridge for Review Hub. It forwards agent proposals to a running local Hub for human review.

[English project README](https://github.com/TongDuyDat/hub-preview/blob/main/README.md) · [Tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/README.vi.md)

## Recommended: bundled VS Code setup

The VS Code extension includes this server. Enable **Review Hub: Auto Register MCP**, select your agent and run **Review Hub: Scan and Register Detected Agents**, then reconnect the agent. There is no separate npm or Node.js installation for normal bundled setup.

See the [installation guide](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.md) ([tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.vi.md)) for supported clients, optional hooks and troubleshooting.


[Set up MCP for each agent](https://github.com/TongDuyDat/hub-preview/blob/main/docs/MCP_SETUP.md) · [Setup MCP từng agent — tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/docs/MCP_SETUP.vi.md)

## Standalone npm setup

Requires **Node.js 22.13 or newer** and Review Hub running in the same environment. Configure a stdio MCP server using your client's format; for JSON clients:

```json
{
  "mcpServers": {
    "review-hub": {
      "command": "npx",
      "args": ["-y", "review-hub-mcp"]
    }
  }
}
```

The npm release can lag repository builds; use the extension's bundled server for matching tool versions. For development, run `npm ci` and `npm run build:mcp` from the monorepo root. The npm package includes the built server and does not need a separate build after installation.

## Tool reference

Client prefixes vary; discover the actual tools in your agent. Claude may require ToolSearch. Oh My Pi may expose tools through a discovered device schema.

| Tool | Purpose |
| --- | --- |
| `propose_changes` | Batch files with exactly one of edits, content or delete per entry. |
| `propose_edit` | Replace old_string with new_string in a file. |
| `propose_write` | Create or replace a file. |
| `propose_delete` | Propose deleting a file. |
| `read_file` | Read current file content; full rereads acknowledge review decisions. |
| `list_changes` / `get_change` | Inspect pending files and hunks. |
| `get_review_updates` | Read persistent human decisions, including partial reviews; paginate with the returned cursor. |
| `list_workspaces` | Discover connected workspaces. |
| `accept` / `reject` | Apply review decisions; reserved for the human workflow when strict hooks are active. |
| `set_checkpoint` / `get_checkpoint` / `clear_checkpoint` | Manage the review baseline. Strict hooks restrict agent checkpoint changes. |

Proposals write to disk immediately. `staged_for_review` is success: builds/tests see the new code, Accept keeps it and Reject restores the previous code for selected hunks. Direct native writes and Git diffs are not imported.

If `propose_delete` is unavailable but `propose_changes` exists, use `{ "changes": [{ "path": "file.py", "delete": true }] }`. Do not emulate deletion by writing an empty file. Missing tools do not mean the Hub is unreachable.

## Review feedback

Poll `get_review_updates` using `cursor` / `after`, follow `hasMore` and handle `reset`. Accept/Reject decisions also accompany subsequent tool results. Advisory notifications do not trigger agent inference. When a proposal returns `review_decisions_changed`, fully reread affected files before proposing more edits; partial reads do not acknowledge the new baseline.

If the Hub is unavailable, open the workspace with Review Hub enabled, inspect **Review Hub: Show Hub Info** and reconnect. A native write outside MCP will not be captured as a review.

MIT · Hung, Tong Duy Dat.
