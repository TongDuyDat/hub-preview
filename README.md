# Review Hub (VS Code & JetBrains IDEs)

<img src="docs/assets/review-hub.svg" width="96" height="96" alt="Review Hub: robot, code changes and a magnifier with a check mark">

**Tác giả:** Hung, Tong Duy Dat

Xem **chính xác** AI coding agent đã đổi gì trong project của bạn — **bất kể agent chạy ở chế độ quyền nào** — và duyệt/từ chối **từng khối (hunk) một**, kiểu hunkwise.

Hỗ trợ đồng thời cả **Visual Studio Code** và **JetBrains IDEs** (IntelliJ IDEA, WebStorm, PyCharm, CLion, GoLand, Android Studio, PhpStorm, Rider, RustRover...).

Tương thích với tất cả AI Coding Agents phổ biến: **Claude Code, Cursor, Windsurf, opencode, dsh, Cline, Roo Code, Antigravity...** qua giao thức MCP chuẩn.

> **Điểm cốt lõi:** Review Hub **ghi code mới xuống đĩa ngay khi agent đề xuất**, để build/test dùng đúng code mới. Hub lưu bản gốc (baseline) để hiển thị diff xuyên suốt các lần sửa. **Accept** giữ code mới; **Reject** khôi phục code cũ theo từng hunk. Các hunk chưa duyệt vẫn giữ code mới trên đĩa.

---

## Mục lục

1. [Kiến trúc tổng quan](#1-kiến-trúc-tổng-quan)
2. [Vấn đề giải quyết](#2-vấn-đề-giải-quyết)
3. [Cài đặt & Khởi động](#3-cài-đặt--khởi-động)
   - [3.1. Dành cho VS Code](#31-dành-cho-vs-code)
   - [3.2. Dành cho JetBrains IDEs](#32-dành-cho-jetbrains-ides)
   - [3.3. Cấu hình MCP cho AI Tools](#33-cấu-hình-mcp-cho-ai-tools)
4. [Bề mặt giao diện](#4-bề-mặt-giao-diện)
   - [Giao diện trên VS Code](#giao-diện-trên-vs-code)
   - [Giao diện trên JetBrains IDEs](#giao-diện-trên-jetbrains-ides)
5. [MCP Tools & Resources](#5-mcp-tools--resources)
6. [Cấu trúc mã nguồn Monorepo](#6-cấu-trúc-mã-nguồn-monorepo)
7. [Hướng dẫn phát triển (Development & Build)](#7-hướng-dẫn-phát-triển-development--build)
8. [Cơ chế lưu trữ & Snapshot](#8-cơ-chế-lưu-trữ--snapshot)
9. [Xử lý sự cố (Troubleshooting)](#9-xử-lý-sự-cố-troubleshooting)

---

## 1. Kiến trúc tổng quan

Review Hub hoạt động theo mô hình **Shared Hub Architecture** (kiến trúc tập trung):

```text
[Claude Code / Cursor / Windsurf / Cline / Roo / opencode]
                 │
                 │ stdio (MCP Protocol: review-hub-mcp)
                 ▼
         [MCP Server (review-hub-mcp)]
                 │
                 │ HTTP REST (127.0.0.1:<random_port>)
                 ▼
     ┌───────────────────────────┐
     │     Review Hub Server     │  Discovery: ~/.review-hub/hub.json
     │   (@review-hub/core)      │  Database: ~/.review-hub/hub.db
     └─────────────┬─────────────┘
                   ▲
       ┌───────────┴───────────┐
       │                       │
 [VS Code Extension]     [JetBrains Plugin]
   ├── Sidebar Webview     ├── ToolWindow Panel
   ├── Inline Diff View    ├── Native Diff Viewer
   └── Explorer Badges     └── Project Tree Badges
```

- **Hub Server (`@review-hub/core`)**: Đóng vai trò là single source of truth, quản lý database SQLite, tính toán hunk diff và lưu trữ baseline. Hub có thể được host bởi VS Code extension hoặc chạy daemon độc lập.
- **MCP Server (`review-hub-mcp`)**: Package độc lập trên npm registry, kết nối qua stdio với các AI harness, chuyển tiếp các lệnh đề xuất sửa file (`propose_edit`, `propose_write`, `propose_delete`) về Hub Server.
- **IDE Clients (VS Code & JetBrains)**: Kết nối tới Hub Server qua REST API (xác thực bằng Bearer token được tạo ngẫu nhiên lưu tại `~/.review-hub/hub.json`). Cả 2 IDE có thể mở cùng lúc và dùng chung một phiên review.

---

## 2. Vấn đề giải quyết

Khi agent chạy ở chế độ tự động duyệt (Claude Code `acceptEdits`, Cline auto-approve, Cursor, opencode), nó ghi thẳng xuống đĩa và **không cho bạn thấy gì cả**. Còn khi nó có hiện diff thì diff đó biến mất ngay sau khi bạn accept — không có danh sách "từ lần trước tới giờ đã đổi những gì".

Review Hub giải quyết cả hai bằng cách nằm **bên dưới** agent, ở tầng filesystem:

| Cơ chế | Tác dụng |
|---|---|
| **MCP server "staging"** | Agent gọi nó thay vì sửa file trực tiếp → thay đổi chờ bạn duyệt, không ghi lên đĩa |
| **File watcher** | Bắt kịp thời các lệnh ghi file trực tiếp từ FS → cho phép revert từng khối |

### Bảng trạng thái đĩa:
| Hành động | Trên đĩa sau đó |
|---|---|
| Agent đề xuất (`propose_edit`) | **Không đổi** — vẫn là bản gốc |
| Bạn bấm ✓ một hunk | Đúng các dòng mới của hunk đó được ghi vào file |
| Bạn bấm ↺ một hunk | Không ghi gì (giữ nguyên dòng gốc) |
| Hunk chưa quyết định | Không có trên đĩa |

---

## 3. Cài đặt & Khởi động

### 3.1. Dành cho VS Code

Yêu cầu: **VS Code 1.103.0 trở lên**.

- **Cài đặt file VSIX:**
  ```bash
  code --install-extension vscode/review-hub-vscode-0.2.0.vsix
  ```
- **Copy MCP Config:**
  Mở Command Palette (`Ctrl+Shift+P`) → Chạy `Review Hub: Copy MCP Config for AI Tools`.
- **Hướng dẫn cho Agent:**
  Chạy lệnh `Review Hub: Install agent instructions` để chèn hướng dẫn sử dụng MCP tool vào `CLAUDE.md`, `.cursorrules`,...

### 3.2. Dành cho JetBrains IDEs

Yêu cầu: **JetBrains IDE 2024.1 trở lên** (IntelliJ, WebStorm, PyCharm...).

- **Cài đặt plugin:**
  Vào `Settings` → `Plugins` → Cài từ file ZIP (`review-hub-jetbrains-<version>.zip`).
- **Copy MCP Config:**
  Trong ToolWindow **Review Hub**, bấm nút `Copy MCP Config`.

### 3.3. Cấu hình MCP cho AI Tools

Thêm cấu hình sau vào công cụ AI của bạn (Claude Code, Cline, Roo Code, Cursor, Windsurf, OpenCode...):

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

## 4. Bề mặt giao diện

### Giao diện trên VS Code
- **Activity Bar Panel**: Xem danh sách tất cả các file có thay đổi chờ duyệt, nhóm theo workspace.
- **Review Tab**: Màn hình diff toàn diện so sánh trực quan giữa baseline và đề xuất mới.
- **Inline Staged Review**: CodeLens và gutter decorations hiển thị trực tiếp trên editor các nút **Accept** và **Reject** cho từng hunk.

### Giao diện trên JetBrains IDEs
- **Review Hub ToolWindow**: Panel bên phải hiển thị cây thay đổi kèm thống kê số hunk.
- **Native Diff Viewer**: Tận dụng trình xem diff mạnh mẽ của JetBrains với đầy đủ highlight cú pháp.
- **In-Editor Inlays**: Hiển thị khối thay đổi trực tiếp ngay trên editor tab đang mở.

---

## 5. MCP Tools & Resources

Package **`review-hub-mcp`** cung cấp đầy đủ các công cụ chuẩn cho Agent:

Các proposal được ghi xuống đĩa ngay để build/test chạy trên code mới. Hub giữ bản gốc
để so sánh: **Accept** giữ code mới, **Reject** khôi phục code cũ theo từng hunk.
Các hunk chưa duyệt vẫn giữ code mới trên đĩa.

- `propose_edit`: Đề xuất sửa một đoạn trong file (tự động thích ứng EOL CRLF/LF, giữ trong hàng đợi review).
- `propose_write`: Đề xuất tạo mới hoặc thay thế toàn bộ file (chờ review).
- `propose_delete`: Đề xuất xóa file (chờ review).
- `read_file`: Đọc nội dung file xuyên qua trạng thái staged (hỗ trợ phân trang dòng `start_line`/`end_line` và `line_numbers`).
- `list_changes`: Liệt kê các file đang chờ review và số lượng hunk.
- `get_change`: Xem chi tiết các hunk và unified diff của một file cụ thể.
- `accept`: Chấp thuận và giữ code mới của các hunk hoặc toàn bộ file trên đĩa.
- `reject`: Từ chối và khôi phục về trạng thái ban đầu.
- `set_checkpoint`: Đánh dấu trạng thái hiện tại trên đĩa làm baseline mới.
- `get_checkpoint` & `clear_checkpoint`: Kiểm tra hoặc làm sạch baseline hiện tại.
- `list_workspaces`: Liệt kê các thư mục workspace đang được quản lý.

---

## 6. Cấu trúc mã nguồn Monorepo

Repository được tổ chức theo kiến trúc monorepo phân tầng module sạch sẽ:

```
hub-preview/
├── core/                  # Core Hub engine & Hub REST server độc lập (@review-hub/core)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/               # SQLite store, hunk-diff, git-baseline, hub-server
├── vscode/                # VS Code Extension độc lập (review-hub-vscode)
│   ├── package.json       # Manifest commands, menus, contributes
│   ├── resources/         # Icons & Webview HTML/CSS/JS (panel, review-tab)
│   └── src/               # Extension lifecycle, UI decorators, CodeLens, Watcher
├── mcp/                   # Standalone MCP Server (review-hub-mcp)
│   ├── package.json
│   └── mcp-server.ts      # MCP stdio protocol implementation
├── jetbrains/             # JetBrains Plugin độc lập (Kotlin Gradle)
│   ├── build.gradle.kts
│   └── src/
├── test/                  # Test suite chạy trên Node test runner
├── esbuild.js             # Script build hợp nhất cho tất cả module JS
└── package.json           # Root monorepo orchestrator
```

---

## 7. Hướng dẫn phát triển (Development & Build)

### Tự thêm MCP cho agent trong VS Code

Mở **Settings → Extensions → Review Hub** và bật **Auto Register MCP**. Extension tự phát hiện Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness và Oh My Pi qua cấu hình, chương trình trong PATH hoặc extension đã cài. Các checkbox **Agents** cho phép bỏ chọn từng agent.

Extension quét khi khởi động, mỗi phút và khi danh sách extension thay đổi. Có thể chạy **Review Hub: Scan and Register Detected Agents** để quét ngay và xem kết quả trong **Output → Review Hub**. Sau khi được thêm, reconnect MCP trong agent để nạp cấu hình; Review Hub không tự tắt hoặc khởi động lại agent.

Cấu hình chỉ được thêm khi chưa có mục `review-hub`; các server MCP khác, comment và tùy chỉnh hiện có được giữ nguyên. Trước khi sửa file đã tồn tại, extension lưu bản sao `<tên-file>.review-hub.bak`. File sai định dạng được giữ nguyên và báo lỗi riêng, không cản việc thiết lập các agent khác. Bỏ tích setting dừng tự đăng ký và giữ cấu hình đã thêm.

Trong WSL/SSH/Dev Container, extension chỉ quét và cấu hình agent trên **host đang chạy extension**, để agent kết nối đúng Review Hub. Cấu hình Cline/Roo theo VS Code profile đang mở.

DeepSeek Harness (`dsh`) dùng `$DSH_HOME/cordis.patch.yml` (mặc định `~/.dsh/cordis.patch.yml`), thêm plugin MCP theo định dạng Cordis YAML. Oh My Pi (`omp`) dùng `~/.omp/agent/mcp.json`, tôn trọng `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR` và profile `OMP_PROFILE`/`PI_PROFILE` trong môi trường extension host. Đóng/mở lại phiên agent hoặc reload cấu hình MCP để nhận server mới.

## Cài đặt dependencies:
```bash
npm install
```

### Build toàn bộ hệ thống:
```bash
npm run build
```
Lệnh này sẽ đồng thời biên dịch:
- `core/dist/hub-server.cjs` (Hub REST server)
- `vscode/dist/extension.js` (VS Code extension bundle)
- `dist/mcp-server.cjs` (Review Hub MCP bundle)

### Kiểm tra kiểu dữ liệu (Typecheck):
```bash
npm run typecheck
```

### Chạy Unit & Integration Tests:
```bash
npm test
```
Toàn bộ 243+ unit và integration tests chạy thông qua runner `scripts/test.mjs`.

### Đóng gói VS Code VSIX:
```bash
npm run package:vscode
# Hoặc cd vscode && npm run package
```

### Đóng gói JetBrains Plugin:
```bash
cd jetbrains && ./gradlew buildPlugin
```

---

## 8. Cơ chế lưu trữ & Snapshot

- **SQLite Store (`hub.db`)**: Lưu trữ trong `~/.review-hub/hub.db` với chế độ WAL (Write-Ahead Logging) bảo đảm an toàn dữ liệu và tốc độ cao. Tự động fallback sang JSON store nếu môi trường không có SQLite.
- **Git Baseline**: Tự động so sánh với git HEAD hoặc snapshot gần nhất để tính toán các khối sửa đổi chính xác.
- **Safe Ignores**: Các file nhị phân lớn, datasets, models, caches, thư mục node_modules luôn được bỏ qua để tối ưu hiệu năng.

---

## 9. Xử lý sự cố (Troubleshooting)

- **Agent không thấy tools của Review Hub:**
  Kiểm tra xem `npx -y review-hub-mcp` đã được cấu hình trong settings của AI tool chưa. Thử chạy `npx -y review-hub-mcp` trên terminal để kiểm tra kết nối.
- **Diff không hiển thị trên IDE:**
  Bảo đảm project bạn đang mở trùng khớp với workspace mà AI Agent đang thao tác. Bấm `Review Hub: Show Changes` để làm mới danh sách.
- **Làm sạch phiên làm việc cũ:**
  Chạy lệnh `Review Hub: Clear Checkpoint` hoặc xóa file `~/.review-hub/hub.json`.

## Tải bản phát hành và publish

Tải VSIX công khai tại [GitHub Releases](https://github.com/TongDuyDat/hub-preview/releases/latest). Xem [PUBLISHING.md](PUBLISHING.md) để đăng ký/publish npm, tạo GitHub Release và cấu hình GitHub Pages.

### Require human review

Enable **Auto Register MCP**, select your agent, then enable **Require Review** and run
**Review Hub: Scan and Register Detected Agents**. The first supported adapters are
Claude Code and OMP on Linux/macOS. Start a new agent session; existing sessions are
not restarted. Check the Review Hub output for `required review: installed`.
Other agents can connect to MCP but report `unsupported` for enforcement.

The hooks allow Hub proposals and staged reads, and block native file writes,
shell/Python/eval, delegated execution, unrecognized tools, other MCP servers, and
agent Accept/Reject/checkpoint actions. OMP can invoke allowed Hub tools through their
exact `xd://mcp__review_hub_<tool>` devices. Source reads use Hub `read_file`.
When Hub is down the agent cannot fall back to direct edits. You accept/reject in Hub.
Run builds/tests yourself in a terminal; arbitrary shell is deliberately blocked.
Claude's hook requires `node` on PATH. These hooks govern model-issued tool calls;
they do not sandbox arbitrary plugins, host code, user commands or disabled hooks.

To remove the policy, turn **Require Review** off while Auto Register MCP and the
agent checkbox remain enabled, scan again, and start a new agent session. Existing
user hooks/settings are preserved and backed up. Disabling automatic registration
or uninstalling Review Hub does not remove hooks already installed.

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
