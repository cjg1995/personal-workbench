const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workbench", {
  call: (action, payload) =>
    ipcRenderer.invoke("workbench:action", action, payload),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("workbench:changed", listener);
    return () => ipcRenderer.removeListener("workbench:changed", listener);
  },
  onReviewProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("workbench:review-progress", listener);
    return () =>
      ipcRenderer.removeListener("workbench:review-progress", listener);
  },
  onNavigate: (callback) => {
    const listener = (_event, destination) => callback(destination);
    ipcRenderer.on("workbench:navigate", listener);
    return () => ipcRenderer.removeListener("workbench:navigate", listener);
  },
});
