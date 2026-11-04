# Review Hub for VS Code

Review AI edits as red/green inline diffs and accept or reject individual code blocks.

## Features

- Review only edits submitted through Review Hub MCP, without importing Git diffs.
- Accept or reject each block independently; decisions update the original file immediately.
- Open a file with pending edits to reveal its inline review in the same editor group.
- Return to the original file after the last block is resolved, with Auto Save support.
- Browse files and their changed blocks in a compact Explorer-style panel.
- Enable **Auto Register MCP** in Settings for 11 agents, including DeepSeek Harness and Oh My Pi.

## Install

Download the VSIX from [GitHub Releases](https://github.com/TongDuyDat/hub-preview/releases/latest).
In VS Code, select **Extensions → … → Install from VSIX…**, then reload a test window.

```bash
code --install-extension review-hub-vscode-0.3.4.vsix --force
```

On a new machine, choose **Enable and Scan** in the first-run prompt, or run **Review Hub: Scan and Register Detected Agents** from the Command Palette. You can also enable **Settings → Extensions → Review Hub → Auto Register MCP** and select your agents. This opt-in is local to each machine and does not sync.

For Claude Code on Linux, setup detects both the VS Code extension and the native `~/.local/bin/claude` installation, even when VS Code has a different PATH. The user-level MCP entry is added to `~/.claude.json` (or `CLAUDE_CONFIG_DIR/.claude.json`). Run `claude mcp list` in a new Claude session to check it. See **Output → Review Hub** for the detected agent and configuration path.
When **Claude: Install Instructions** is enabled (the default), automatic Claude setup also adds a managed Review Hub section to `~/.claude/CLAUDE.md` (or `CLAUDE_CONFIG_DIR/CLAUDE.md`). Existing instructions are preserved, an initial `.review-hub.bak` is kept, and repeated scans do not duplicate the section. This also works when the MCP connection was already configured. Restart the Claude session to load the rules. The rules guide Claude to `propose_edit`/`propose_write`/`propose_delete`; they are not an enforcement hook. Turning the setting off stops updates without removing existing rules.

The MCP server requires Node.js 22.13 or newer on the agent host.
Marketplace publication is planned separately; the public VSIX is available through GitHub Releases.

## Build

From the repository root:

```bash
npm ci
npm run package:vscode
```

The build produces `vscode/review-hub-vscode-0.3.4.vsix`.
See [PUBLISHING.md](https://github.com/TongDuyDat/hub-preview/blob/main/PUBLISHING.md) for release and npm instructions.
