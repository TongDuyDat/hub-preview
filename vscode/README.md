# Review Hub

[English](https://github.com/TongDuyDat/hub-preview/blob/main/vscode/README.md) | [Tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/vscode/README.vi.md)

Review AI code changes directly in VS Code: old code in red, new code in green, and **Accept / Reject for each block**. Browse pending proposals by workspace and file, with full project-relative paths.

## How it works

Your agent submits edits through Review Hub MCP. Proposed code is **applied to disk immediately**, so builds and tests see it. Accept keeps the code; Reject restores the previous code for the selected block. Auto Save continues to save the real file.

Opening a file with pending changes brings its review into view. When review is complete, you return to the original file. The agent can read Accept/Reject decisions and refresh the affected code before editing again.

Review Hub only imports MCP proposals. Native agent Edit/Write/Bash operations and Git diffs do not automatically create reviews.

## Get started

Requires VS Code **1.103.0 or newer**.

1. Install the extension. For a downloaded VSIX, run **Extensions: Install from VSIX...**, then reload that window if prompted.
2. Open your project and run **Review Hub: Scan and Register Detected Agents**. Enable registration when prompted.
3. Enable **Review Hub: Auto Register MCP** in Settings and select the agents to configure. Selecting an agent alone is not enough. Repeat on each machine or remote host.
4. Reconnect MCP or open a new agent session, then run **Review Hub: Install agent instructions**.
5. Ask the agent to edit through Hub. Open **Review Hub → Changes** to review each block.

The extension bundles its MCP server; normal setup needs **no separate npm install or Node.js runtime**. Optional Claude hooks require Node.js on PATH.

[Set up MCP for each agent](https://github.com/TongDuyDat/hub-preview/blob/main/docs/MCP_SETUP.md) · [Setup MCP từng agent — tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/docs/MCP_SETUP.vi.md)

## Agent support

Auto-registration supports Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness and Oh My Pi. Existing custom MCP entries are preserved and reported.

Instructions guide agents to Hub. Optional **Require Review** hooks enforce tool routing for **Claude Code and Oh My Pi on Linux/macOS**. They do not cover every client or provide an OS sandbox. In this mode, run builds/tests yourself in a terminal.

## Manual MCP setup

For the bundled server, run **Review Hub: Copy MCP Config for AI Tools** on the same machine as the agent. Use all copied launch fields (`command`, `args` and optional `env`) in your client's MCP configuration. Keep `ELECTRON_RUN_AS_NODE` if provided. Prefer Scan for automatic format conversion.

| Agent | Configuration targeted by auto-registration |
| --- | --- |
| Claude Code | `~/.claude.json` (`mcpServers`) |
| Codex | `~/.codex/config.toml` (`mcp_servers`) |
| Cursor | `~/.cursor/mcp.json` (`mcpServers`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` (`mcpServers`) |
| OpenCode | `~/.config/opencode/opencode.json` or existing `.jsonc` (`mcp`) |
| Cline | Active profile's `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Roo Code | Active profile's `globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` |
| Gemini CLI | `~/.gemini/settings.json` (`mcpServers`) |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` (`mcpServers`) |
| DeepSeek Harness | `~/.dsh/cordis.patch.yml` (Cordis YAML patch sequence) |
| Oh My Pi | `~/.omp/agent/mcp.json` (`mcpServers`; profile overrides supported) |

Paths refer to the extension host's user home and active profile. Environment overrides can change these locations; check the actual path printed by Scan. Merge entries with existing settings rather than replacing the whole file.

An **optional standalone npm** entry for JSON clients is shown below. This alternative requires Node.js **22.13+**, npm/npx on the agent's PATH, and a running Hub in the same environment. Normal bundled setup does not need it.

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

Codex uses TOML, OpenCode uses a command array, and DeepSeek Harness uses YAML. See the [agent-by-agent guide](https://github.com/TongDuyDat/hub-preview/blob/main/docs/MCP_SETUP.md) for their exact examples, Windows launch options and profile handling.

After configuring MCP, reconnect the agent, install the Hub instructions and ask it to create a small test file **through Hub proposal tools**. A `staged_for_review` result and an entry in **Review Hub → Changes** confirm the review flow. Connected status alone does not ensure that the agent uses Hub instead of native Edit/Write/Bash.

## Useful commands

- **Review Hub: Show Changes** — open pending reviews.
- **Review Hub: Scan and Register Detected Agents** — configure detected, selected clients.
- **Review Hub: Copy MCP Config for AI Tools** — prepare bundled runtime and copy manual configuration.
- **Review Hub: Install agent instructions** — add project guidance.
- **Review Hub: Show Hub Info** — inspect the active Hub for troubleshooting.

[Full installation and troubleshooting](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.md) · [Hướng dẫn tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.vi.md) · [Releases](https://github.com/TongDuyDat/hub-preview/releases) · [Report an issue](https://github.com/TongDuyDat/hub-preview/issues)

Review data is stored locally; your AI agent's settings govern model-provider access. Licensed under MIT.
