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

## Agent support

Auto-registration supports Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness and Oh My Pi. Existing custom MCP entries are preserved and reported.

Instructions guide agents to Hub. Optional **Require Review** hooks enforce tool routing for **Claude Code and Oh My Pi on Linux/macOS**. They do not cover every client or provide an OS sandbox. In this mode, run builds/tests yourself in a terminal.

## Useful commands

- **Review Hub: Show Changes** — open pending reviews.
- **Review Hub: Scan and Register Detected Agents** — configure detected, selected clients.
- **Review Hub: Copy MCP Config for AI Tools** — prepare bundled runtime and copy manual configuration.
- **Review Hub: Install agent instructions** — add project guidance.
- **Review Hub: Show Hub Info** — inspect the active Hub for troubleshooting.

[Full installation and troubleshooting](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.md) · [Hướng dẫn tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.vi.md) · [Releases](https://github.com/TongDuyDat/hub-preview/releases) · [Report an issue](https://github.com/TongDuyDat/hub-preview/issues)

Review data is stored locally; your AI agent's settings govern model-provider access. Licensed under MIT.
