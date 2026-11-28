const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workbench", {
  call: (action, payload) =>
    ipcRenderer.invoke("workbench:action", action, payload),
  onDialog: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("workbench:dialog", listener);
    return () => ipcRenderer.removeListener("workbench:dialog", listener);
  },
  replyDialog: (id, response) =>
    ipcRenderer.send("workbench:dialog-reply", { id, response }),
  onChanged: (callback) => {
    const listener = (_event, revision, gitChanged) => callback(revision, gitChanged);
    ipcRenderer.on("workbench:changed", listener);
    return () => ipcRenderer.removeListener("workbench:changed", listener);
  },
  onNavigate: (callback) => {
    const listener = (_event, destination) => callback(destination);
    ipcRenderer.on("workbench:navigate", listener);
    return () => ipcRenderer.removeListener("workbench:navigate", listener);
  },
  onGitDiff: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("workbench:git-diff", listener);
    return () => ipcRenderer.removeListener("workbench:git-diff", listener);
  },
  onDiffHistory: (callback) => {
    const listener = (_event, direction) => callback(direction);
    ipcRenderer.on("workbench:diff-history", listener);
    return () => ipcRenderer.removeListener("workbench:diff-history", listener);
  },
  onCommitDraft: (callback) => {
    const listener = (_event, draft) => callback(draft);
    ipcRenderer.on("workbench:commit-draft", listener);
    return () => ipcRenderer.removeListener("workbench:commit-draft", listener);
  },
  onEditorLsp: (callback) => {
    const listener = (_event, method, params) => callback(method, params);
    ipcRenderer.on("workbench:editor-lsp", listener);
    return () => ipcRenderer.removeListener("workbench:editor-lsp", listener);
  },
  onEditorDisk: (callback) => {
    const listener = (_event, file) => callback(file);
    ipcRenderer.on("workbench:editor-disk", listener);
    return () => ipcRenderer.removeListener("workbench:editor-disk", listener);
  },
  onEditorHistory: (callback) => {
    const listener = (_event, direction) => callback(direction);
    ipcRenderer.on("workbench:editor-history", listener);
    return () => ipcRenderer.removeListener("workbench:editor-history", listener);
  },
  onEditorOpen: (callback) => {
    const listener = (_event, target) => callback(target);
    ipcRenderer.on("workbench:editor-open", listener);
    return () => ipcRenderer.removeListener("workbench:editor-open", listener);
  },
  onEditorSearch: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workbench:editor-search", listener);
    return () => ipcRenderer.removeListener("workbench:editor-search", listener);
  },
  setRunLogKeys: (active) =>
    ipcRenderer.sendSync("workbench:run-log-keys", !!active),
  onRunLogCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("workbench:run-log-command", listener);
    return () =>
      ipcRenderer.removeListener("workbench:run-log-command", listener);
  },
});
