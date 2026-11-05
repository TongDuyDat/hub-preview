# Review Hub

[English — bản gốc](https://github.com/TongDuyDat/hub-preview/blob/main/vscode/README.md) | [Tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/vscode/README.vi.md)

Review thay đổi code do AI tạo ngay trong VS Code: code cũ màu đỏ, code mới màu xanh và **Accept / Reject từng khối**. Duyệt đề xuất theo workspace và file, với đầy đủ đường dẫn tương đối trong dự án.

## Cách hoạt động

Agent gửi đề xuất qua MCP của Review Hub. Code mới được **ghi xuống file ngay** để build và test sử dụng. Accept giữ code mới; Reject khôi phục code cũ của khối được chọn. Auto Save tiếp tục lưu file thật.

Mở file đang chờ duyệt sẽ đưa phần review lên. Khi review xong, giao diện quay về file gốc. Agent có thể đọc quyết định Accept/Reject và đọc lại code bị ảnh hưởng trước khi sửa tiếp.

Hub chỉ nhận đề xuất MCP. Các thao tác Edit/Write/Bash trực tiếp của agent và diff Git không tự tạo review.

## Bắt đầu

Yêu cầu VS Code **1.103.0 trở lên**.

1. Cài extension. Với file VSIX đã tải, chạy **Extensions: Install from VSIX...**, rồi reload cửa sổ đó nếu được yêu cầu.
2. Mở dự án, chạy **Review Hub: Scan and Register Detected Agents** và bật đăng ký khi được hỏi.
3. Trong Settings, bật **Review Hub: Auto Register MCP** và tích agent cần cấu hình. Chỉ tích agent là chưa đủ. Thiết lập lại trên mỗi máy hoặc môi trường remote.
4. Kết nối lại MCP hoặc mở phiên agent mới, sau đó chạy **Review Hub: Install agent instructions**.
5. Yêu cầu agent sửa qua Hub, mở **Review Hub → Changes** để duyệt từng khối.

Extension đã kèm MCP server; thiết lập thông thường **không cần cài npm hoặc Node.js riêng**. Hook Claude tùy chọn cần Node.js trên PATH.

[Set up MCP for each agent](https://github.com/TongDuyDat/hub-preview/blob/main/docs/MCP_SETUP.md) · [Setup MCP từng agent — tiếng Việt](https://github.com/TongDuyDat/hub-preview/blob/main/docs/MCP_SETUP.vi.md)

## Agent được hỗ trợ

Tự đăng ký hỗ trợ Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness và Oh My Pi. Cấu hình MCP tùy chỉnh sẵn có được giữ lại và báo trạng thái.

Hướng dẫn giúp agent dùng Hub. **Require Review** tùy chọn dùng hook cưỡng chế cho **Claude Code và Oh My Pi trên Linux/macOS**. Chưa hỗ trợ mọi client và không phải sandbox hệ điều hành. Trong chế độ này, người dùng chạy build/test trong terminal.

## Cấu hình MCP thủ công

Với server đi kèm, chạy **Review Hub: Copy MCP Config for AI Tools** trên cùng máy với agent. Chép đủ `command`, `args` và `env` nếu có vào cấu hình MCP của client. Giữ `ELECTRON_RUN_AS_NODE` nếu được cung cấp. Nên dùng Scan để tự chuyển đổi định dạng.

| Agent | Cấu hình mà tự đăng ký sử dụng |
| --- | --- |
| Claude Code | `~/.claude.json` (`mcpServers`) |
| Codex | `~/.codex/config.toml` (`mcp_servers`) |
| Cursor | `~/.cursor/mcp.json` (`mcpServers`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` (`mcpServers`) |
| OpenCode | `~/.config/opencode/opencode.json` hoặc `.jsonc` sẵn có (`mcp`) |
| Cline | `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` của profile đang dùng |
| Roo Code | `globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` của profile đang dùng |
| Gemini CLI | `~/.gemini/settings.json` (`mcpServers`) |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` (`mcpServers`) |
| DeepSeek Harness | `~/.dsh/cordis.patch.yml` (danh sách patch YAML Cordis) |
| Oh My Pi | `~/.omp/agent/mcp.json` (`mcpServers`; hỗ trợ profile khác) |

Đường dẫn thuộc home của người dùng chạy extension host và profile hiện tại. Biến môi trường có thể thay đổi vị trí; xem đúng đường dẫn Scan báo. Gộp mục mới vào thiết lập sẵn có, không thay toàn bộ file.

Dưới đây là mẫu **npm độc lập, tùy chọn** cho client JSON. Cách này yêu cầu Node.js **22.13+**, npm/npx trên PATH của agent và Hub đang chạy cùng môi trường. Thiết lập bằng server đi kèm không cần bước này.

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

Codex dùng TOML, OpenCode dùng mảng command, DeepSeek Harness dùng YAML. Xem [hướng dẫn từng agent](https://github.com/TongDuyDat/hub-preview/blob/main/docs/MCP_SETUP.vi.md) để lấy mẫu chính xác, cách chạy trên Windows và xử lý profile.

Sau khi cấu hình, kết nối lại agent, cài hướng dẫn Hub rồi yêu cầu tạo một file thử nhỏ **bằng tool đề xuất của Hub**. Kết quả `staged_for_review` và mục mới tại **Review Hub → Changes** xác nhận luồng review hoạt động. Connected chưa đảm bảo agent dùng Hub thay cho Edit/Write/Bash trực tiếp.

## Lệnh thường dùng

- **Review Hub: Show Changes** — mở các review đang chờ.
- **Review Hub: Scan and Register Detected Agents** — cấu hình agent được phát hiện và được chọn.
- **Review Hub: Copy MCP Config for AI Tools** — chuẩn bị runtime và chép cấu hình thủ công.
- **Review Hub: Install agent instructions** — thêm hướng dẫn cho dự án.
- **Review Hub: Show Hub Info** — xem thông tin Hub để xử lý lỗi.

[Cài đặt và xử lý lỗi](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.vi.md) · [English guide](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.md) · [Bản phát hành](https://github.com/TongDuyDat/hub-preview/releases) · [Báo lỗi](https://github.com/TongDuyDat/hub-preview/issues)

Dữ liệu review được lưu cục bộ; cấu hình agent quyết định dữ liệu gửi đến nhà cung cấp mô hình. Giấy phép MIT.
