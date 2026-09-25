const { contextBridge, ipcRenderer } = require("electron");

// 仅对内部 liquid:// 页面暴露外观/设置 IPC 桥，避免污染任意外部网站。
if (location.protocol === "liquid:") {
  contextBridge.exposeInMainWorld("liquidHome", Object.freeze({
    setAppearance: settings => ipcRenderer.invoke("home:set-appearance", settings),
    getSettings: () => ipcRenderer.invoke("settings:get"),
    updateSetting: (key, value) => ipcRenderer.invoke("browser:update-setting", key, value),
    chooseDownloadPath: () => ipcRenderer.invoke("browser:set-download-path"),
    clearCache: () => ipcRenderer.invoke("browser:clear-cache"),
    openAppearance: () => ipcRenderer.invoke("browser:open-appearance"),
    openProxyCenter: () => ipcRenderer.invoke("browser:open-proxy-center"),
    goHome: () => ipcRenderer.invoke("browser:home")
  }));
}
