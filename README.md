# Review Hub

[English](README.md) | [Tiếng Việt](README.vi.md)

Review AI code changes in VS Code with inline red/green diffs and Accept/Reject actions for each block. Review Hub receives proposals through MCP and groups them by workspace, file and code block, with full project-relative paths.

Proposals are **written to disk immediately**, so builds and tests run against the proposed code. **Accept** keeps a change; **Reject** restores the previous code for the selected block. Review Hub tracks MCP proposals; direct editor writes, shell writes and Git diffs do not create reviews.

## Install and connect

Requires VS Code **1.103.0 or newer**.

1. Download a `.vsix` from [GitHub Releases](https://github.com/TongDuyDat/hub-preview/releases).
2. In VS Code, run **Extensions: Install from VSIX...**, select the file, then reload that window if prompted. Alternatively: `code --install-extension /path/to/review-hub.vsix --force` (replace the path with your downloaded file).
3. Open your project. Run **Review Hub: Scan and Register Detected Agents** and enable registration when prompted, or choose **Enable and Scan** on first launch.
4. In Settings, enable **Review Hub: Auto Register MCP** and select the agents to include. Selecting an agent alone does not enable registration. Repeat setup on each machine or remote host.
5. Reconnect the agent's MCP connection or start a new agent session. Run **Review Hub: Install agent instructions** for project instructions, then ask the agent to edit through Review Hub.

The VSIX includes the MCP server. You do **not** need to install the npm package or a separate Node.js runtime for normal bundled MCP setup. Some optional hooks have additional requirements; see the [installation guide](docs/INSTALLATION.md).

Marketplace publishing instructions are available below. This README does not assume a Marketplace listing is already published.

## Review workflow

- Open **Review Hub → Changes**, expand a file, then select a block to review it in the editor.
- Keep or restore individual blocks, a whole file, or all changes. Pending blocks stay applied on disk.
- Auto Save operates on the real file. Opening a file with pending review brings its review into view; completing review returns to the original file.
- Agent tools expose review decisions through `get_review_updates` and subsequent tool responses. An agent must reread affected files before proposing more edits after a decision. Notifications alone do not start a new agent turn.

Auto-registration supports **Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness and Oh My Pi**. Existing custom MCP entries are preserved and reported instead of overwritten.

Instructions guide supported agents to use Hub tools. Optional **Require Review** hooks enforce tool routing for **Claude Code and Oh My Pi on Linux/macOS**; they are not available for every supported client and are not an operating-system sandbox.

## Documentation

| Topic | English | Tiếng Việt |
| --- | --- | --- |
| Agent-specific MCP setup | [MCP setup](docs/MCP_SETUP.md) | [Setup từng agent](docs/MCP_SETUP.vi.md) |
| Installation, agent setup and troubleshooting | [Installation](docs/INSTALLATION.md) | [Cài đặt](docs/INSTALLATION.vi.md) |
| VS Code extension | [Extension README](vscode/README.md) | [README extension](vscode/README.vi.md) |
| Marketplace, GitHub Releases and npm publishing | [Publishing](PUBLISHING.md) | [Phát hành](PUBLISHING.vi.md) |
| MCP server and tools | [MCP README](mcp/README.md) | [Thiết lập MCP](docs/INSTALLATION.vi.md) |

See [CHANGELOG.md](CHANGELOG.md) for release history and [the website](https://tongduydat.github.io/hub-preview/) for downloads. A JetBrains plugin is also included in the repository; its releases and feature availability are separate from the VS Code extension.

## Development

Requires **Node.js 22.13 or newer** and npm. From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run package:vscode
```

The VSIX is generated in `vscode/`. The monorepo contains the shared engine (`core/`), MCP server (`mcp/`), VS Code extension (`vscode/`), JetBrains plugin (`jetbrains/`) and static website (`docs/`).

Review Hub stores review data locally. Your AI agent's privacy settings govern what it sends to its model provider. See [LICENSE](LICENSE) for the MIT license.
