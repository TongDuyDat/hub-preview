# Publishing Review Hub

[English](PUBLISHING.md) | [Tiếng Việt](PUBLISHING.vi.md) · [README](README.md)

## Prepare a release

Use Node.js 22.13 or newer. From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run package:vscode
npm run pack:mcp
```

Inspect the generated VSIX in `vscode/` and npm tarball in `mcp/`. Install the VSIX in a test window and check agent registration, inline review, Accept/Reject and reconnection. Review the English/Vietnamese READMEs, icon, changelog, license and package metadata.

Keep versions aligned in root, core, mcp and vscode package.json files and the lockfile when preparing a new release. Update CHANGELOG.md and vscode/CHANGELOG.md. Published versions/tags must be unique; **v0.3.4 already exists on GitHub**. Do not reuse or overwrite it for newer source changes.

## Register a VS Code Marketplace publisher

1. Sign in with a Microsoft account at [Manage Publishers](https://marketplace.visualstudio.com/manage).
2. Create a publisher. This project uses Publisher ID **DuyDatTong**, matching `vscode/package.json`. Confirm you own that exact ID before publishing. If it is unavailable, choose an available ID and update the manifest before rebuilding.
3. Complete the publisher's required profile/contact fields. A verified domain is optional for initial publishing.
4. Under your publisher, choose **New extension → Visual Studio Code** and upload the newly built VSIX.
5. Wait for validation, inspect the listing and test installation. For later versions, upload a new VSIX with a higher extension version.

Once published, the extension identifier is `DuyDatTong.review-hub-vscode`, and its listing URL will be `https://marketplace.visualstudio.com/items?itemName=DuyDatTong.review-hub-vscode`. These are the expected identifiers, not confirmation of publication.

### Optional CLI publishing

Create an Azure DevOps personal access token with **Marketplace: Manage** scope and **All accessible organizations**, following [Microsoft's publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). Enter the token locally when vsce prompts; never put it in source files, commands committed to Git, or chat.

From `vscode/`:

```sh
npx vsce login DuyDatTong
npx vsce publish --packagePath ./review-hub-vscode-0.3.6.vsix
```

Replace the example filename with the fresh package. Version 0.3.6 must not already be published on Marketplace; use a higher version if it is. Account creation, credential entry and publication are manual actions; building a VSIX does not publish it.

## GitHub Releases

`.github/workflows/release.yml` validates and packages pushes to main. A **new version tag** (`vX.Y.Z`, matching all package versions) or manual workflow run publishes a GitHub Release with VSIX, MCP tarball and SHA256 checksums. JetBrains packaging is optional on manual runs.

Before triggering a release, commit the reviewed changes, choose an unused version and inspect the workflow. Manual runs also target the manifest version; do not run one against an already published tag for new code. The workflow does not publish to Marketplace or npm.

## npm (optional standalone MCP)

The VSIX bundles MCP, so npm publication is not required for extension users. To publish `review-hub-mcp`, confirm npm package ownership, sign in locally and enable the authentication/2FA required by npm:

```sh
npm login
npm whoami
npm run build:mcp
npm run pack:mcp
npm publish ./mcp/review-hub-mcp-0.3.6.tgz --access public
```

Replace the filename with the new tarball and inspect it before publishing. If the package name is unclaimed, the first successful publish registers it; if claimed, you need ownership or a different name. npm versions are immutable, so use a new version for each release. Keep npm credentials out of the repository.

## After publication

Confirm the public installation/download links, check a clean install on another machine and verify that MCP tools match the extension. Update website/README links once the Marketplace listing is live. The website resolves the latest GitHub Release separately; it does not track unpublished local builds.
