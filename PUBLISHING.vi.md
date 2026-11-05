# Phát hành Review Hub

[English — bản gốc](PUBLISHING.md) | [Tiếng Việt](PUBLISHING.vi.md) · [README](README.vi.md)

## Chuẩn bị bản phát hành

Dùng Node.js 22.13 trở lên. Chạy tại thư mục gốc repository:

```sh
npm ci
npm run typecheck
npm test
npm run package:vscode
npm run pack:mcp
```

Kiểm tra VSIX trong `vscode/` và tarball npm trong `mcp/`. Cài VSIX vào cửa sổ thử nghiệm, kiểm tra đăng ký agent, review trong editor, Accept/Reject và kết nối lại. Rà README Anh/Việt, icon, changelog, giấy phép và metadata.

Khi chuẩn bị phiên bản mới, đồng bộ version trong package.json của root, core, mcp, vscode và lockfile. Cập nhật CHANGELOG.md và vscode/CHANGELOG.md. Mỗi version/tag phát hành phải riêng biệt; **v0.3.4 đã tồn tại trên GitHub**. Không dùng lại hoặc ghi đè tag đó cho code mới.

## Đăng ký publisher trên VS Code Marketplace

1. Đăng nhập tài khoản Microsoft tại [Manage Publishers](https://marketplace.visualstudio.com/manage).
2. Tạo publisher. Dự án dùng Publisher ID **DuyDatTong**, khớp `vscode/package.json`. Xác nhận bạn sở hữu đúng ID này trước khi phát hành. Nếu ID đã có người dùng, chọn ID khác còn trống, sửa manifest rồi build lại.
3. Điền thông tin hồ sơ/liên hệ bắt buộc. Chưa cần xác minh tên miền để phát hành lần đầu.
4. Trong publisher, chọn **New extension → Visual Studio Code** và tải VSIX vừa build lên.
5. Chờ kiểm tra, xem trang extension và thử cài. Các lần cập nhật sau cần VSIX có version cao hơn.

Sau khi phát hành, ID extension là `DuyDatTong.review-hub-vscode`, URL dự kiến là `https://marketplace.visualstudio.com/items?itemName=DuyDatTong.review-hub-vscode`. Đây là định danh dự kiến, chưa phải xác nhận đã phát hành.

### Phát hành bằng CLI (tùy chọn)

Tạo personal access token trên Azure DevOps, chọn quyền **Marketplace: Manage** và **All accessible organizations**, theo [hướng dẫn Microsoft](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). Nhập token cục bộ khi vsce hỏi; không đặt trong source, lệnh commit lên Git hoặc chat.

Chạy trong `vscode/`:

```sh
npx vsce login DuyDatTong
npx vsce publish --packagePath ./review-hub-vscode-0.3.4.vsix
```

Thay tên file ví dụ bằng gói vừa build. Chỉ dùng 0.3.4 trên Marketplace nếu chưa từng phát hành version đó ở đây. Việc tạo tài khoản, nhập thông tin đăng nhập và đăng bản phát hành được thực hiện thủ công; build VSIX chưa phải publish.

## GitHub Releases

Workflow `.github/workflows/release.yml` kiểm tra và đóng gói khi push main. **Tag phiên bản mới** (`vX.Y.Z`, khớp version các package) hoặc chạy workflow thủ công sẽ tạo GitHub Release gồm VSIX, tarball MCP và SHA256. Có thể bật đóng gói JetBrains khi chạy thủ công.

Trước khi kích hoạt, commit các thay đổi đã review, chọn version chưa dùng và kiểm tra workflow. Chạy thủ công cũng dùng version trong manifest; không chạy với tag đã phát hành để đưa code mới lên. Workflow không tự publish Marketplace hoặc npm.

## npm (MCP độc lập, tùy chọn)

VSIX đã kèm MCP, nên người dùng extension không cần bản npm. Để phát hành `review-hub-mcp`, xác nhận quyền sở hữu package, đăng nhập cục bộ và bật cơ chế xác thực/2FA mà npm yêu cầu:

```sh
npm login
npm whoami
npm run build:mcp
npm run pack:mcp
npm publish ./mcp/review-hub-mcp-0.3.4.tgz --access public
```

Thay tên file bằng tarball mới và kiểm tra nội dung trước khi publish. Nếu tên package chưa có người dùng, lần publish thành công đầu tiên sẽ đăng ký tên đó; nếu đã có, bạn cần quyền sở hữu hoặc đổi tên. Không thể ghi đè một version npm đã phát hành, nên mỗi lần cần version mới. Không đưa thông tin đăng nhập npm vào repository.

## Sau khi phát hành

Kiểm tra link công khai, cài mới trên máy khác và xác nhận tool MCP khớp extension. Cập nhật link website/README khi Marketplace đã hoạt động. Website lấy GitHub Release mới nhất, không lấy bản build cục bộ chưa phát hành.
