const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "liquid:" && location.host === "ui" && location.pathname === "/proxy/index.html") {
  contextBridge.exposeInMainWorld("dripProxy", Object.freeze({
    closeCenter: () => ipcRenderer.invoke("proxy:close-center"),
    windowAction: action => ipcRenderer.invoke("proxy:window-action", action),
    nodeStatus: () => ipcRenderer.invoke("proxy:node-status"),
    nodes: () => ipcRenderer.invoke("proxy:nodes"),
    status: () => ipcRenderer.invoke("proxy:status"),
    onStatus: listener => {
      const handler = (_event, status) => listener(status);
      ipcRenderer.on("proxy:status-changed", handler);
      return () => ipcRenderer.removeListener("proxy:status-changed", handler);
    },
    stats: () => ipcRenderer.invoke("proxy:stats"),
    rules: () => ipcRenderer.invoke("proxy:rules"),
    logs: () => ipcRenderer.invoke("proxy:logs"),
    delay: nodeId => ipcRenderer.invoke("proxy:delay", nodeId),
    start: options => ipcRenderer.invoke("proxy:start", options),
    stop: () => ipcRenderer.invoke("proxy:stop"),
    importJapan: () => ipcRenderer.invoke("proxy:import-japan"),
    subscriptions: () => ipcRenderer.invoke("proxy:subscriptions"),
    addSubscription: (url, name) => ipcRenderer.invoke("proxy:add-subscription", url, name),
    refreshSubscription: id => ipcRenderer.invoke("proxy:refresh-subscription", id),
    removeSubscription: id => ipcRenderer.invoke("proxy:remove-subscription", id)
  }));
}
