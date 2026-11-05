# Set up Review Hub MCP in coding agents

[English](MCP_SETUP.md) | [Tiếng Việt](MCP_SETUP.vi.md) · [Installation](INSTALLATION.md)

## Recommended setup for all supported agents

1. Install Review Hub in VS Code and open your project. Keep the Hub enabled while using the agent.
2. Open Settings, enable **Review Hub: Auto Register MCP**, and select your agent under **Review Hub: Agents**. An agent checkbox alone does not enable registration. Settings apply per machine or remote host.
3. Run **Review Hub: Scan and Register Detected Agents**. Inspect its reported configuration path and result. Install/start the agent once if it is not detected, then scan again.
4. Reconnect the agent's MCP connection or start a new agent session. After an extension update, scan and reconnect again.
5. Run **Review Hub: Install agent instructions** in the project, or use **Review Hub: Copy AI Agent Rules to Clipboard** to install instructions manually in the agent's supported rules file.
6. Ask the agent to use Review Hub's `list_workspaces`, `read_file`, and proposal tools. Review the resulting changes in **Review Hub → Changes**.

The extension bundles the MCP server and prepares a stable runtime in its profile storage. Normal setup needs no npm install or separate Node.js runtime. IDE and agent must run in the same host/environment; Windows, WSL, SSH and containers have separate configurations.

## Configuration locations

These are the user-level paths targeted by this extension's adapters. `~` is the current extension host user's home directory. Existing environment overrides, profiles and custom entries can change the effective location; prefer the exact path printed by Scan.

| Agent | Default configuration | Format |
| --- | --- | --- |
| [Claude Code](#claude-code) | `~/.claude.json` | JSON, `mcpServers` |
| [Codex](#codex) | `~/.codex/config.toml` | TOML, `mcp_servers` |
| [Cursor](#cursor) | `~/.cursor/mcp.json` | JSON, `mcpServers` |
| [Windsurf](#windsurf) | `~/.codeium/windsurf/mcp_config.json` | JSON, `mcpServers` |
| [OpenCode](#opencode) | `~/.config/opencode/opencode.json` or existing `opencode.jsonc` | JSON/JSONC, `mcp` |
| [Cline](#cline) | `<globalStorage>/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | JSON, `mcpServers` |
| [Roo Code](#roo-code) | `<globalStorage>/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | JSON, `mcpServers` |
| [Gemini CLI](#gemini-cli) | `~/.gemini/settings.json` | JSON, `mcpServers` |
| [Antigravity](#antigravity) | `~/.gemini/antigravity/mcp_config.json` | JSON, `mcpServers` |
| [DeepSeek Harness](#deepseek-harness) | `~/.dsh/cordis.patch.yml` | YAML patch sequence |
| [Oh My Pi](#oh-my-pi) | `~/.omp/agent/mcp.json` | JSON, `mcpServers` |

`<globalStorage>` belongs to the active VS Code profile/remote host. Do not assume another machine's storage path. Scan preserves unrelated servers, backs up modified configuration, and reports custom/disabled entries it leaves unchanged.

## Manual setup

Prefer **Review Hub: Copy MCP Config for AI Tools** to obtain the actual bundled server's `command`, `args` and optional `env` on this machine. Copy all launch fields, including `ELECTRON_RUN_AS_NODE` if present. For OpenCode, convert `command` and `args` into its command array and use `environment` instead of `env`. For Codex, translate the fields into TOML. For DeepSeek Harness, use the YAML structure below. Scan does these conversions automatically.

The examples below use the **optional standalone npm server** for portable, concrete examples. They require Node.js **22.13+**, npm/npx on the agent's PATH, and a published `review-hub-mcp` package with the required tools. npm can lag the extension's bundled version. A running Hub is still required. Merge the entry into your existing configuration; do not replace the entire file or unrelated settings.

### Standard JSON entry

Use this shape for JSON clients listed below. Claude uses `type: "stdio"`; Cline/Roo can additionally use `disabled: false`.

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

If `npx` cannot be launched directly on Windows, use this launch entry where the client supports command/args:

```json
{
  "command": "cmd",
  "args": ["/d", "/c", "npx", "-y", "review-hub-mcp"]
}
```

### Claude Code

Select **Agents: Claude Code** and scan. The adapter uses `~/.claude.json`, or `CLAUDE_CONFIG_DIR/.claude.json` when that override is set. For manual JSON setup, merge the standard entry and add `"type": "stdio"` to the `review-hub` object. Open a new Claude session and inspect its MCP connections; use ToolSearch if Hub tools are deferred.

With **Claude: Install Instructions** enabled, auto-registration also installs a managed block into `~/.claude/CLAUDE.md` (or `CLAUDE_CONFIG_DIR/CLAUDE.md`). This rules file is separate from MCP connection configuration. Optional Require Review hooks support Claude on Linux/macOS and require Node.js on PATH; see [hook setup/removal](INSTALLATION.md#optional-require-review-through-hooks).

### Codex

Select **Agents: Codex** and scan. The adapter uses `$CODEX_HOME/config.toml`, falling back to `~/.codex/config.toml`. For manual npm setup, add this table once:

```toml
[mcp_servers."review-hub"]
command = "npx"
args = ["-y", "review-hub-mcp"]
```

When using the bundled launch, replace the command/args with those copied by the extension and preserve its environment, for example as a TOML `env` inline table. Start a new Codex session and confirm Hub tools are available. Install project instructions in `AGENTS.md`. Require Review hooks are not currently supported for Codex.

### Cursor

Select **Agents: Cursor** and scan, or merge the standard JSON entry into `~/.cursor/mcp.json`. Reconnect the server in Cursor's MCP settings or restart its agent session. Install the Hub rules using the project's supported Cursor instructions mechanism and ask it to use proposal tools.

### Windsurf

Select **Agents: Windsurf** and scan, or merge the standard JSON entry into `~/.codeium/windsurf/mcp_config.json`. Refresh/reconnect MCP in Windsurf, then start a new agent session and confirm `review-hub` is available.

### OpenCode

Select **Agents: OpenCode** and scan. The adapter honors `OPENCODE_CONFIG` and `XDG_CONFIG_HOME`; otherwise it uses the path in the table above, preferring an existing JSONC file. OpenCode uses a different structure:

```json
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

For the bundled server, use `[copiedCommand, ...copiedArgs]` and put any copied environment in `environment`. Reconnect MCP or start a new OpenCode session.

### Cline

Install/enable Cline in the same VS Code profile, select **Agents: Cline** and scan. For manual setup, open Cline's MCP server configuration and merge the standard JSON entry with `"disabled": false` inside the `review-hub` object. Its adapter path is shown in the table. Reconnect the server and start a new task with Hub instructions.

### Roo Code

Install/enable Roo Code in the same profile, select **Agents: Roo Code** and scan. For manual setup, open Roo's MCP configuration and merge the standard JSON entry with `"disabled": false`. Reconnect the server and start a new task with Hub instructions. Its storage path differs from Cline's; do not edit Cline's config for Roo.

### Gemini CLI

Select **Agents: Gemini CLI** and scan, or merge the standard JSON entry into `~/.gemini/settings.json`. Preserve existing Gemini settings. Start a new Gemini session and confirm the MCP server/tools are available.

### Antigravity

Select **Agents: Antigravity** and scan, or merge the standard JSON entry into `~/.gemini/antigravity/mcp_config.json`. Reconnect its MCP server or start a new agent session. Antigravity and Gemini CLI use separate configuration files.

### DeepSeek Harness

Select **Agents: DeepSeek Harness** and scan. The adapter uses `$DSH_HOME/cordis.patch.yml`, defaulting to `~/.dsh/cordis.patch.yml`. This file is a YAML patch sequence, not a `mcpServers` JSON map. For manual npm setup, append this operation to the existing sequence without duplicating a `review-hub` entry:

```yaml
- insert:
    - id: mcp-review-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: review-hub
        transport: stdio
        command: npx
        args: ['-y', 'review-hub-mcp']
```

For bundled setup, copy the generated command/args and optional `env` into `config`. Restart the Harness session to load the patch and confirm its MCP tools.

### Oh My Pi

Select **Agents: Oh My Pi** and scan. The default is `~/.omp/agent/mcp.json`; an existing `.mcp.json` is used if `mcp.json` does not exist. The adapter also handles `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and named `OMP_PROFILE`/`PI_PROFILE` profiles. A named profile normally uses `~/.omp/profiles/<profile>/agent/mcp.json`. Launch VS Code with the same environment/profile as OMP and use Scan's exact path.

For manual setup, merge the standard JSON entry into the active profile's config. Start a new OMP session. Some configurations expose MCP through `xd://`: discover/read the device schema, then invoke the actual Hub device with its documented JSON. Do not assume a fixed device name. Optional Require Review hooks support OMP on Linux/macOS; see the [installation guide](INSTALLATION.md#optional-require-review-through-hooks).

## Refresh instructions after an extension update

1. Run **Review Hub: Scan and Register Detected Agents** to update the bundled server for selected agents.
2. Run **Review Hub: Install agent instructions** again to refresh managed project rules, or copy the updated **Copy AI Agent Rules to Clipboard** block into the agent's rules file. Claude's managed user-level instructions also refresh on an enabled scan when **Claude: Install Instructions** is on.
3. Reconnect MCP or start a new agent session. The server now sends the shared workflow in its MCP initialization response; whether a client uses those instructions depends on the client. Existing sessions do not reload rules automatically.

The workflow covers multi-file proposals and deletion, partial review feedback, cursor replay, full rereads after human decisions, workspace selection and Require Review restrictions. Copied/project/Claude rules and the server use the same workflow source.

To avoid automatic diff tabs, turn off **Review Hub: Auto Open Diff** (`"review-hub.autoOpenDiff": false`) and reload that VS Code window. You can still review from the Hub panel or select a file with pending review. This preference does not change the MCP tools or how proposals are applied to disk.

## Confirm the agent actually uses Hub

Send a small request such as:

> Use Review Hub MCP to create `review-hub-test.txt` with two lines. Use proposal tools rather than native Edit/Write/Bash. Wait for my review and reread the file after my decision.

A successful proposal returns `staged_for_review`. Code is already on disk; **Accept keeps it, Reject restores it**. Direct editor/shell writes and Git diffs do not create reviews. You can delete the test file through `propose_delete` after checking it. If that tool is unavailable, discover/reload the tools or use `propose_changes` with a `delete: true` entry.

Connected status alone does not force the agent to call MCP. Instructions guide all clients; **Require Review** hooks currently enforce tool routing only for **Claude Code and Oh My Pi on Linux/macOS**. The agent can obtain human decisions via `get_review_updates` and subsequent tool responses, then fully reread affected files before more proposals. Notifications do not start a new agent turn.

For missing tools, old servers, host mismatches or custom configurations, see [troubleshooting](INSTALLATION.md#troubleshooting).
