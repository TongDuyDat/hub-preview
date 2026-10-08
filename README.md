# Review Hub for VS Code

Xem **chính xác** AI coding agent đã đổi gì trong project của bạn — **bất kể agent chạy ở
chế độ quyền nào** — và duyệt/từ chối **từng khối (hunk) một**, kiểu hunkwise.

Hỗ trợ **Claude Code, opencode, dsh (deepseek-harness), Cline, Roo Code** qua MCP, và vẫn bắt
được cả những agent không dùng MCP mà ghi thẳng vào file.

> **Điểm cốt lõi:** Review Hub **không ghi gì lên đĩa khi agent đề xuất thay đổi**. Thay đổi
> được giữ lại kèm diff, và **chỉ những hunk bạn bấm ✓ mới thực sự được ghi xuống đĩa**.

---

## Mục lục

1. [Vấn đề nó giải quyết](#1-vấn-đề-nó-giải-quyết)
2. [Cách hoạt động: xem trước rồi mới ghi](#2-cách-hoạt-động-xem-trước-rồi-mới-ghi)
3. [Hai bề mặt giao diện](#3-hai-bề-mặt-giao-diện)
4. [Yêu cầu](#4-yêu-cầu)
5. [Cài đặt](#5-cài-đặt)
6. [Hướng dẫn sử dụng](#6-hướng-dẫn-sử-dụng)
7. [Phát hiện thay đổi — hoạt động cả nơi inotify "tịt"](#7-phát-hiện-thay-đổi--hoạt-động-cả-nơi-inotify-tịt)
8. [Danh sách lệnh](#8-danh-sách-lệnh)
9. [MCP tools cho agent](#9-mcp-tools-cho-agent)
10. [Cài đặt (Settings)](#10-cài-đặt-settings)
11. [Lưu trữ](#11-lưu-trữ)
12. [Ghi chú thiết kế](#12-ghi-chú-thiết-kế)
13. [Xử lý sự cố](#13-xử-lý-sự-cố)
14. [Phát triển](#14-phát-triển)

15. [Inline staged review (kiểu Antigravity)](#15-inline-staged-review-kiểu-antigravity)

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

## 2. Cách hoạt động: xem trước rồi mới ghi

```
 harness (Claude Code / opencode / dsh / Cline / Roo)
        │  spawn qua stdio
        ▼
 mcp-server.cjs  ──HTTP + bearer token──▶  Review Hub (extension này)
        │                                        │
        │                                  Change Store  (~/.review-hub)
        │                                        │
   stage các thay đổi                     Panel sidebar + tab review
                                          accept / reject theo từng hunk
```

1. Khi kích hoạt, extension mở một hub cục bộ (`127.0.0.1`, port ngẫu nhiên, kèm bearer token)
   và ghi thông tin ra `~/.review-hub/hub.json`.
2. **Baseline** của một file lấy từ git HEAD, hoặc được chụp lại ở lần đầu file đó thay đổi.
3. Agent gọi `propose_edit` / `propose_write` → thay đổi được **lưu lại kèm diff để chờ duyệt**,
   **không ghi gì lên đĩa**.
4. File đã đổi có **badge trong Explorer** (`M`/`A`/`D`, có màu, kèm dấu chấm ở folder cha) và
   một dòng trong panel **Review Hub** → biết file nào đổi mà không cần mở gì cả. Không có cửa
   sổ nào tự bật lên.
5. Click vào dòng trong panel để mở **tab review**: mỗi hunk hiện dòng cũ (nền đỏ) ngay trên
   dòng mới (nền xanh), kèm nút **✓** / **↺** cho từng hunk. Thấy code cũ và mới cùng lúc.
6. Bấm **✓** một hunk → đúng các dòng mới của hunk đó được ghi lên đĩa. Bấm **↺** → không ghi
   gì, giữ nguyên dòng gốc.

Bảng trạng thái đĩa tương ứng:

| Hành động | Trên đĩa sau đó |
|---|---|
| Agent đề xuất (`propose_edit`) | **không đổi** — vẫn là bản gốc |
| Bạn bấm ✓ một hunk | đúng các dòng mới của hunk đó |
| Bạn bấm ↺ một hunk | không ghi gì (giữ dòng gốc) |
| Hunk chưa quyết định | không có trên đĩa |

> **Hệ quả cần nhớ:** nếu agent tự đọc file bằng công cụ riêng của nó, nó sẽ thấy **nội dung
> cũ**. Đó là đúng thiết kế, không phải lỗi. Agent nên đọc qua công cụ `read_file` của Review
> Hub để thấy bản đã đề xuất.

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

---

## 3. Hai bề mặt giao diện

- **Panel ở sidebar** (biểu tượng Review Hub trên thanh hoạt động): danh sách file kèm
  `+thêm −bớt`, mở ra xem từng hunk `@line N`, mỗi hunk có ✓ / ↺, kèm nút cấp file và cấp
  toàn bộ. Kiểu bố cục của [hunkwise](https://github.com/molon/hunkwise).
- **Tab review**: cửa sổ diff đầy đủ — dòng bị xoá hiển thị **nền đỏ**, dòng thêm vào hiển
  thị **nền xanh**, mỗi hunk có thanh quyết định riêng. Đây là nơi duy nhất hiển thị được
  khối đỏ nhiều dòng: API ổn định của VS Code không cho phép vẽ nhiều dòng chèn vào buffer
  thật (xem `docs/superpowers/specs/2026-10-07-hunkwise-ui-and-sqlite-store-design.md` §2.1).

Ngoài ra, **file thật** cũng có highlight inline (xanh cho dòng mới, đỏ cho dòng bị hoàn
nguyên, chữ đã xoá hiện dạng ghost text) kèm nút Accept/Reject, để bạn duyệt ngay tại chỗ.
Khi cần chế độ 2 cột cổ điển, dùng **Review Hub: Open Side-by-Side Diff**.

---

## 4. Yêu cầu

- **VS Code 1.103.0 trở lên.** Bản 1.85–1.102 dùng Electron cũ thiếu binding `node:sqlite`
  (lỗi đã được sửa ở Electron 37.2.3). Nếu không có SQLite, extension tự động chuyển sang
  kho JSON trong `~/.review-hub/workspaces/` — không hỏng, chỉ chậm hơn.
- Node 22.13+ trong extension host (đi kèm VS Code 1.103+).
- Khuyến nghị: project nằm trong **git repo** để baseline lấy được từ `git show HEAD:<path>`
  (rẻ và chính xác). Workspace không phải git vẫn dùng được, chỉ khác cách lấy baseline.

---

## 5. Cài đặt

### 5.1. Cài extension

**Cách A — cài từ file `.vsix` (dùng để thử):**

```bash
code --install-extension review-hub-vscode-0.2.0.vsix
```

Hoặc trong VS Code: mở **Extensions** (`Ctrl+Shift+X`) → menu `⋯` → **Install from VSIX…**
→ chọn file `.vsix`.

**Cách B — build từ source:**

```bash
cd review-hub-vscode
npm install
npm run build            # bundle dist/extension.js và dist/mcp-server.cjs
npm run package          # tạo review-hub-vscode-<version>.vsix
code --install-extension review-hub-vscode-*.vsix
```

Sau khi cài, **reload cửa sổ** (`Ctrl+Shift+P` → `Developer: Reload Window`). Biểu tượng
**Review Hub** sẽ xuất hiện trên thanh hoạt động bên trái.

> **Lưu ý:** nên build trên filesystem Linux native. Trên mount WSL `/mnt/*` (9p), `npm install`
> chạy song song có thể ghi đè làm hỏng file.

### 5.2. Bật lên (làm 1 lần cho mỗi máy/harness)

Mở **Command Palette** (`Ctrl+Shift+P`) và chạy:

1. **`Review Hub: Register MCP in all harnesses`**
   → chọn những harness bạn dùng. Extension ghi entry MCP vào config của từng harness
   (**có backup** trước khi sửa) và trỏ vào bản copy cố định `~/.review-hub/bin/mcp-server.cjs`.

2. **`Review Hub: Install agent instructions`**
   → thêm khối `<!-- review-hub:start -->…<!-- review-hub:end -->` vào `AGENTS.md` / `CLAUDE.md`
   của workspace, dạy agent ưu tiên gọi `propose_*` thay vì sửa file trực tiếp.

3. **Khởi động lại từng harness** (đóng và mở lại Claude Code / opencode / dsh / Cline / Roo)
   để nó nạp MCP server mới.

Kiểm tra nhanh: chạy **`Review Hub: Show Hub Info`** → hiện hub URL, PID và đường dẫn MCP
server. Nếu thấy thông tin tức là hub đang chạy.

---

## 6. Hướng dẫn sử dụng

### 6.1. Vòng làm việc hằng ngày

```
Agent sửa file  →  badge hiện trong Explorer + dòng trong panel Review Hub
                →  bạn click vào file, xem từng hunk
                →  Accept / Reject từng hunk
                →  hết thay đổi thì file mất badge
```

### 6.2. Duyệt trong panel sidebar (cách chính)

1. Click biểu tượng **Review Hub** trên thanh hoạt động.
2. Panel hiện tổng quan: `N files`, `+thêm −bớt`, và các nút **✓ Accept All** / **↺ Discard
   All** / **⟳ Set checkpoint** ở trên cùng.
3. Mỗi file là một dòng: tên file, `+thêm −bớt`, badge `new` / `deleted` / `binary` nếu có,
   và hai nút **✓** (accept cả file) / **↺** (reject cả file).
4. Click vào tên file (hoặc twisty `▾`) để **mở rộng** danh sách hunk. Mỗi hunk hiện
   `@line N`, `+thêm −bớt`, và cặp nút **✓** / **↺**.
5. Bấm **✓** để accept hunk đó (ghi dòng mới lên đĩa), **↺** để reject (giữ dòng gốc).
   Sau khi quyết định, hunk hiện badge `✓ accepted` / `✗ rejected` kèm nút đảo ngược quyết định.
6. Có nhiều project cùng mở? Panel nhóm theo workspace, mỗi nhóm có tiêu đề riêng.

### 6.3. Duyệt trong tab review (diff đầy đủ, thấy cả dòng xoá nhiều dòng)

1. Click vào tên file trong panel (hoặc nút **Open Diff**), hoặc chạy
   **`Review Hub: Open Diff`**.
2. Tab review hiện toàn bộ diff: **dòng bị xoá nền đỏ**, **dòng thêm nền xanh**, xen kẽ dòng
   context.
3. Trước mỗi hunk có thanh quyết định: `+thêm −bớt · trạng thái` cùng nút **✓ Accept** /
   **↺ Reject**. Đã quyết định thì nút đổi thành **✓ Accepted** / **✗ Rejected** để bấm đảo lại.
4. Trên cùng tab có **✓ Accept All** / **↺ Discard All** cho cả file.

Mỗi file mở một tab riêng; mở lại cùng file sẽ focus tab đang có thay vì tạo tab mới.

### 6.4. Duyệt ngay trên file thật (inline)

Mở file thật (badge trong Explorer hoặc **`Review Hub: Open File`**). Bạn sẽ thấy:

- Dòng mới của hunk đã accept: highlight **xanh**.
- Dòng bị hoàn nguyên: highlight **đỏ**.
- Phần chữ đã bị xoá: hiện dạng **ghost text** (chữ mờ sau dòng), kèm gợi ý `⊕ +N more added`
  khi hunk chèn nhiều dòng.
- CodeLens **Accept / Reject** ngay trên hunk để duyệt tại chỗ.

### 6.5. Diff 2 cột cổ điển

Chạy **`Review Hub: Open Side-by-Side Diff`** (hoặc chuột phải file trong Explorer) để mở diff
`baseline | đề xuất` theo kiểu editor gốc của VS Code.

### 6.6. Checkpoint — mốc để đo "đã đổi gì"

Baseline là mốc so sánh. Bạn có thể đặt lại mốc:

- **`Review Hub: Set Checkpoint`** — chấp nhận trạng thái hiện tại làm baseline mới (mọi thay
  đổi đang chờ biến mất khỏi danh sách). Dùng khi bạn muốn "chốt" một trạng thái sạch.
- **`Review Hub: Clear Checkpoint`** — xoá checkpoint hiện tại.

Từ đó về sau, mọi thay đổi được đo so với mốc này.

### 6.7. Xử lý agent **không** dùng MCP

Nếu agent bỏ qua MCP và ghi thẳng xuống đĩa (ví dụ chạy ở chế độ auto-approve mà không đọc
hướng dẫn), **file watcher** vẫn bắt được: file hiện badge và một dòng trong panel như bình
thường, và bạn vẫn duyệt được theo hunk. Đây là cơ chế "lưới an toàn" — bật/tắt bằng setting
`review-hub.watchDirectWrites`.

> Trong luồng watcher, agent **đã** ghi vào đĩa rồi, nên trạng thái mặc định là "đã có trên
> đĩa"; hunk chưa quyết định được coi là đang tồn tại trên đĩa cho tới khi bạn reject.

### 6.8. Phím tắt / thao tác nhanh

- `Ctrl+Shift+P` → gõ `Review Hub` để thấy mọi lệnh.
- Chuột phải file trong Explorer → nhóm **Review Hub** (`Open Diff`, `Open Side-by-Side`,
  `Accept File`, `Reject File`).
- Thanh tiêu đề panel có sẵn: Set Checkpoint, Accept All, Reject All, Refresh.

---

## 7. Phát hiện thay đổi — hoạt động cả nơi inotify "tịt"

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

## 8. Danh sách lệnh

| Lệnh | Tác dụng |
|---|---|
| **Set Checkpoint** | Chấp nhận trạng thái hiện tại làm baseline mới |
| **Clear Checkpoint** | Xoá checkpoint hiện tại |
| **Show Changes** | Mở/focus view Changes |
| **Refresh** | Làm mới danh sách thay đổi |
| **Open Diff** | Mở tab review (cũ + mới) cho một file |
| **Open Side-by-Side Diff** | Mở diff 2 cột cổ điển: baseline vs đề xuất |
| **Open File (new content)** | Mở file thật trên đĩa để sửa trực tiếp |
| **Accept Hunk** / **Reject Hunk** | Duyệt/từ chối một khối |
| **Accept File** / **Reject File** | Duyệt/từ chối toàn bộ file |
| **Undo File** | Reject mọi hunk trong file đang chọn |
| **Accept All Changes** / **Reject All Changes** | Xử lý mọi thay đổi ở mọi project |
| **Register MCP in all harnesses** | Ghi entry MCP vào config từng harness (có backup) |
| **Install agent instructions** | Thêm khối Review Hub vào `AGENTS.md` / `CLAUDE.md` |
| **Show Hub Info** | Hiện hub URL, PID và đường dẫn MCP server |

---

## 9. MCP tools cho agent

| Tool | Mục đích |
|---|---|
| `propose_edit` | Stage một sửa đổi `old_string` → `new_string` (giống tool Edit gốc) |
| `propose_write` | Stage việc ghi toàn bộ file |
| `read_file` | Đọc file trong workspace qua hub (thấy cả nội dung đã stage) |
| `list_changes` | Liệt kê các file đã đổi kể từ checkpoint cuối |
| `accept` / `reject` | Duyệt/từ chối toàn bộ hoặc một số hunk cụ thể |
| `set_checkpoint` | Đẩy baseline lên trạng thái hiện tại |

`propose_*` trả về `status: "staged_for_review"` kèm `changeId`. Đó là **thành công**, không
phải lỗi — agent không nên retry bằng tool khác.

---

## 10. Cài đặt (Settings)

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| `review-hub.enabled` | `true` | Bật/tắt hub. Tắt thì server không chạy và watcher bị vô hiệu. |
| `review-hub.watchDirectWrites` | `true` | Bắt agent ghi file trực tiếp (cơ chế dự phòng khi agent bỏ qua MCP). |
| `review-hub.autoOpenDiff` | `false` | Tự mở tab review ngay khi agent sửa file. Mặc định tắt để không làm gián đoạn. |
| `review-hub.ignoreWhitespace` | `false` | Bỏ qua thay đổi chỉ khác khoảng trắng. |
| `review-hub.maxFileSize` | `2097152` (2 MB) | File lớn hơn mức này chỉ accept/reject cả file, không tách hunk. |
| `review-hub.excludeGlobs` | `[]` | Glob bổ sung mà watcher bỏ qua (danh sách mặc định luôn được áp dụng). |
| `review-hub.maxSnapshotFiles` | `5000` | Giới hạn số file một lần snapshot checkpoint đọc. |

---

## 11. Lưu trữ

Tất cả nằm dưới `~/.review-hub/`:

```
~/.review-hub/
  hub.json                    thông tin discovery (url, token, pid) — chmod 0600
  bin/mcp-server.cjs          bản copy cố định mà các harness trỏ vào
  hub.db                      trạng thái review (SQLite, mặc định)
  workspaces/<hash>/
    baselines/<hash>          file baseline lưu theo content-addressed hash
```

Một database nhỏ tại `~/.review-hub/hub.db` (bảng `checkpoints`, `changes`, `hunks`) giữ
trạng thái review. Nội dung baseline được lưu theo hash trong
`~/.review-hub/workspaces/<hash>/baselines/` để database không phình to.

Nếu máy không có `node:sqlite`, extension tự chuyển sang kho JSON cùng chỗ — thay `hub.db` bằng:

```
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

## 12. Ghi chú thiết kế

- **Các quyết định không đẩy nhau.** Hunk được tính một lần so với baseline, rồi file được dựng
  lại bằng cách replay các quyết định từ baseline. Accept hunk 1 **không** làm đổi số dòng của
  hunk 2 (khác với việc sửa trên document đang sống).
- **Chưa duyệt = giữ baseline**, nên hunk chưa xem không bao giờ bị accept ngầm.
- **Giữ nguyên line ending và BOM**: nội dung được chuẩn hoá để diff rồi phục hồi khi ghi, nên
  đổi CRLF ↔ LF không bị hiện thành thay đổi cả file.
- **Token không bao giờ nằm trong config của harness** (dsh còn scrub biến env khớp `*TOKEN*`);
  MCP server đọc token từ `hub.json`.

---

## 13. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp & cách xử lý |
|---|---|
| Panel báo "No changes to review" dù agent vừa sửa | Agent chưa nạp MCP server → khởi động lại harness; hoặc file không đổi thật sự; hoặc chưa có checkpoint → chạy **Set Checkpoint**. |
| Agent đọc file và báo "nội dung cũ" | Đúng thiết kế của review-then-apply. Agent nên dùng tool `read_file` của Review Hub. |
| Agent nói `propose_edit` "thất bại" và retry | `status: "staged_for_review"` là **thành công**. Chạy lại **Install agent instructions** để nhắc agent điều này. |
| Accept rồi mà file trên đĩa vẫn cũ | Kiểm tra đúng file/hunk; xem badge còn không. Mở tab review xem trạng thái hunk. |
| Extension báo không có SQLite | VS Code < 1.103 hoặc Electron cũ. Nâng VS Code, hoặc để extension tự fallback sang kho JSON. |
| Muốn reset sạch | **Clear Checkpoint**, rồi xoá `~/.review-hub/` (mất toàn bộ trạng thái review). |
| Nhiều cửa sổ VS Code | Mỗi cửa sổ chỉ hiện thay đổi của workspace đang mở trong cửa sổ đó. |

---

## 14. Phát triển

```bash
npm run build       # bundle dist/extension.js và dist/mcp-server.cjs
npm run typecheck   # tsc --noEmit
npm test            # 244 tests: hunk diff, store, backend, sqlite, hub, panel, tab, MCP, e2e, staged model, staged engine, decorations, CodeLens, wiring, exit flush
npm run package     # tạo file .vsix
```

> **Lưu ý:** hãy build project này trên filesystem Linux native. Trên mount WSL `/mnt/*` (9p),
> `npm install` chạy song song có thể ghi đè làm hỏng file.

## 15. Inline staged review (kiểu Antigravity)

Khi agent sửa một file, Review Hub **thay nội dung buffer của file đó** bằng chế độ xem gộp:
mỗi khối thay đổi hiện **cả hai phía** — code cũ nền đỏ nằm trên code mới nền xanh — kèm
`✓ Accept` / `✗ Reject` ngay tại khối đó (CodeLens) và hai nút
**Accept All / Reject All** trên thanh tiêu đề editor.

| Thao tác | Kết quả |
|---|---|
| `✓ Accept` một khối | giữ code mới; khối đỏ biến mất; file trên đĩa ghi ngay dòng vừa chấp nhận |
| `✗ Reject` một khối | giữ code cũ; khối xanh biến mất; file trên đĩa lùi về dòng gốc |
| `Ctrl+S` khi còn khối chưa quyết | **bị chặn** — buffer đang là chế độ xem, không phải nội dung file |
| Quyết định xong khối cuối | buffer tự trả lại file trên đĩa (sạch, không còn gì chờ lưu) |
| Gõ tay vào buffer đang review | extension nhả file đó (không revert gì), record vẫn chờ bạn duyệt |
| Thoát VS Code khi còn change chưa quyết | change đó được **Accept** (lấy code mới của agent), cache dọn sạch |

Điều kiện:

- `files.autoSave` phải là `off` (mặc định). Nếu bạn bật auto-save, staging tự tắt và hiện
  thông báo **một lần** — thay vào đó file được highlight và hiện code cũ bằng ghost text như
  trước đây (bật `review-hub.autoOpenDiff` nếu muốn mở tab review tự động).
- File binary, file agent xoá, hoặc change không có hunk → không stage, giữ nguyên cơ chế cũ
  (highlight + tab review).
- File không stage được vẫn dùng đường cũ: `decide()` ghi đĩa rồi reload editor.
