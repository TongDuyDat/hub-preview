# review-hub-mcp

Official Model Context Protocol (MCP) server for **Review Hub**.

Review Hub enables human-in-the-loop, hunk-by-hunk code review for AI coding agents (**Claude Code**, **Cline**, **Roo Code**, **opencode**, **dsh**, **Cursor**, **Windsurf**, etc.) directly inside **VS Code** and **JetBrains IDEs** (IntelliJ IDEA, WebStorm, PyCharm, CLion, GoLand, Android Studio, PhpStorm, Rider, RustRover...).

Nothing is written directly to disk until you inspect and accept each hunk.

---

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
1. Have your project open in **VS Code** (with the [Review Hub extension](https://marketplace.visualstudio.com)) or **JetBrains IDE** (with the Review Hub plugin).
2. The IDE automatically hosts the Review Hub server and publishes connection details to `~/.review-hub/hub.json`.
3. `review-hub-mcp` automatically discovers the running hub and forwards all agent edit proposals to it.

---

## Available MCP Tools

- `propose_edit`: Propose modifying part of a file (mirrors native Edit, staged for review).
- `propose_write`: Propose creating or replacing a file (staged for review).
- `propose_delete`: Propose deleting a file (staged for review).
- `read_file`: Read workspace files through the staged review state.
- `list_changes`: List all pending changes and hunk counts.
- `accept`: Accept specific hunks or entire files.
- `reject`: Reject specific hunks or revert files to baseline.
- `set_checkpoint`: Establish the current on-disk state as the new baseline.

---

## License

MIT © Tong Duy Dat

