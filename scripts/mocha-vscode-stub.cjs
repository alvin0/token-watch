/**
 * Minimal `vscode` stub for running the pure/property suites in plain Node.
 *
 * These suites test parsers, the store, analytics and small host controllers —
 * none of them need a real Extension Host. Running them inside one made VS Code
 * report the host as unresponsive and slowed every local run, so `npm run
 * test:unit` runs them under bare mocha with this stub registered ahead of
 * `require("vscode")`. Anything that genuinely needs the host lives in
 * `src/test/integration` and still runs through `@vscode/test-cli`.
 *
 * Only the surface the host controllers touch is implemented. A missing member
 * throws with a clear message rather than returning undefined, so a test that
 * grows a new dependency on the real API fails loudly instead of silently.
 */

const Module = require("node:module");

class Disposable {
  constructor(callOnDispose) {
    this._callOnDispose = callOnDispose;
  }
  dispose() {
    this._callOnDispose?.();
  }
  static from(...disposables) {
    return new Disposable(() => {
      for (const disposable of disposables) {
        disposable?.dispose?.();
      }
    });
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener, thisArg, disposables) => {
      const bound = thisArg ? listener.bind(thisArg) : listener;
      this._listeners.add(bound);
      const subscription = new Disposable(() => this._listeners.delete(bound));
      disposables?.push(subscription);
      return subscription;
    };
  }
  fire(value) {
    for (const listener of [...this._listeners]) {
      listener(value);
    }
  }
  dispose() {
    this._listeners.clear();
  }
}

/** Messages shown during a unit run; tests may inspect and clear this. */
const shownMessages = [];

const vscodeStub = {
  Disposable,
  EventEmitter,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  Uri: {
    file: (fsPath) => ({ fsPath, scheme: "file", path: fsPath, toString: () => fsPath }),
    joinPath: (base, ...parts) => vscodeStub.Uri.file([base.fsPath, ...parts].join("/")),
  },
  env: { language: "en" },
  window: {
    showInformationMessage: (message) => record("info", message),
    showWarningMessage: (message) => record("warning", message),
    showErrorMessage: (message) => record("error", message),
    createStatusBarItem: () => ({
      text: "",
      tooltip: "",
      command: undefined,
      show() {},
      hide() {},
      dispose() {},
    }),
    registerWebviewViewProvider: () => new Disposable(),
    onDidChangeActiveColorTheme: new EventEmitter().event,
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      inspect: () => undefined,
      update: async () => undefined,
    }),
    onDidChangeConfiguration: new EventEmitter().event,
  },
  commands: {
    registerCommand: () => new Disposable(),
    executeCommand: async () => undefined,
  },
  extensions: { getExtension: () => undefined },
  __shownMessages: shownMessages,
};

function record(level, message) {
  shownMessages.push({ level, message });
  return Promise.resolve(undefined);
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

module.exports = vscodeStub;
