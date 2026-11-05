# Cài đặt và kết nối agent

[English — bản gốc](INSTALLATION.md) | [Tiếng Việt](INSTALLATION.vi.md) · [README dự án](../README.vi.md)

## Cài extension VS Code

Yêu cầu VS Code 1.103.0 trở lên. Tải VSIX tại [GitHub Releases](https://github.com/TongDuyDat/hub-preview/releases), mở Command Palette và chạy **Extensions: Install from VSIX...**. Chọn file vừa tải rồi reload cửa sổ đó khi được yêu cầu.

Nếu dùng CLI, thay đường dẫn ví dụ bằng file VSIX thực tế:

```sh
code --install-extension /duong/dan/review-hub.vsix --force
```

Với SSH, WSL hoặc container, cài/bật Review Hub trong môi trường chứa workspace và chạy agent. Quét agent và ghi cấu hình sử dụng môi trường của extension host hiện tại. Không cần đóng cửa sổ IDE khác hoặc dừng tiến trình đang chạy.

## Kết nối agent

1. Mở dự án và chạy **Review Hub: Scan and Register Detected Agents**. Bật đăng ký khi được hỏi; hoặc chọn **Enable and Scan** ở lần mở đầu tiên.
2. Trong Settings, bật **Review Hub: Auto Register MCP** và tích các mục **Review Hub: Agents** cần dùng. Auto Register MCP mặc định tắt, phải bật riêng trên mỗi máy; chỉ tích agent là chưa đủ.
3. Kiểm tra kết quả quét. Chỉ agent được phát hiện và được chọn mới được cấu hình. Các adapter hỗ trợ: Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness và Oh My Pi.
4. Kết nối lại MCP hoặc mở phiên agent mới sau khi thiết lập và sau mỗi lần cập nhật extension.
5. Chạy **Review Hub: Install agent instructions** để thêm khối hướng dẫn được quản lý vào dự án. Có thể dùng **Copy AI Agent Rules to Clipboard** để thiết lập thủ công. Khi bật tự đăng ký, Claude còn có thể được thêm hướng dẫn vào CLAUDE.md cấp người dùng; xem **Review Hub: Claude: Install Instructions**.

Extension triển khai MCP server đi kèm vào bộ nhớ profile và chạy bằng executable của extension host. Thiết lập thông thường không cần npm hoặc cài Node.js riêng. **Copy MCP Config for AI Tools** chuẩn bị runtime này và chép JSON để cấu hình thủ công; nên dùng Scan cho định dạng riêng của từng client. Không sao chép đường dẫn runtime tuyệt đối từ máy khác.

Quá trình quét giữ các thiết lập và MCP server không liên quan, sao lưu cấu hình được sửa thành `.review-hub.bak`; các mục tùy chỉnh, bị tắt hoặc remote được giữ nguyên kèm cảnh báo. Launcher npm/cục bộ cũ do Hub tạo và nhận diện được sẽ chuyển sang runtime đi kèm. Bỏ tích agent hoặc tắt tự đăng ký vẫn giữ cấu hình đã thêm.

## Kiểm tra review

Yêu cầu agent tạo một file thử nhỏ **bằng tool đề xuất của Review Hub**: `propose_write`, `propose_edit` hoặc `propose_changes`. Kết quả `staged_for_review` là thành công: code đã có trên đĩa và đang chờ người dùng duyệt.

Mở **Review Hub → Changes**, xem code đỏ/xanh và Accept/Reject từng khối. Accept giữ code mới; Reject khôi phục code cũ của khối đó. Khối chưa quyết định vẫn được áp dụng. Gọi Edit/Write/Bash trực tiếp hoặc diff Git không tự xuất hiện trong Hub.

Agent nhận quyết định qua `get_review_updates` và kết quả những lần gọi tool tiếp theo. Sau quyết định, agent phải đọc lại toàn bộ file bị ảnh hưởng trước khi đề xuất sửa tiếp. Thông báo không tự chạy agent.

## Tùy chọn: buộc review bằng hook

**Review Hub: Require Review** hỗ trợ **Claude Code và Oh My Pi trên Linux/macOS**. Bật Auto Register MCP, tích agent, bật Require Review rồi quét lại và mở phiên agent mới. Hook của Claude yêu cầu Node.js có trong PATH.

Hook chặn sửa trực tiếp, shell/Python/eval tùy ý, giao việc cho agent khác, MCP khác và các lệnh agent tự Accept/Reject hoặc thay checkpoint. Khi dùng chế độ này, người dùng chạy build/test trong terminal. Client khác có thể dùng hướng dẫn nhưng chưa có cơ chế cưỡng chế tương đương. Hook chỉ bảo vệ khi được nạp, không phải sandbox của hệ điều hành.

Để gỡ chính sách được quản lý, tắt Require Review trong khi vẫn bật Auto Register MCP và vẫn tích agent; quét lại rồi mở phiên mới. Chỉ tắt tự đăng ký hoặc gỡ extension sẽ giữ hook đã cài.

## Xử lý lỗi

| Hiện tượng | Cách kiểm tra |
| --- | --- |
| Connected nhưng không có thay đổi | Kiểm tra agent có gọi tool đề xuất của Hub hay dùng Edit/Write/Bash trực tiếp. Cài hướng dẫn; dùng hook được hỗ trợ nếu cần cưỡng chế. |
| Đã tích Claude nhưng chưa được thêm MCP | Bật Auto Register MCP, quét, xem kết quả và kết nối lại Claude. |
| Thiếu `propose_delete` | Khám phá/nạp lại danh sách tool. Nếu có `propose_changes`, dùng `{ "changes": [{ "path": "file.py", "delete": true }] }`. Không ghi file rỗng để giả lập xóa. |
| Claude không thấy tool | Dùng ToolSearch của Claude để tìm tool Review Hub; tiền tố có thể khác. Thiếu tool không có nghĩa Hub mất kết nối. |
| Oh My Pi hiển thị `xd://` | Đọc schema tool/device, tìm device Hub và gọi đúng device theo JSON mà schema quy định. |
| Tool vẫn cũ sau cập nhật | Quét để cập nhật runtime, kết nối lại agent và mở **Review Hub: Show Hub Info**. Nếu Hub cũ được cửa sổ VS Code khác chạy, chỉ reload cửa sổ đang host Hub đó. |
| Hub không khả dụng | Mở workspace với Review Hub được bật, dùng Show Hub Info. Kiểm tra IDE và agent cùng máy/môi trường, rồi kết nối lại khi Hub chạy. |
| Cấu hình MCP tùy chỉnh không được chuyển | Đọc cảnh báo quét. Sao lưu cấu hình rồi cập nhật thủ công bằng Copy MCP Config hoặc phần MCP Settings của client. |

## MCP qua npm độc lập (tùy chọn)

Server npm dành cho tích hợp thủ công và yêu cầu **Node.js 22.13 trở lên**. Vẫn cần Review Hub đang chạy cùng môi trường. Thêm stdio server theo định dạng client; ví dụ JSON:

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

Bản npm có thể chậm hơn code trong repository. Nên dùng runtime đi kèm extension để đồng bộ tool và hành vi. Xem [tài liệu MCP](../mcp/README.md).
