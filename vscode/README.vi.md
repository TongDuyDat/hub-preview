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

## Agent được hỗ trợ

Tự đăng ký hỗ trợ Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness và Oh My Pi. Cấu hình MCP tùy chỉnh sẵn có được giữ lại và báo trạng thái.

Hướng dẫn giúp agent dùng Hub. **Require Review** tùy chọn dùng hook cưỡng chế cho **Claude Code và Oh My Pi trên Linux/macOS**. Chưa hỗ trợ mọi client và không phải sandbox hệ điều hành. Trong chế độ này, người dùng chạy build/test trong terminal.

## Lệnh thường dùng

- **Review Hub: Show Changes** — mở các review đang chờ.
- **Review Hub: Scan and Register Detected Agents** — cấu hình agent được phát hiện và được chọn.
- **Review Hub: Copy MCP Config for AI Tools** — chuẩn bị runtime và chép cấu hình thủ công.
- **Review Hub: Install agent instructions** — thêm hướng dẫn cho dự án.
- **Review Hub: Show Hub Info** — xem thông tin Hub để xử lý lỗi.

[Cài đặt và xử lý lỗi](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.vi.md) · [English guide](https://github.com/TongDuyDat/hub-preview/blob/main/docs/INSTALLATION.md) · [Bản phát hành](https://github.com/TongDuyDat/hub-preview/releases) · [Báo lỗi](https://github.com/TongDuyDat/hub-preview/issues)

Dữ liệu review được lưu cục bộ; cấu hình agent quyết định dữ liệu gửi đến nhà cung cấp mô hình. Giấy phép MIT.
