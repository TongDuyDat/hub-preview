# Review Hub

[English — bản gốc](README.md) | [Tiếng Việt](README.vi.md)

Review thay đổi code do AI tạo ngay trong VS Code, với code cũ màu đỏ, code mới màu xanh và nút Accept/Reject cho từng khối. Review Hub nhận đề xuất qua MCP, nhóm theo workspace, file và khối code, hiển thị đầy đủ đường dẫn tương đối trong dự án.

Đề xuất được **ghi xuống file ngay lập tức** để build và test sử dụng code mới. **Accept** giữ thay đổi; **Reject** khôi phục code trước đó của khối được chọn. Hub chỉ theo dõi đề xuất MCP; sửa trực tiếp trong editor, ghi bằng shell và diff Git không tự tạo review.

## Cài đặt và kết nối

Yêu cầu VS Code **1.103.0 trở lên**.

1. Tải file `.vsix` tại [GitHub Releases](https://github.com/TongDuyDat/hub-preview/releases).
2. Trong VS Code, chạy **Extensions: Install from VSIX...**, chọn file và reload cửa sổ đó nếu được yêu cầu. Hoặc chạy `code --install-extension /duong/dan/review-hub.vsix --force`, thay đường dẫn bằng file đã tải.
3. Mở dự án. Chạy **Review Hub: Scan and Register Detected Agents**, đồng ý bật đăng ký khi được hỏi; hoặc chọn **Enable and Scan** ở lần mở đầu tiên.
4. Trong Settings, bật **Review Hub: Auto Register MCP** và tích các agent cần dùng. Chỉ tích agent chưa bật đăng ký tự động. Cần thiết lập riêng trên mỗi máy hoặc môi trường remote.
5. Kết nối lại MCP hoặc mở phiên agent mới. Chạy **Review Hub: Install agent instructions** để thêm hướng dẫn cho dự án, rồi yêu cầu agent sửa code qua Review Hub.

VSIX đã kèm MCP server. Thiết lập MCP thông thường **không cần** cài gói npm hoặc Node.js riêng. Một số hook tùy chọn có yêu cầu bổ sung; xem [hướng dẫn cài đặt](docs/INSTALLATION.vi.md).

Hướng dẫn đăng lên Marketplace nằm bên dưới. README này không khẳng định extension đã được phát hành trên Marketplace.

## Quy trình review

- Mở **Review Hub → Changes**, mở rộng file rồi chọn khối để review trong editor.
- Accept/Reject từng khối, cả file hoặc toàn bộ thay đổi. Khối chưa quyết định vẫn được áp dụng trên đĩa.
- Auto Save lưu file thật. Khi mở file đang chờ review, lớp review được đưa lên; khi review xong, giao diện quay về file gốc.
- Agent nhận quyết định qua `get_review_updates` và kết quả những lần gọi tool tiếp theo. Agent phải đọc lại file bị ảnh hưởng trước khi đề xuất sửa tiếp sau quyết định. Thông báo không tự khởi chạy lượt xử lý mới của agent.

Tự đăng ký hỗ trợ **Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo Code, Gemini CLI, Antigravity, DeepSeek Harness và Oh My Pi**. Cấu hình MCP tùy chỉnh sẵn có được giữ lại và báo trạng thái thay vì ghi đè.

Hướng dẫn giúp agent dùng tool của Hub. Tùy chọn **Require Review** dùng hook để buộc đi qua Hub cho **Claude Code và Oh My Pi trên Linux/macOS**; chưa hỗ trợ mọi client và không phải sandbox của hệ điều hành.

## Tài liệu

| Nội dung | English | Tiếng Việt |
| --- | --- | --- |
| Cài đặt, kết nối agent, xử lý lỗi | [Installation](docs/INSTALLATION.md) | [Cài đặt](docs/INSTALLATION.vi.md) |
| Extension VS Code | [Extension README](vscode/README.md) | [README extension](vscode/README.vi.md) |
| Phát hành Marketplace, GitHub Releases và npm | [Publishing](PUBLISHING.md) | [Phát hành](PUBLISHING.vi.md) |
| MCP server và các tool | [MCP README](mcp/README.md) | [Thiết lập MCP](docs/INSTALLATION.vi.md) |

Xem lịch sử tại [CHANGELOG.md](CHANGELOG.md) và tải bản phát hành trên [website](https://tongduydat.github.io/hub-preview/). Repository còn có plugin JetBrains; phiên bản và tính năng của plugin được phát hành riêng với extension VS Code.

## Phát triển

Yêu cầu **Node.js 22.13 trở lên** và npm. Chạy tại thư mục gốc repository:

```sh
npm ci
npm run typecheck
npm test
npm run package:vscode
```

VSIX được tạo trong `vscode/`. Monorepo gồm engine dùng chung (`core/`), MCP server (`mcp/`), extension VS Code (`vscode/`), plugin JetBrains (`jetbrains/`) và website tĩnh (`docs/`).

Review Hub lưu dữ liệu review cục bộ. Dữ liệu gửi đến nhà cung cấp mô hình phụ thuộc cấu hình riêng của agent AI. Dự án dùng giấy phép MIT: [LICENSE](LICENSE).
