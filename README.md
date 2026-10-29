# Review Hub (VS Code & JetBrains IDEs)

Xem **chính xác** AI coding agent đã đổi gì trong project của bạn — **bất kể agent chạy ở chế độ quyền nào** — và duyệt/từ chối **từng khối (hunk) một**, kiểu hunkwise.

Hỗ trợ đồng thời cả **Visual Studio Code** và **JetBrains IDEs** (IntelliJ IDEA, WebStorm, PyCharm, CLion, GoLand, Android Studio, PhpStorm, Rider, RustRover...).

Tương thích với các AI Agent phổ biến: **Claude Code, opencode, dsh (deepseek-harness), Cline, Roo Code** qua giao thức MCP, và vẫn bắt được cả những agent không dùng MCP mà ghi thẳng vào file.

> **Điểm cốt lõi:** Review Hub **không ghi gì lên đĩa khi agent đề xuất thay đổi** (Review-then-Apply qua MCP). Thay đổi được giữ lại trong bộ nhớ đệm kèm diff, và **chỉ những hunk bạn bấm ✓ mới thực sự được ghi xuống đĩa**. Đối với các lệnh ghi đè trực tiếp (Direct Writes), hệ thống tự động bắt thay đổi và cho phép hoàn tác (Undo/Revert) từng khối về bản gốc (baseline).

---

## Mục lục

1. [Kiến trúc tổng quan](#1-kiến-trúc-tổng-quan)
2. [Vấn đề giải quyết](#2-vấn-đề-giải-quyết)
3. [Cài đặt & Khởi động](#3-cài-đặt--khởi-động)
   - [3.1. Dành cho VS Code](#31-dành-cho-vs-code)
   - [3.2. Dành cho JetBrains IDEs](#32-dành-cho-jetbrains-ides)
4. [Bề mặt giao diện](#4-bề-mặt-giao-diện)
   - [Giao diện trên VS Code](#giao-diện-trên-vs-code)
   - [Giao diện trên JetBrains IDEs](#giao-diện-trên-jetbrains-ides)
5. [MCP Tools cho AI Agent](#5-mcp-tools-cho-ai-agent)
6. [Cấu trúc mã nguồn Repository](#6-cấu-trúc-mã-nguồn-repository)
7. [Hướng dẫn phát triển (Development & Build)](#7-hướng-dẫn-phát-triển-development--build)
8. [Cơ chế lưu trữ & Snapshot](#8-cơ-chế-lưu-trữ--snapshot)
9. [Xử lý sự cố (Troubleshooting)](#9-xử-lý-sự-cố-troubleshooting)

---

## 1. Kiến trúc tổng quan

Review Hub hoạt động theo mô hình **Shared Hub Architecture** (kiến trúc tập trung):

```text
[Claude Code / Cline / Roo / opencode / dsh]
                │
                │ stdio (MCP Protocol)
                ▼
        [MCP Server (mcp-server.cjs)]
                │
                │ HTTP REST (127.0.0.1:<random_port>)
                ▼
    ┌───────────────────────────┐
    │     Review Hub Server     │  Discovery: ~/.review-hub/hub.json
    │   (SQLite Store Engine)   │  Database: ~/.review-hub/hub.db
    └─────────────┬─────────────┘
                  ▲
      ┌───────────┴───────────┐
      │                       │
[VS Code Extension]     [JetBrains Plugin]
  ├── Sidebar Webview     ├── ToolWindow Panel
  ├── Inline Diff View    ├── Native Diff Viewer
  └── Explorer Badges     └── Project Tree Badges
```

- **Hub Server**: Đóng vai trò là single source of truth, quản lý database SQLite, tính toán hunk diff và lưu trữ baseline. Hub có thể được host bởi VS Code extension hoặc chạy daemon độc lập.
- **MCP Server (`mcp-server.cjs`)**: Process mỏng kết nối qua stdio với các AI harness, chuyển tiếp các lệnh đề xuất sửa file (`propose_edit`, `propose_write`, `propose_delete`) về Hub Server.
- **IDE Clients (VS Code & JetBrains)**: Kết nối tới Hub Server qua REST API (xác thực bằng Bearer token được tạo ngẫu nhiên lưu tại `~/.review-hub/hub.json`). Cả 2 IDE có thể mở cùng lúc và dùng chung một phiên review.

---

## 2. Vấn đề giải quyết

Khi agent chạy ở chế độ tự động duyệt (Claude Code `acceptEdits`, Cline auto-approve, dsh, opencode), nó ghi thẳng xuống đĩa và **không cho bạn thấy gì cả**. Còn khi nó có hiện diff thì diff đó biến mất ngay sau khi bạn accept — không có danh sách "từ lần trước tới giờ đã đổi những gì".

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

Yêu cầu: **VS Code 1.103.0 trở lên** (Node 22 runtime tích hợp).

- **Cài đặt từ file VSIX:**
  ```bash
  code --install-extension review-hub-vscode-0.2.0.vsix
  ```
- **Tự động cấu hình MCP cho các AI Harness:**
  Mở Command Palette (`Ctrl+Shift+P`) → Chạy `Review Hub: Register MCP in all harnesses`. Lệnh này sẽ tự động thêm cấu hình Review Hub vào Claude Code, Cline, Roo Code, opencode,...
- **Hướng dẫn cho Agent:**
  Chạy lệnh `Review Hub: Install agent instructions` để extension tự chèn hướng dẫn sử dụng MCP tool vào `CLAUDE.md`, `.cursorrules`,...

### 3.2. Dành cho JetBrains IDEs

Tương thích: **IntelliJ IDEA (Community & Ultimate), PyCharm, WebStorm, CLion, GoLand, Android Studio, PhpStorm, Rider, RustRover,...** (Platform 2024.1+ / Build 241+).

- **Cài đặt từ file ZIP:**
  1. Vào menu **Settings/Preferences** (`Ctrl+Alt+S`) → **Plugins**.
  2. Bấm biểu tượng ⚙️ (bánh răng) → Chọn **Install Plugin from Disk...**.
  3. Chọn file `review-hub-jetbrains-0.2.0.zip` (hoặc build từ `jetbrains/build/distributions/`).
  4. Khởi động lại IDE khi được yêu cầu.
- **Tự khởi động Hub:**
  Khi mở JetBrains IDE mà không mở VS Code, plugin sẽ tự động phát hiện và khởi chạy `hub-server.cjs` dưới nền.

---

## 4. Bề mặt giao diện

### Giao diện trên VS Code

1. **Sidebar Panel** (biểu tượng Review Hub trên Activity Bar):
   - Danh sách các file thay đổi gom nhóm theo workspace, kèm thống kê `+thêm −bớt`.
   - Nút **Accept All**, **Discard All**, **Set Checkpoint**.
   - Cây thư mục mở rộng xem chi tiết từng hunk `@line N` kèm nút thao tác trực tiếp.
2. **Review Tab (Webview Diff)**:
   - Hiển thị diff 2 màu trực quan: Dòng xóa nền đỏ, dòng thêm nền xanh.
   - Thanh HunkBar riêng cho từng khối: Badge trạng thái tĩnh `✓ accepted` / `✗ rejected` và nút `↺ Undo`.
   - Hỗ trợ cuộn mượt và highlight khối khi click từ Sidebar.
3. **In-Editor Inline Highlighting & CodeLens**:
   - Highlight trực tiếp trên file thật đang mở trong editor.
   - Hiển thị nút CodeLens `✓ Accept` / `✗ Reject` ngay trên đầu từng hunk.
   - Badge `M` / `A` / `D` trên File Explorer với cơ chế lan truyền dấu chấm lên thư mục cha.

### Giao diện trên JetBrains IDEs

1. **ToolWindow "Review Hub"** (sidebar góc phải/dưới):
   - Danh sách file đang chờ review kèm số lượng hunk và thống kê dòng.
   - Toolbar với các nút thao tác nhanh: Accept All, Reject All, Set Checkpoint, Refresh.
2. **Native Diff Viewer**:
   - Tận dụng trình xem Diff gốc mạnh mẽ (`DiffManager`) của JetBrains.
   - So sánh trực tiếp từ bộ nhớ RAM (`Baseline RAM` vs `Proposed RAM`), không cần tạo file tạm trên đĩa.
3. **Project View Decoration**:
   - Tự động đổi màu tên file đang có thay đổi cần duyệt trên Project Tree.
   - Gắn badge `[X hunk(s)]` bên cạnh tên file.

---

## 5. Tích hợp MCP Server qua NPM (`review-hub-mcp`)

Review Hub MCP Server được đóng gói và phân phối chính thức qua NPM dưới tên package **`review-hub-mcp`**.

Người dùng không cần cài đặt thủ công vào ổ cứng. Chỉ cần cấu hình công cụ AI chạy trực tiếp qua `npx`:

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

### Cấu hình chi tiết theo từng công cụ:

- **Claude Code CLI** (thêm vào `~/.claude.json`):
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
- **Roo Code / Cline** (thêm vào `mcp_settings.json`):
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
- **opencode** (thêm vào `~/.config/opencode/opencode.jsonc`):
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
- **Cursor / Windsurf / Zed**: Thêm MCP Server loại stdio với lệnh `npx` và tham số `-y`, `review-hub-mcp`.

---

### Danh sách MCP Tools cho AI Agent

Khi tích hợp với AI harness qua MCP, agent sẽ có các tools sau:

| Tool | Mô tả | Tham số |
|---|---|---|
| `propose_edit` | Đề xuất sửa một đoạn trong file (thay thế công cụ `Edit` native) | `path`, `old_string`, `new_string`, `replace_all?` |
| `propose_write` | Đề xuất tạo mới hoặc ghi đè toàn bộ file | `path`, `content` |
| `propose_delete` | Đề xuất xóa file (chờ người dùng duyệt) | `path` |
| `read_file` | Đọc file qua Hub (trả về nội dung đang được staged) | `path` |
| `list_changes` | Liệt kê toàn bộ file và hunks đang chờ duyệt | `workspace?`, `path?` |
| `accept` | Chấp nhận toàn bộ hoặc một số hunk theo ID | `changeId?`, `path?`, `hunkIds?` |
| `reject` | Từ chối và khôi phục baseline cho các hunk | `changeId?`, `path?`, `hunkIds?` |
| `set_checkpoint` | Đánh dấu trạng thái hiện tại trên đĩa là bản gốc mới | `workspace?`, `path?` |

---

## 6. Cấu trúc mã nguồn Repository

```text
hub-preview/
├── src/                        # Mã nguồn VS Code Extension & Shared Logic
│   ├── core/                   # Logic lõi độc lập: Diff, SQLite, Snapshot, Types
│   │   ├── change-store.ts     # SQLite store & quản lý change sets
│   │   ├── hunk-diff.ts        # Thuật toán phân tích diff & hunk
│   │   ├── merged-diff.ts      # Ghép nội dung old + new
│   │   ├── sqlite.ts           # Wrapper giao tiếp SQLite
│   │   └── types.ts            # DTOs & Hub protocol
│   ├── server/                 # Hub HTTP Server & Process Registry
│   │   ├── hub-server.ts       # REST API endpoints cho MCP và IDE
│   │   ├── registry.ts         # Atomic lock & hub.json discovery
│   │   └── window-registry.ts  # Quản lý đa cửa sổ
│   ├── harness/                # Cấu hình tự động cho AI Agent (Claude, Cline, Roo...)
│   │   ├── harness-paths.ts    # Định vị file settings theo OS
│   │   └── harness-register.ts # Surgical JSONC/YAML insertion
│   ├── watcher/                # Giám sát file system & vòng đời
│   │   ├── workspace-watcher.ts# Bắt direct writes ngoài MCP
│   │   └── exit-flush.ts       # Dọn dẹp an toàn khi tắt IDE
│   ├── ui/                     # Giao diện hiển thị trên VS Code
│   │   ├── editor/             # Decorator, DiffView, CodeLens, Staged Review
│   │   └── webview/            # Review Panel & Review Tab Provider
│   └── extension.ts            # Entrypoint kích hoạt VS Code extension
│
├── jetbrains/                  # Mã nguồn JetBrains Plugin (Kotlin + Gradle)
│   ├── src/main/kotlin/com/reviewhub/
│   │   ├── actions/            # Toolbar actions (Accept, Reject, Checkpoint...)
│   │   ├── diff/               # Tích hợp Native DiffManager
│   │   ├── hub/                # HubClient & HubManager (REST API client)
│   │   ├── inline/             # Merged diff & Editor listeners
│   │   ├── model/              # Kotlin data classes tương thích types.ts
│   │   ├── status/             # Project tree badges & file coloring
│   │   └── toolwindow/         # Giao diện ToolWindow sidebar
│   ├── src/main/resources/     # plugin.xml & icons
│   ├── build.gradle.kts        # Cấu hình Gradle & IntelliJ Platform SDK
│   └── gradlew / gradlew.bat   # Gradle Wrapper chính thức của JetBrains plugin
│
├── mcp/                        # MCP Server stdio
│   └── mcp-server.ts           # Trình forwarder mỏng giữa Harness và Hub
├── media/                      # Webview assets cho VS Code (HTML, CSS, JS, SVG)
└── test/                       # Unit tests & Integration tests
```

---

## 7. Hướng dẫn phát triển (Development & Build)

### Phát triển VS Code Extension & MCP:
```bash
npm install             # Cài đặt dependencies
npm run build           # Bundle dist/extension.js, dist/mcp-server.cjs, dist/hub-server.cjs
npm run typecheck       # Kiểm tra kiểu TypeScript (tsc --noEmit)
npm test                # Chạy toàn bộ test suites
npm run package         # Đóng gói file .vsix
```

### Phát triển JetBrains Plugin:
```bash
cd jetbrains
./gradlew runIde        # Khởi chạy một IDE con thử nghiệm kèm plugin
./gradlew test          # Chạy Kotlin unit tests
./gradlew buildPlugin   # Đóng gói file .zip phân phối tại build/distributions/
```

---

## 8. Cơ chế lưu trữ & Snapshot

Review Hub lưu trữ trạng thái tại thư mục `~/.review-hub/`:
```text
~/.review-hub/
  hub.json                      # Thông tin URL, Port, Bearer Token của Hub đang chạy
  hub.lock                      # Lockfile nguyên tử đảm bảo 1 host election
  hub.db                        # SQLite database lưu trữ change sets và hunk decisions
  workspaces/<workspace-hash>/
    baselines/<hash>            # Nội dung gốc (baseline) lưu theo content-addressed hash
```

- **Chụp Lazy Snapshot**: Review Hub **không quét toàn bộ ổ đĩa khi mở dự án**. Baseline được lấy tức thì từ `git show HEAD:<path>` hoặc chụp lại nội dung file ngay trước thời điểm agent gọi `propose_edit`.
- **An toàn dữ liệu**: Thư mục datasets, checkpoints, models (`*.pt`, `*.bin`, thư mục cache, media...) luôn được tự động bỏ qua (ignored globs) để bảo đảm hiệu năng tối đa.

---

## 9. Xử lý sự cố (Troubleshooting)

| Triệu chứng | Nguyên nhân & Cách khắc phục |
|---|---|
| Panel báo "No changes to review" dù agent vừa sửa file | Agent chưa nạp MCP server → Khởi động lại session của harness; hoặc file chưa có checkpoint → Bấm **Set Checkpoint**. |
| Agent đọc file và thấy "nội dung cũ" | Đây là hành vi đúng của cơ chế Review-then-Apply (chưa duyệt thì chưa ghi xuống đĩa). Agent cần dùng công cụ `read_file` của Review Hub. |
| Agent thông báo `propose_edit` thất bại và thử lại | Trạng thái `status: "staged_for_review"` là **thành công**. Chạy lệnh **Install agent instructions** để cập nhật hướng dẫn cho agent. |
| JetBrains Plugin không kết nối được Hub | Kiểm tra file `~/.review-hub/hub.json`. Nếu không có Hub nào đang mở, plugin sẽ tự kích hoạt `hub-server.cjs` sau vài giây. |
| Muốn reset sạch toàn bộ trạng thái review | Chạy lệnh **Clear Checkpoint**, hoặc xóa thư mục `~/.review-hub/`. |
