# Phát hành Review Hub

Bản phát hành này dùng **GitHub Releases** để cộng đồng tải VSIX. npm là kênh phân phối MCP server. Visual Studio Marketplace sẽ làm ở bước riêng; không cần tài khoản Marketplace để tải/cài VSIX.

## Phiên bản và kiểm tra

Phiên bản Node packages hiện tại: **0.3.4**. JetBrains giữ phiên bản riêng vì lần này không thay đổi plugin.

Dùng Node.js **22.13.0 trở lên** và chạy từ thư mục gốc repository:

```bash
npm ci
npm run package:vscode
npm run typecheck
npm test
npm run pack:mcp
```

Kết quả:

- `vscode/review-hub-vscode-0.3.4.vsix`: extension để cài thủ công.
- `mcp/review-hub-mcp-0.3.4.tgz`: package MCP có thể kiểm tra trước khi publish npm.

Các file demo thử giao diện không thuộc bản phát hành.

## Public VSIX trên GitHub Releases

Workflow [Build and Release](https://github.com/TongDuyDat/hub-preview/actions/workflows/release.yml) kiểm tra mỗi lần push `main`. Nó chỉ tạo release công khai khi push tag phiên bản hoặc chạy thủ công; không ghi đè release cũ trên mỗi commit.

Sau khi commit phiên bản mới lên main:

```bash
git tag -a v0.3.4 -m "Review Hub v0.3.4"
git push origin v0.3.4
```

Tag phải trùng version trong `package.json`, `core/package.json`, `mcp/package.json` và `vscode/package.json`. Với lần sau, tăng đồng bộ các version và lockfile trước khi tạo tag mới. Không tái sử dụng tag đã phát hành.

Workflow build/test rồi đính kèm VSIX, tarball MCP và `SHA256SUMS.txt` tại:

https://github.com/TongDuyDat/hub-preview/releases/latest

Người dùng cài VSIX bằng **Extensions → … → Install from VSIX…** hoặc:

```bash
code --install-extension review-hub-vscode-0.3.4.vsix --force
```

Có thể chọn **Run workflow → include_jetbrains** để build thêm plugin JetBrains. Bản VSIX/MCP thông thường không cần Java hay Gradle.

## Đăng ký tài khoản và publish npm

1. Tạo/đăng nhập tài khoản tại https://www.npmjs.com/signup và xác minh email.
2. Bật 2FA trong phần tài khoản npm. Đăng nhập CLI qua trình duyệt:

```bash
npm login --auth-type=web
npm whoami
npm view review-hub-mcp version
npm owner ls review-hub-mcp
```

Tên `review-hub-mcp` **đã có trên npm** (trước lần phát hành này là 0.3.3). Không đăng ký tên này lần nữa. Tài khoản đăng nhập phải là owner/maintainer; nếu chưa có quyền, nhờ owner hiện tại thêm tài khoản bằng `npm owner add TEN_TAI_KHOAN review-hub-mcp`.

Không cần viết file chứa mật khẩu hoặc npm token trong repository. CLI lưu thông tin đăng nhập vào cấu hình người dùng. Không commit thông tin xác thực.

Kiểm tra danh sách file trong gói:

```bash
npm pack --workspace review-hub-mcp --dry-run
```

Gói phải có `package.json`, `bin/mcp-server.cjs`, `README.md` và `LICENSE`. `prepack` tự build bundle trước khi đóng gói; `prepublishOnly` chạy TypeScript/test trước khi publish.

Publish từ thư mục gốc:

```bash
npm run publish:mcp
```

Hoặc publish từ thư mục `mcp/`:

```bash
cd mcp
npm publish --access public
```

Hoàn thành yêu cầu xác thực/OTP của npm khi được hỏi. npm không cho ghi đè phiên bản đã publish; nếu version đã tồn tại, tăng version rồi build/test lại. Tarball trên GitHub Releases **không tự xuất hiện trên npm**; workflow hiện tại không publish npm và không cần `NPM_TOKEN`.

Xác minh sau khi publish:

```bash
npm view review-hub-mcp@0.3.4 version bin engines
npx -y review-hub-mcp@0.3.4
```

Lệnh cuối khởi động MCP stdio và có thể chờ input; đây không phải lệnh in phiên bản. Để kiểm tra tools, mở project trong VS Code có Review Hub, cấu hình agent dùng package này, rồi gọi `list_changes`.

## Website GitHub Pages

Website tĩnh ở `docs/index.html`; `docs/.nojekyll` tắt Jekyll/Sass cho site này. Trong **Repository → Settings → Pages**, giữ **Deploy from a branch → main → /docs**.

Không xóa thư mục `docs` khi quay về code extension cũ. Việc thiếu thư mục nguồn gây lỗi `No such file or directory @ dir_chdir0 - /github/workspace/docs`.

Website: https://tongduydat.github.io/hub-preview/

## Marketplace sau này

Tạo publisher tại https://marketplace.visualstudio.com/manage, xác minh quyền sở hữu publisher, rồi đối chiếu `publisher` trong `vscode/package.json` (hiện là `review-hub`). Chỉ dùng publisher mà tài khoản thực sự sở hữu. Sau khi có quyền, publish VSIX đã kiểm tra theo tài liệu chính thức: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
