/**
 * Shared HTML templating for both webviews. The HTML lives in `media/*.html` so it is
 * syntax-highlighted and editable, with four placeholders substituted at render time:
 * `${cspSource}`, `${nonce}`, `${styleUri}`, `${scriptUri}`.
 *
 * The CSP is strict — no inline script, no remote origins — and the script tag carries a
 * per-render nonce. `localResourceRoots` is narrowed to `media/` by each caller.
 */
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  files: { html: string; css: string; js: string },
): string {
  const nonce = randomBytes(16).toString("base64");
  const asset = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name)).toString();
  const template = fs.readFileSync(vscode.Uri.joinPath(extensionUri, "media", files.html).fsPath, "utf8");
  return template
    .replace(/\$\{cspSource\}/g, webview.cspSource)
    .replace(/\$\{nonce\}/g, nonce)
    .replace(/\$\{styleUri\}/g, asset(files.css))
    .replace(/\$\{scriptUri\}/g, asset(files.js));
}
