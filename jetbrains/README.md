# Review Hub for JetBrains IDEs

Plugin JetBrains cho **Review Hub** — Hỗ trợ xem trước và duyệt thay đổi của AI coding agents (Claude Code, Cline, Roo Code, opencode, dsh,...) theo từng khối (hunk-by-hunk) trước khi ghi xuống đĩa.

Tương thích: **IntelliJ IDEA (Community & Ultimate), PyCharm, WebStorm, CLion, GoLand, Android Studio, PhpStorm, Rider, RustRover,...** (Platform 2024.1+ / Build 241+).

---

## 1. Kiến trúc tổng quan

Plugin hoạt động theo mô hình **Hybrid Client**:

```
[Claude Code / Cline / Roo]
            │ stdio
            ▼
    [MCP Server] ──────────────┐
                               │ HTTP REST (127.0.0.1:<random_port>)
                               ▼
                    [Review Hub Server] (SQLite, Hunk Diff Engine)
                               ▲
                               │ HTTP REST (Bearer token tại ~/.review-hub/hub.json)
    [JetBrains Plugin] ────────┘
      ├── ToolWindow: Danh sách file đã đổi, số lượng hunk (+/-)
      ├── Native Diff: Tận dụng DiffManager của JetBrains
      └── Project View: Đổi màu file & hiển thị badge hunk
```

### Điểm mạnh trên JetBrains Platform
1. **Engine Diff vượt trội**: Tận dụng `DiffManager` và `DiffContentFactory` của IntelliJ để so sánh `Baseline (RAM)` và `Proposed (RAM)` mà không cần tạo file tạm trên đĩa.
2. **Dùng chung Hub**: Có thể chạy đồng thời với VS Code extension hoặc chạy độc lập. Khi VS Code không mở, JetBrains plugin sẽ tự kích hoạt `dist/hub-server.cjs`.

---

## 2. Hướng dẫn Mở và Build Plugin trong IntelliJ IDEA

1. Mở **IntelliJ IDEA**.
2. Chọn **File -> Open...** và trỏ đến thư mục `jetbrains/` trong repo này.
3. Chờ IntelliJ đồng bộ Gradle project.
4. Để chạy thử nghiệm plugin trong môi trường sandbox của IDE:
   - Mở cửa sổ **Gradle** ở sidebar bên phải:
   - Chọn `Tasks -> intellij -> runIde` (hoặc chạy lệnh: `./gradlew runIde`).
   - Một cửa sổ IDE con sẽ tự động khởi động kèm plugin Review Hub đã được cài sẵn.
5. Để đóng gói file `.zip` phân phối plugin:
   - Chạy task: `./gradlew buildPlugin`.
   - File kết quả nằm tại `jetbrains/build/distributions/review-hub-jetbrains-0.2.0.zip`.

---

## 3. Cấu trúc mã nguồn

- `src/main/kotlin/com/reviewhub/`
  - `model/Types.kt`: Định nghĩa dữ liệu DTO đồng bộ với `src/types.ts`.
  - `hub/HubClient.kt`: HTTP client giao tiếp REST API với Hub server.
  - `hub/HubManager.kt`: Quản lý kết nối, tự động phát hiện `~/.review-hub/hub.json` và spawn daemon khi cần.
  - `toolwindow/ReviewHubPanel.kt`: Giao diện sidebar danh sách file và thống kê hunks.
  - `toolwindow/ReviewHubToolWindowFactory.kt`: Đăng ký ToolWindow "Review Hub".
  - `diff/ReviewHubDiffViewer.kt`: Gọi trình xem Diff 2 bên của IntelliJ.
  - `status/ReviewHubFileStatusProvider.kt`: Đổi màu file có thay đổi chờ duyệt trên Project tree.
  - `status/ReviewHubNodeDecorator.kt`: Gắn badge `[X hunk(s)]` trên cây thư mục.
  - `actions/*`: Các action toolbar: Accept All, Reject All, Set/Clear Checkpoint, Refresh.
- `src/main/resources/META-INF/plugin.xml`: Khai báo plugin, actions và extension points.
