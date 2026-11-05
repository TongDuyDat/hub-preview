# Installation and agent setup

[English](INSTALLATION.md) | [Tiếng Việt](INSTALLATION.vi.md) · [Project README](../README.md)

## Install VS Code extension

Requires VS Code 1.103.0 or newer. Download a VSIX from [GitHub Releases](https://github.com/TongDuyDat/hub-preview/releases), then run **Extensions: Install from VSIX...** from the Command Palette. Select the downloaded file and reload that window when prompted.

With the VS Code CLI, replace the example path with the actual VSIX:

```sh
code --install-extension /path/to/review-hub.vsix --force
```

For SSH, WSL or containers, install/enable Review Hub in the environment that owns the workspace and where the agent runs. Agent detection and configuration use the current extension host. You do not need to close unrelated IDE windows or stop other workloads.

## Connect agents

See [agent-by-agent MCP setup](MCP_SETUP.md) for configuration paths, manual examples and verification for all 11 supported agents.

1. Open your project and run **Review Hub: Scan and Register Detected Agents**. Enable registration when prompted, or use **Enable and Scan** on first launch.
2. In Settings, enable **Review Hub: Auto Register MCP** and select the relevant **Review Hub: Agents** checkboxes. Auto Register MCP is off by default and must be enabled on each machine; an agent checkbox alone is insufficient.
3. Inspect the scan results. Only detected, selected agents are configured. Supported adapters: Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness and Oh My Pi.
4. Reconnect MCP or start a new agent session after setup and extension updates.
5. Run **Review Hub: Install agent instructions** to add the managed instructions to your project. **Copy AI Agent Rules to Clipboard** is available for manual setup. With auto-registration enabled, Claude instructions can also be installed in its user-level CLAUDE.md; see **Review Hub: Claude: Install Instructions**.

The extension deploys its bundled MCP server into profile storage and uses the extension host executable. Normal bundled setup needs neither npm nor a separate Node.js installation. **Copy MCP Config for AI Tools** prepares this runtime and copies JSON for manual setup; use Scan for client-specific config formats. Do not copy another computer's absolute runtime path.

Scans preserve unrelated settings and MCP servers, back up modified configuration as `.review-hub.bak`, and leave custom, disabled or remote entries unchanged with a warning. Supported generated npm/legacy launchers migrate to the bundled runtime. Unchecking an agent or disabling auto-registration keeps existing configuration.

## Confirm that review works

Ask the agent to create a small test file **using Review Hub's proposal tools**. It should use `propose_write`, `propose_edit` or `propose_changes`. A successful `staged_for_review` result means the code is already on disk and waiting for human review.

Open **Review Hub → Changes**. Inspect the inline red/green code and Accept/Reject a block. Accept keeps new code; Reject restores the old code for that block. Pending blocks remain applied. Direct Edit/Write/Bash calls and Git diffs do not appear automatically.

Review decisions are available through `get_review_updates` and subsequent tool responses. After a decision, the agent must fully read the affected file again before further proposals. Notifications do not automatically run the agent.

## Optional: require review through hooks

**Review Hub: Require Review** supports **Claude Code and Oh My Pi on Linux/macOS**. Enable Auto Register MCP, the agent checkbox and Require Review; scan again, then start a new agent session. Claude hook commands require Node.js on PATH.

These hooks block direct writes, arbitrary shell/Python/eval, delegation, other MCP tools and agent calls that accept/reject changes or alter checkpoints. Run builds/tests yourself in a terminal while this mode is active. Other clients can use instructions, but do not have equivalent enforcement. Hooks apply while loaded; they are not an OS sandbox.

To remove the managed policy, turn Require Review off while Auto Register MCP and the agent checkbox remain enabled, scan again and start a new session. Disabling auto-registration or uninstalling the extension alone leaves installed hooks in place.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Connected, but no changes appear | Confirm the agent calls Hub proposal tools rather than native Edit/Write/Bash. Install instructions; use supported hooks if enforcement is needed. |
| Claude is selected but no MCP is added | Enable Auto Register MCP, scan, inspect results and reconnect Claude. |
| Missing `propose_delete` | Discover/reload the server's tools first. Use `propose_changes` with `{ "changes": [{ "path": "file.py", "delete": true }] }` if available. Do not replace a file with empty content to simulate deletion. |
| Claude cannot see tools | Use Claude's ToolSearch to discover Review Hub tools; prefixes may vary. Missing tools do not mean the Hub is unreachable. |
| Oh My Pi shows `xd://` tools | Read the tool/device schema, discover the Hub device and invoke that exact device with its documented JSON format. |
| Old tools after an update | Scan to update the bundled runtime, reconnect the agent and inspect **Review Hub: Show Hub Info**. If another VS Code window hosts an older Hub, reload that hosting window only. |
| Hub unavailable | Open the workspace with Review Hub enabled and use Show Hub Info. Check that IDE and agent share the same host/environment. Reconnect when the Hub is running. |
| Custom MCP config not migrated | Review the scan warning. Back up your configuration and use Copy MCP Config or your client's MCP settings to update it manually. |

## Standalone npm MCP (optional)

The npm server is for manual integrations and requires **Node.js 22.13 or newer**. A running Review Hub in the same environment is still needed. Add a stdio server using your client's configuration format; this is a JSON example:

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

The npm release can lag repository builds. Prefer the extension's bundled runtime for matching tools and behavior. See [MCP documentation](../mcp/README.md).
