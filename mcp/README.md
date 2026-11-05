# review-hub-mcp

**Tác giả:** Hung, Tong Duy Dat

Official Model Context Protocol (MCP) server for **Review Hub**.

Review Hub enables human-in-the-loop, hunk-by-hunk code review for AI coding agents (**Claude Code**, **Cline**, **Roo Code**, **opencode**, **dsh**, **Cursor**, **Windsurf**, etc.) directly inside **VS Code** and **JetBrains IDEs** (IntelliJ IDEA, WebStorm, PyCharm, CLion, GoLand, Android Studio, PhpStorm, Rider, RustRover...).

Proposals are written to disk immediately so builds and tests use the new code.
Review Hub keeps the original baseline: Accept keeps the new code; Reject restores
the old code for the selected hunks. Unreviewed hunks remain applied.

---

## Requirements

Node.js **22.13.0 or newer**. Install the VS Code extension from [GitHub Releases](https://github.com/TongDuyDat/hub-preview/releases/latest), or use the JetBrains plugin.

## Quick Start

You do not need to install this package manually. Run it directly with `npx`:

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

---

## Configuration by Tool

### 1. Claude Code CLI
Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "review-hub": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "review-hub-mcp"]
    }
  }
}
```

### 2. Cline / Roo Code (VS Code & JetBrains)
Add to your `mcp_settings.json`:
```json
{
  "mcpServers": {
    "review-hub": {
      "command": "npx",
      "args": ["-y", "review-hub-mcp"],
      "disabled": false
    }
  }
}
```

### 3. opencode
Add to `~/.config/opencode/opencode.jsonc`:
```jsonc
{
  "mcp": {
    "review-hub": {
      "type": "local",
      "command": ["npx", "-y", "review-hub-mcp"],
      "enabled": true
    }
  }
}
```

### 4. Cursor / Windsurf / Zed
Add an MCP stdio server with:
- **Command:** `npx`
- **Args:** `-y`, `review-hub-mcp`

---

## Prerequisites

To review and accept changes proposed by the AI:
1. Have your project open in **VS Code** (with the [Review Hub extension from GitHub Releases](https://github.com/TongDuyDat/hub-preview/releases/latest)) or **JetBrains IDE** (with the Review Hub plugin).
2. The IDE automatically hosts the Review Hub server and publishes connection details to `~/.review-hub/hub.json`.
3. `review-hub-mcp` automatically discovers the running hub and forwards all agent edit proposals to it.

---

## Available MCP Tools

- `propose_changes`: Batch edits, writes and deletions across files in one call. Automatically reads current content, applies sequential edits per file, normalizes paths/EOL, and returns bounded changed excerpts or error context. Writes immediately and retains the baseline for review.
- `propose_edit`: Propose modifying part of a file (mirrors native Edit, auto-adapts CRLF/LF line endings, staged for review).
- `propose_write`: Propose creating or replacing a file (staged for review).
- `propose_delete`: Propose deleting a file (staged for review).
- `read_file`: Read workspace files through the staged review state (supports line range and line numbers).
- `list_changes`: List all pending changes and hunk counts.
- `get_change`: Inspect detailed hunks and unified diff for any pending change.
- `accept`: Accept specific hunks or entire files, keeping their new code on disk.
- `reject`: Reject specific hunks or revert files to baseline.
- `set_checkpoint`: Establish the current on-disk state as the new baseline.
- `get_checkpoint`: Check status and file count of the current checkpoint.
- `clear_checkpoint`: Reset the current checkpoint baseline.
- `list_workspaces`: List all workspaces tracked by Review Hub.

### Batch changes

Prefer `propose_changes` to avoid separate read/edit/verify calls:

```json
{
  "changes": [
    {"path": "src/config.ts", "edits": [
      {"old_string": "timeout: 1000", "new_string": "timeout: 3000"},
      {"old_string": "retries: 1", "new_string": "retries: 3"}
    ]},
    {"path": "notes.txt", "content": "New file\n"},
    {"path": "obsolete.txt", "delete": true}
  ]
}
```

Each entry must provide exactly one of `edits`, `content`, or `delete: true`.
Edits run in order against the latest staged content. A failed edit leaves that
file's prior review state unchanged; other file entries still run. Inspect
`results` for `staged_for_review`, `unchanged`, or `error` and retry only failed
entries. `partial_success` means some entries failed, not that successful edits
need resubmitting. Duplicate paths (including aliases) are rejected; combine
their edits in one entry. Missing files require `content` to create them.

Successful edits return up to three short excerpts of the resulting content.
Pass `include_context: false` to omit them. Matching failures always include
bounded context from the staged content **before** this batch, a zero-based
`failed_edit` index, and a reason. Correct and retry the complete failed file
entry; its earlier edits were not staged. Excerpts marked `truncated` must not
be used as exact replacement input. No fuzzy replacement or automatic acceptance
is performed. Review remains per hunk in the IDE.

`staged_for_review` means **written to disk and awaiting review**, with `applied: true`
on each successful proposal result. Run builds/tests directly in the workspace.
Accept keeps new code, while Reject restores baseline lines (or removes a new file).
Deleting a file takes effect immediately; Reject restores it. The original baseline
is retained across repeated proposals until the review is resolved.

### MCP Resources & Prompts
- **Resources**: `review-hub://changes`, `review-hub://workspaces`
- **Prompts**: `review_pending_changes`

---

## License

MIT © Tong Duy Dat


### Agent feedback after review

`get_review_updates` returns persistent Accept/Reject events with changed hunk IDs,
accepted/rejected/pending counts, resolution state, and a cursor. Pass the returned
`cursor` as `after` to continue; fetch more pages while `hasMore` is true. `reset`
means the cursor is outside the retained read window: inspect current change state
and re-read files. History includes resolved files after they leave the pending list.
The metadata journal contains no source text; reads are bounded to its last 1 MiB.

While an MCP session is connected, decisions for workspaces it has used are grouped
into advisory `notifications/message` logs (about every 1.5 seconds). Clients may
ignore logs; they do not start a model turn or incur inference by themselves. New
review decisions also appear as `review_updates` in subsequent normal tool results.
A proposal against a file reviewed since this session last checked is blocked with
`review_decisions_changed` until `read_file` re-reads that file. Preserve accepted
code and never automatically re-propose rejected hunks without a new user request.
This gate is session-based; reconnecting agents should use `get_review_updates` to
replay history. Update both extension/Hub and MCP server to enable feedback. Older
Hubs retain normal tool behavior but the feedback tool reports unavailability.

### One bundled MCP server for every registered agent

With Auto Register MCP enabled, the VS Code extension installs its bundled MCP server
in its profile storage and uses that same runtime for all 11 supported agent adapters.
This provides proposal tools (including deletion), batch edits and review feedback
without depending on an old global copy or the currently published npm package.
It uses the extension host executable, with ELECTRON_RUN_AS_NODE for desktop hosts;
OpenCode's environment field, Codex TOML and DeepSeek Harness YAML are serialized
according to their adapter format. Restart/reconnect agent MCP sessions after updates.

Known generated `npx -y review-hub-mcp` launchers and exact legacy Review Hub paths
are upgraded on opted-in scans. Custom launchers, remote entries, disabled entries,
and TOML layouts that cannot be changed safely remain intact and produce a warning.
Existing environment settings and other servers are preserved. Updating the extension
refreshes the runtime at a stable profile path; no per-agent manual copy is required.
This is MCP tool availability for every adapter; mandatory tool hooks remain limited
to clients that support them. Installing the VSIX alone does not enable registration.
