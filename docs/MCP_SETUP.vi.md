# Setup MCP Review Hub cho các coding agent

[English — bản gốc](MCP_SETUP.md) | [Tiếng Việt](MCP_SETUP.vi.md) · [Cài đặt](INSTALLATION.vi.md)

## Cách khuyến nghị cho mọi agent được hỗ trợ

1. Cài Review Hub trong VS Code và mở dự án. Giữ Hub được bật khi sử dụng agent.
2. Mở Settings, bật **Review Hub: Auto Register MCP** rồi tích agent trong **Review Hub: Agents**. Chỉ tích agent chưa bật đăng ký tự động. Cần thiết lập riêng trên từng máy hoặc môi trường remote.
3. Chạy **Review Hub: Scan and Register Detected Agents**. Đọc đường dẫn cấu hình và kết quả quét. Nếu chưa phát hiện agent, cài/mở agent ít nhất một lần rồi quét lại.
4. Kết nối lại MCP hoặc mở phiên agent mới. Sau khi cập nhật extension, quét và kết nối lại.
5. Chạy **Review Hub: Install agent instructions** cho dự án, hoặc dùng **Review Hub: Copy AI Agent Rules to Clipboard** để thêm hướng dẫn thủ công vào file quy tắc agent hỗ trợ.
6. Yêu cầu agent dùng `list_workspaces`, `read_file` và các tool đề xuất của Hub. Xem thay đổi tại **Review Hub → Changes**.

Extension đã kèm MCP server và chuẩn bị runtime ổn định trong bộ nhớ profile. Thiết lập thông thường không cần cài npm hoặc Node.js riêng. IDE và agent phải cùng máy/môi trường; Windows, WSL, SSH và container có cấu hình riêng.

## Đường dẫn cấu hình

Đây là đường dẫn cấp người dùng mà các adapter của extension sử dụng. `~` là thư mục home của người dùng chạy extension host hiện tại. Biến môi trường, profile và cấu hình tùy chỉnh có thể làm đường dẫn khác đi; ưu tiên đường dẫn thực tế do Scan báo.

| Agent | File mặc định | Định dạng |
| --- | --- | --- |
| [Claude Code](#claude-code) | `~/.claude.json` | JSON, `mcpServers` |
| [Codex](#codex) | `~/.codex/config.toml` | TOML, `mcp_servers` |
| [Cursor](#cursor) | `~/.cursor/mcp.json` | JSON, `mcpServers` |
| [Windsurf](#windsurf) | `~/.codeium/windsurf/mcp_config.json` | JSON, `mcpServers` |
| [OpenCode](#opencode) | `~/.config/opencode/opencode.json` hoặc `opencode.jsonc` sẵn có | JSON/JSONC, `mcp` |
| [Cline](#cline) | `<globalStorage>/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | JSON, `mcpServers` |
| [Roo Code](#roo-code) | `<globalStorage>/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | JSON, `mcpServers` |
| [Gemini CLI](#gemini-cli) | `~/.gemini/settings.json` | JSON, `mcpServers` |
| [Antigravity](#antigravity) | `~/.gemini/antigravity/mcp_config.json` | JSON, `mcpServers` |
| [DeepSeek Harness](#deepseek-harness) | `~/.dsh/cordis.patch.yml` | Danh sách patch YAML |
| [Oh My Pi](#oh-my-pi) | `~/.omp/agent/mcp.json` | JSON, `mcpServers` |

`<globalStorage>` thuộc profile VS Code/môi trường remote đang dùng. Không lấy đường dẫn storage từ máy khác. Scan giữ MCP server không liên quan, sao lưu cấu hình được sửa và báo các mục tùy chỉnh/bị tắt mà nó giữ nguyên.

## Cấu hình thủ công

Nên dùng **Review Hub: Copy MCP Config for AI Tools** để lấy `command`, `args` và `env` nếu có của server đi kèm trên đúng máy hiện tại. Chép đủ các trường khởi chạy, gồm `ELECTRON_RUN_AS_NODE` nếu xuất hiện. Với OpenCode, ghép command và args thành mảng command, đổi `env` thành `environment`. Với Codex, chuyển sang TOML. Với DeepSeek Harness, dùng cấu trúc YAML bên dưới. Scan tự chuyển đổi các định dạng này.

Ví dụ bên dưới dùng **MCP server npm độc lập, tùy chọn** để có cấu hình cụ thể không phụ thuộc đường dẫn máy. Cần Node.js **22.13+**, npm/npx trên PATH của agent và gói `review-hub-mcp` đã phát hành có đủ tool cần dùng. Bản npm có thể chậm hơn runtime đi kèm extension. Vẫn cần Hub đang chạy. Gộp mục mới vào cấu hình sẵn có, không thay toàn bộ file hoặc các thiết lập không liên quan.

### Mẫu JSON thông dụng

Dùng cấu trúc này cho các client JSON bên dưới. Claude dùng thêm `type: "stdio"`; Cline/Roo có thể thêm `disabled: false`.

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

Nếu không chạy trực tiếp được `npx` trên Windows, dùng phần khởi chạy này ở client hỗ trợ command/args:

```json
{
  "command": "cmd",
  "args": ["/d", "/c", "npx", "-y", "review-hub-mcp"]
}
```

### Claude Code

Tích **Agents: Claude Code** rồi Scan. Adapter dùng `~/.claude.json`, hoặc `CLAUDE_CONFIG_DIR/.claude.json` nếu có biến này. Khi cấu hình JSON thủ công, gộp mẫu chung và thêm `"type": "stdio"` vào object `review-hub`. Mở phiên Claude mới, kiểm tra kết nối MCP; dùng ToolSearch để tìm tool Hub nếu tool chưa được nạp.

Khi bật **Claude: Install Instructions**, tự đăng ký còn thêm khối hướng dẫn vào `~/.claude/CLAUDE.md` hoặc `CLAUDE_CONFIG_DIR/CLAUDE.md`. File hướng dẫn này tách biệt với file cấu hình kết nối MCP. Hook Require Review tùy chọn hỗ trợ Claude trên Linux/macOS và cần Node.js trên PATH; xem [cài/gỡ hook](INSTALLATION.vi.md).

### Codex

Tích **Agents: Codex** rồi Scan. Adapter dùng `$CODEX_HOME/config.toml`, mặc định là `~/.codex/config.toml`. Nếu dùng npm thủ công, thêm bảng sau một lần:

```toml
[mcp_servers."review-hub"]
command = "npx"
args = ["-y", "review-hub-mcp"]
```

Nếu dùng runtime đi kèm, thay command/args bằng dữ liệu extension chép ra và giữ môi trường khởi chạy, chẳng hạn bằng inline table TOML `env`. Mở phiên Codex mới, kiểm tra tool Hub. Thêm hướng dẫn dự án vào `AGENTS.md`. Hiện chưa hỗ trợ hook Require Review cho Codex.

### Cursor

Tích **Agents: Cursor** rồi Scan, hoặc gộp mẫu JSON chung vào `~/.cursor/mcp.json`. Kết nối lại server trong phần MCP Settings của Cursor hoặc mở phiên agent mới. Thêm quy tắc Hub bằng cơ chế hướng dẫn dự án mà Cursor hỗ trợ và yêu cầu dùng tool đề xuất.

### Windsurf

Tích **Agents: Windsurf** rồi Scan, hoặc gộp mẫu JSON chung vào `~/.codeium/windsurf/mcp_config.json`. Refresh/kết nối lại MCP trong Windsurf, mở phiên mới và kiểm tra có `review-hub`.

### OpenCode

Tích **Agents: OpenCode** rồi Scan. Adapter hỗ trợ `OPENCODE_CONFIG` và `XDG_CONFIG_HOME`; mặc định dùng đường dẫn trong bảng, ưu tiên JSONC sẵn có. OpenCode dùng cấu trúc riêng:

```json
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

Với server đi kèm, dùng mảng `[copiedCommand, ...copiedArgs]`, đưa các biến môi trường được chép vào `environment`. Kết nối lại MCP hoặc mở phiên OpenCode mới.

### Cline

Cài/bật Cline trong cùng profile VS Code, tích **Agents: Cline** rồi Scan. Nếu làm thủ công, mở cấu hình MCP server của Cline, gộp mẫu JSON chung và thêm `"disabled": false` vào object `review-hub`. Đường dẫn adapter nằm trong bảng. Kết nối lại server rồi mở task mới với hướng dẫn Hub.

### Roo Code

Cài/bật Roo Code trong cùng profile, tích **Agents: Roo Code** rồi Scan. Nếu làm thủ công, mở cấu hình MCP của Roo, gộp mẫu JSON chung với `"disabled": false`. Kết nối lại rồi mở task mới với hướng dẫn Hub. Roo dùng đường dẫn storage khác Cline, không sửa file Cline để cấu hình Roo.

### Gemini CLI

Tích **Agents: Gemini CLI** rồi Scan, hoặc gộp mẫu JSON chung vào `~/.gemini/settings.json`. Giữ các thiết lập Gemini sẵn có. Mở phiên Gemini mới và kiểm tra server/tool MCP đã khả dụng.

### Antigravity

Tích **Agents: Antigravity** rồi Scan, hoặc gộp mẫu JSON chung vào `~/.gemini/antigravity/mcp_config.json`. Kết nối lại server MCP hoặc mở phiên agent mới. Antigravity và Gemini CLI dùng hai file cấu hình khác nhau.

### DeepSeek Harness

Tích **Agents: DeepSeek Harness** rồi Scan. Adapter dùng `$DSH_HOME/cordis.patch.yml`, mặc định là `~/.dsh/cordis.patch.yml`. Đây là danh sách patch YAML, không phải JSON `mcpServers`. Nếu dùng npm thủ công, thêm operation sau vào danh sách sẵn có, tránh trùng mục `review-hub`:

```yaml
- insert:
    - id: mcp-review-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: review-hub
        transport: stdio
        command: npx
        args: ['-y', 'review-hub-mcp']
```

Với runtime đi kèm, đưa command/args và `env` nếu có vào `config`. Khởi động lại phiên Harness để nạp patch và kiểm tra tool MCP.

### Oh My Pi

Tích **Agents: Oh My Pi** rồi Scan. Mặc định là `~/.omp/agent/mcp.json`; adapter dùng `.mcp.json` sẵn có nếu chưa có `mcp.json`. Adapter còn hỗ trợ `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` và profile có tên qua `OMP_PROFILE`/`PI_PROFILE`. Profile có tên thường dùng `~/.omp/profiles/<profile>/agent/mcp.json`. Mở VS Code với cùng môi trường/profile của OMP và dùng đúng đường dẫn Scan báo.

Nếu làm thủ công, gộp mẫu JSON chung vào cấu hình profile đang dùng. Mở phiên OMP mới. Một số cấu hình đưa MCP qua `xd://`: khám phá/đọc schema device rồi gọi đúng device Hub bằng JSON được quy định; không giả định tên device cố định. Hook Require Review tùy chọn hỗ trợ OMP trên Linux/macOS; xem [hướng dẫn cài đặt](INSTALLATION.vi.md).

## Cập nhật hướng dẫn sau khi nâng cấp extension

1. Chạy **Review Hub: Scan and Register Detected Agents** để cập nhật server đi kèm cho các agent được chọn.
2. Chạy lại **Review Hub: Install agent instructions** để cập nhật khối hướng dẫn của dự án, hoặc dùng **Copy AI Agent Rules to Clipboard** rồi thay khối hướng dẫn trong file quy tắc của agent. Hướng dẫn Claude cấp người dùng cũng được cập nhật khi quét nếu bật **Claude: Install Instructions**.
3. Kết nối lại MCP hoặc mở phiên agent mới. Server gửi quy trình dùng chung trong phản hồi khởi tạo MCP; việc sử dụng nội dung đó phụ thuộc client. Phiên đang chạy không tự nạp lại file hướng dẫn.

Quy trình bao gồm đề xuất nhiều file và xóa file, quyết định review từng phần, đọc lịch sử bằng cursor, đọc lại toàn bộ file sau quyết định của người dùng, chọn workspace và giới hạn Require Review. Các mẫu copy, hướng dẫn dự án/Claude và MCP server dùng cùng một nguồn quy trình.

Để không tự bật tab diff, tắt **Review Hub: Auto Open Diff** (`"review-hub.autoOpenDiff": false`) rồi reload cửa sổ VS Code đó. Vẫn có thể review từ panel Hub hoặc chọn file đang chờ duyệt. Tùy chọn này không thay đổi tool MCP hay cách áp dụng code xuống đĩa.

## Xác nhận agent thực sự dùng Hub

Gửi một yêu cầu nhỏ, ví dụ:

> Dùng MCP Review Hub tạo `review-hub-test.txt` có hai dòng. Dùng tool đề xuất, không dùng Edit/Write/Bash trực tiếp. Chờ tôi review và đọc lại file sau quyết định của tôi.

Đề xuất thành công trả về `staged_for_review`. Code đã có trên đĩa; **Accept giữ lại, Reject khôi phục**. Ghi trực tiếp trong editor/shell và diff Git không tạo review. Sau khi kiểm tra, có thể yêu cầu xóa file thử bằng `propose_delete`. Nếu thiếu tool này, khám phá/nạp lại tool hoặc dùng `propose_changes` với mục `delete: true`.

Trạng thái Connected chưa buộc agent dùng MCP. Hướng dẫn áp dụng cho mọi client; hook **Require Review** hiện chỉ cưỡng chế cho **Claude Code và Oh My Pi trên Linux/macOS**. Agent nhận quyết định qua `get_review_updates` và kết quả các lần gọi tool tiếp theo, rồi phải đọc lại toàn bộ file bị ảnh hưởng trước khi đề xuất tiếp. Thông báo không tự khởi chạy lượt xử lý mới của agent.

Nếu thiếu tool, còn chạy server cũ, khác môi trường hoặc có cấu hình tùy chỉnh, xem [xử lý lỗi](INSTALLATION.vi.md).
