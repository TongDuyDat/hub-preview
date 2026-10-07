# Review Hub for VS Code

See exactly what AI coding agents changed in your project — **regardless of their permission
mode** — and accept or reject changes **one hunk at a time**.

Hỗ trợ **Claude Code, opencode, dsh (deepseek-harness), Cline, Roo** qua MCP, và vẫn bắt được
cả những agent không dùng MCP mà ghi thẳng vào file.

---

## 1. Vấn đề nó giải quyết

Khi agent chạy ở chế độ tự động duyệt (Claude Code `acceptEdits`, Cline auto-approve, dsh,
opencode), nó ghi thẳng xuống đĩa và **không cho bạn thấy gì cả**. Còn khi nó có hiện diff thì
diff đó biến mất ngay sau khi bạn accept — không có danh sách "từ lần trước tới giờ đã đổi
những gì".

Review Hub giải quyết cả hai bằng cách nằm **bên dưới** agent, ở tầng filesystem:

| Cơ chế | Tác dụng |
|---|---|
| **MCP server "staging"** | Agent gọi nó thay vì sửa file trực tiếp → thay đổi chờ bạn duyệt |
| **File watcher** | Vẫn bắt được các lệnh ghi file trực tiếp → không thay đổi nào bị ẩn |

---

## 2. Cách hoạt động

```
 harness (Claude Code / opencode / dsh / Cline / Roo)
        │  spawn qua stdio
        ▼
 mcp-server.cjs  ──HTTP + bearer token──▶  Review Hub (extension này)
        │                                        │
        │                                  Change Store  (~/.review-hub)
        │                                        │
   stage các thay đổi                     Changes tree + diff + CodeLens
                                          accept / reject theo từng hunk
```

1. Khi kích hoạt, extension mở một hub cục bộ (`127.0.0.1`, port ngẫu nhiên, kèm bearer token)
   và ghi thông tin ra `~/.review-hub/hub.json`.
2. **Baseline** của một file lấy từ git HEAD, hoặc được chụp lại ở lần đầu file đó thay đổi.
3. Agent gọi `propose_edit` / `propose_write` → thay đổi được **ghi ngay xuống đĩa** (nên bạn
   thấy nó inline trong file thật) **và** được ghi lại để chờ duyệt.
4. File đã đổi có **badge trong Explorer** (`M`/`A`/`D`, có màu, kèm dấu chấm ở folder cha) và
   một dòng trong panel **Review Hub** → biết file nào đổi mà không cần mở gì cả. Không có cửa
   sổ nào tự bật lên.
5. Click vào file (trong Explorer hoặc dòng trong panel) để mở **merged review view**: một editor
   duy nhất, mỗi hunk hiện dòng cũ (đỏ) ngay trên dòng mới (xanh), phần context không đổi ở giữa,
   kèm nút **Accept** / **Reject** cho từng hunk. Thấy code cũ và mới cùng lúc.
6. **Reject** khôi phục lại đúng các dòng baseline của hunk đó → không mất gì.

### Quyết định ở mức "khối", không phải cả file

Mọi quyết định đều ở mức **change block (hunk)**, không bao giờ ở mức cả file:

- **Accept** một block → chỉ giữ các dòng mới của block đó.
- **Reject** một block → chỉ khôi phục block đó về baseline.
- Các block khác không bị ảnh hưởng và vẫn ở trạng thái chờ duyệt.

Ví dụ với 3 block A, B, C:

```
A → accept   ⇒  A: đã áp dụng
B → (bỏ qua) ⇒  B: vẫn chờ duyệt
C → reject   ⇒  C: đã hoàn nguyên
```

File **vẫn giữ badge** cho tới khi B cũng được quyết định.

File thật cũng có highlight inline (xanh cho dòng mới, đỏ cho dòng bị hoàn nguyên, chữ đã xoá
hiện dạng ghost text) kèm nút Accept/Reject y như vậy, để bạn duyệt ngay tại chỗ. Khi cần chế độ
2 cột cổ điển, dùng **Review Hub: Open Side-by-Side Diff**. Tính năng tự mở merged view mặc định
**tắt** (`review-hub.autoOpenDiff`) để agent không làm gián đoạn việc bạn đang làm.

---

## 3. Bắt đầu nhanh

### Cài đặt

```bash
cd review-hub-vscode
npm install
npm run build
npm run package          # tạo ra review-hub-vscode-<version>.vsix
code --install-extension review-hub-vscode-*.vsix
```

### Bật lên (3 bước, làm 1 lần)

1. Chạy **Review Hub: Register MCP in all harnesses** và chọn những harness bạn dùng.
2. Chạy **Review Hub: Install agent instructions** để thêm khối "ưu tiên dùng `propose_*`" vào
   `AGENTS.md` / `CLAUDE.md`.
3. Khởi động lại từng harness để nó nhận MCP server mới.

### Vòng làm việc hằng ngày

```
Agent sửa file  →  badge hiện trong Explorer + dòng trong panel Review Hub
                →  bạn click vào file, xem từng hunk
                →  Accept / Reject từng hunk
                →  hết thay đổi thì file mất badge
```

---

## 4. Phát hiện thay đổi — hoạt động cả nơi inotify "tịt"

Hệ thống dùng **3 cơ chế** để không phụ thuộc vào việc filesystem có bắn event hay không:

1. **File watcher của VS Code** — tức thời, ở nơi inotify hoạt động.
2. **Poll `git status`** — đọc trực tiếp index, nên chạy được trên mount WSL 9p (ổ Windows dưới
   `/mnt` hoặc `/home/<user>/Work`) — nơi inotify không bao giờ bắn.
3. **Quét thư mục có giới hạn** — dùng cho workspace không phải git repo.

Polling được giới hạn phạm vi để luôn rẻ:

- Chỉ chạy **ở nơi cần thiết** — trên filesystem có watcher native hoạt động (mọi thứ trừ 9p),
  polling chỉ còn là lưới an toàn định kỳ.
- **Tạm dừng khi cửa sổ không được focus** và chạy một lần khi focus lại → mở nhiều cửa sổ
  không nhân chi phí lên.
- Khi quét, cắt bỏ các thư mục bị loại trừ (`node_modules`, `.git`, `dist`, …) **trước khi** đi
  sâu vào, và nạp baseline cho cả lượt quét bằng **một** lần ghi checkpoint thay vì mỗi file một lần.
- Phép dò `git` work-tree được memoize → vòng poll không spawn process mỗi tick.

Kết quả: repo lớn nằm yên rất êm, mà vẫn không bỏ sót thay đổi nào.

---

## 5. Danh sách lệnh

| Lệnh | Tác dụng |
|---|---|
| **Set Checkpoint** | Chấp nhận trạng thái hiện tại làm baseline mới |
| **Clear Checkpoint** | Xoá checkpoint hiện tại |
| **Show Changes** | Mở/focus view Changes |
| **Refresh** | Làm mới danh sách thay đổi |
| **Open Diff** | Mở merged view (cũ + mới) cho một file |
| **Open Side-by-Side Diff** | Mở diff 2 cột cổ điển: baseline vs đề xuất |
| **Open File (new content)** | Mở file thật trên đĩa để sửa trực tiếp |
| **Accept Hunk** / **Reject Hunk** | Duyệt/từ chối một khối |
| **Accept File** / **Reject File** | Duyệt/từ chối toàn bộ file |
| **Undo File** | Reject mọi hunk trong file đang chọn |
| **Accept All Changes** / **Reject All Changes** | Xử lý mọi thay đổi ở mọi project |
| **Accept All in This Project** | Xử lý mọi thay đổi trong một project (nút trên dòng project) |
| **Reject All in This Project** | Hoàn nguyên mọi thay đổi trong một project |
| **Register MCP in all harnesses** | Ghi entry MCP vào config từng harness (có backup) |
| **Install agent instructions** | Thêm khối Review Hub vào `AGENTS.md` / `CLAUDE.md` |
| **Show Hub Info** | Hiện hub URL, PID và đường dẫn MCP server |

---

## 6. MCP tools cho agent

| Tool | Mục đích |
|---|---|
| `propose_edit` | Stage một sửa đổi `old_string` → `new_string` (giống tool Edit gốc) |
| `propose_write` | Stage việc ghi toàn bộ file |
| `read_file` | Đọc file trong workspace qua hub |
| `list_changes` | Liệt kê các file đã đổi kể từ checkpoint cuối |
| `accept` / `reject` | Duyệt/từ chối toàn bộ hoặc một số hunk cụ thể |
| `set_checkpoint` | Đẩy baseline lên trạng thái hiện tại |

---

## 7. Cài đặt (Settings)

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| `review-hub.enabled` | `true` | Bật/tắt hub. Tắt thì server không chạy và watcher bị vô hiệu. |
| `review-hub.watchDirectWrites` | `true` | Bắt agent ghi file trực tiếp (cơ chế dự phòng khi agent bỏ qua MCP). |
| `review-hub.autoOpenDiff` | `false` | Tự mở merged view ngay khi agent sửa file. Mặc định tắt để không làm gián đoạn. |
| `review-hub.ignoreWhitespace` | `false` | Bỏ qua thay đổi chỉ khác khoảng trắng. |
| `review-hub.maxFileSize` | `2097152` (2 MB) | File lớn hơn mức này chỉ accept/reject cả file, không tách hunk. |
| `review-hub.excludeGlobs` | `[]` | Glob bổ sung mà watcher bỏ qua (danh sách mặc định luôn được áp dụng). |
| `review-hub.maxSnapshotFiles` | `5000` | Giới hạn số file một lần snapshot checkpoint đọc. |

---

## 8. Dữ liệu lưu ở đâu

Tất cả nằm dưới `~/.review-hub/`:

```
~/.review-hub/
  hub.json                    thông tin discovery (url, token, pid) — chmod 0600
  bin/mcp-server.cjs          bản copy cố định mà các harness trỏ vào
  workspaces/<hash>/
    checkpoint.json           baseline từng file, chụp trong session này
    baselines/<hash>          file baseline lưu theo content-addressed hash
    changes/<id>.json         các change set đang chờ + quyết định
```

### Không snapshot sẵn, chỉ chụp khi cần

Review Hub **không** quét workspace khi mở. Baseline của file đến từ một trong hai nguồn rẻ tiền:

1. **`git show HEAD:<path>`** — miễn phí, phủ mọi file trong git repo.
2. **Chụp lazy khi `propose_edit`** — luồng MCP chạy *trước* khi sửa, nên nội dung hiện trên đĩa
   chính là baseline đúng.

Hệ quả:

- Mở repo lớn tốn gần như bằng không (không quét file, không đập đĩa).
- Session mà agent không sửa gì thì không hiện gì.
- Chỉ những file thực sự đổi mới được theo dõi và lưu.
- Thư mục data/model (`checkpoints/`, `datasets/`, `*.pt`, `*.bin`, ảnh, …) bị loại trừ mặc định
  nên không bao giờ bị đọc hay hash.

Nếu một file không được commit vào git và cũng không stage qua MCP, nó không có baseline và sẽ
hiện là **file mới** — đây là câu trả lời trung thực. Muốn chụp trạng thái hiện tại một cách
tường minh, chạy **Review Hub: Set Checkpoint** (giới hạn bởi `review-hub.maxSnapshotFiles`).

---

## 9. Ghi chú thiết kế

- **Các quyết định không đẩy nhau.** Hunk được tính một lần so với baseline, rồi file được dựng
  lại bằng cách replay các quyết định từ baseline. Accept hunk 1 **không** làm đổi số dòng của
  hunk 2 (khác với việc sửa trên document đang sống).
- **Chưa duyệt = giữ baseline**, nên hunk chưa xem không bao giờ bị accept ngầm.
- **Giữ nguyên line ending và BOM**: nội dung được chuẩn hoá để diff rồi phục hồi khi ghi, nên
  đổi CRLF ↔ LF không bị hiện thành thay đổi cả file.
- **Token không bao giờ nằm trong config của harness** (dsh còn scrub biến env khớp `*TOKEN*`);
  MCP server đọc token từ `hub.json`.

---

## 10. Phát triển

```bash
npm run build       # bundle dist/extension.js và dist/mcp-server.cjs
npm run typecheck
npm test            # 118 test: hunk diff, store, hub, registry, MCP forward, register, e2e
```

> **Lưu ý:** hãy build project này trên filesystem Linux native. Trên mount WSL `/mnt/*` (9p),
> `npm install` chạy song song có thể ghi đè làm hỏng file.
