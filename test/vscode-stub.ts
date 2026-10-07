/**
 * Minimal VS Code surface for tests. Extends the dsh stub with the APIs Review Hub
 * uses: TreeView, FileSystemWatcher, TextDocumentContentProvider, CodeLens, tabGroups.
 */
function envJson(name: string): Record<string, unknown> {
  try {
    const raw = process.env[name];
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const log: string[] = [];
const messages: string[] = [];
const commands = new Map<string, ((...args: never[]) => unknown)[]>();
const contentProviders = new Map<string, unknown>();

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(value: T): void {
    for (const l of this.listeners) {
      l(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

class ThemeIcon {
  constructor(readonly id: string) {}
}

class TreeItem {
  label: string;
  collapsibleState?: number;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  resourceUri?: unknown;
  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const stub = {
  __log: log,
  __messages: messages,
  __commands: commands,
  __contentProviders: contentProviders,
  EventEmitter,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  CodeLens: class {
    constructor(readonly range: unknown, readonly command?: unknown) {}
  },
  Range: class {
    constructor(readonly startLine: number, readonly startChar: number, readonly endLine: number, readonly endChar: number) {}
  },
  Position: class {
    constructor(readonly line: number, readonly character: number) {}
  },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => log.push(line),
      show: () => {},
      dispose: () => {},
    }),
    showErrorMessage: async (message: string) => {
      messages.push(message);
      return undefined;
    },
    showInformationMessage: async (message: string) => {
      messages.push(message);
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      messages.push(message);
      return undefined;
    },
    showQuickPick: async (items: unknown) => items,
    createStatusBarItem: () => ({
      text: "",
      tooltip: "",
      command: "",
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    createTextEditorDecorationType: () => ({ dispose: () => {} }),
    get visibleTextEditors() {
      return [];
    },
    showTextDocument: async (doc: unknown) => ({ document: doc, setDecorations: () => {} }),
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose: () => {} }),
    onDidChangeWindowState: () => ({ dispose: () => {} }),
    get state() {
      return { focused: true };
    },
    createTreeView: () => ({ dispose: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    registerFileDecorationProvider: () => ({ dispose: () => {} }),
    get activeTextEditor() {
      return undefined;
    },
    get tabGroups() {
      return { all: [], close: async () => true };
    },
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  commands: {
    registerCommand: (id: string, cb: (...args: never[]) => unknown) => {
      const handlers = commands.get(id) ?? [];
      handlers.push(cb);
      commands.set(id, handlers);
      return {
        dispose: () => {
          commands.set(id, (commands.get(id) ?? []).filter((handler) => handler !== cb));
        },
      };
    },
    executeCommand: async () => undefined,
  },
  workspace: {
    getConfiguration: () => {
      const config = envJson("VSCODE_STUB_CONFIG");
      return {
        get: <T>(key: string, fallback: T): T => (key in config ? (config[key] as T) : fallback),
      };
    },
    get workspaceFolders() {
      const folders = envJson("VSCODE_STUB_WORKSPACE");
      return Array.isArray(folders) ? folders : [];
    },
    getWorkspaceFolder: (uri: { fsPath: string }) => {
      const folders = stub.workspace.workspaceFolders as { uri: { fsPath: string } }[];
      return folders.find((folder) => folder.uri.fsPath === uri.fsPath) ?? folders[0];
    },
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
      contentProviders.set(scheme, provider);
      return { dispose: () => contentProviders.delete(scheme) };
    },
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose: () => {} }),
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    openTextDocument: async (uri: unknown) => ({
      uri,
      lineCount: 1,
      lineAt: () => ({ range: {} }),
      getText: () => "",
    }),
    applyEdit: async () => true,
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
    },
  },
  languages: {
    registerCodeLensProvider: () => ({ dispose: () => {} }),
  },
  env: {
    asExternalUri: async (uri: { toString(): string }) => uri,
    openExternal: async () => true,
    clipboard: { writeText: async () => {}, readText: async () => "" },
  },
  Uri: {
    parse: (value: string) => ({
      scheme: value.split(":")[0] ?? "",
      authority: value.includes("://") ? value.split("://")[1].split("/")[0] : "",
      path: value.includes("://") ? "/" + value.split("://")[1].split("/").slice(1).join("/") : value,
      toString: () => value,
      fsPath: value.replace(/^\/?\/?/, ""),
    }),
    file: (value: string) => ({
      scheme: "file",
      authority: "",
      path: value,
      fsPath: value,
      toString: () => `file://${value}`,
    }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      scheme: "file",
      path: [base.fsPath, ...parts].join("/"),
      fsPath: [base.fsPath, ...parts].join("/"),
      toString: () => `file://${[base.fsPath, ...parts].join("/")}`,
    }),
  },
  ViewColumn: { Active: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
};

export = stub;
