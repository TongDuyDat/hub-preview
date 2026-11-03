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

Enable **Settings → Extensions → Review Hub → Auto Register MCP** and select your agents.
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
