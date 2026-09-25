// 扩展 API 兼容层预加载脚本（自研轻量实现，无 GPL 依赖）。
//
// Electron 自带扩展系统只提供了 chrome.runtime / chrome.storage / chrome.scripting，
// 缺少多标签相关的 chrome.tabs 与 chrome.windows。本脚本利用 session 级 preload 注入到
// 扩展自身的页面（背景页 / 弹窗等 chrome-extension: 页面），把这两种 API 补齐，
// 所有数据与操作都通过 IPC 映射到主进程的 createTab/activateTab/closeTab 等原生逻辑，
// 事件则从主进程反向广播回扩展页面。普通网页（http/https）与 liquid: 页面一律跳过，避免污染。
const { contextBridge, ipcRenderer, webFrame } = require("electron");

// 仅对扩展自身页面生效（MV2 背景页 / 扩展弹窗 / 扩展设置页等）。
// MV3 后台 service worker 不经过 frame preload，本版本通过 frame 注入覆盖多数落地扩展场景。
if (location.protocol !== "chrome-extension:") return;

// 供主世界 shim 使用的最小桥：请求主进程 + 订阅主进程广播的事件。
contextBridge.exposeInMainWorld("__dripExtBridge", Object.freeze({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  listen: listener => {
    ipcRenderer.on("ext:api-event", (_event, channel, payload) => {
      try { listener(channel, payload); } catch {}
    });
  }
}));

// 主世界 shim：把 chrome.tabs / chrome.windows 安装到现有的 window.chrome 上。
// 刻意不覆盖 chrome.runtime / chrome.storage，避免破坏 Electron 已提供的能力。
// eslint-disable-next-line no-useless-escape
const SHIM = `(function () {
  function makeEvent() {
    var listeners = [];
    return {
      addListener: function (fn) { if (typeof fn === "function") listeners.push(fn); },
      removeListener: function (fn) { listeners = listeners.filter(function (f) { return f !== fn; }); },
      hasListener: function (fn) { return listeners.indexOf(fn) !== -1; },
      dispatch: function () {
        var args = Array.prototype.slice.call(arguments);
        listeners.slice().forEach(function (fn) { try { fn.apply(null, args); } catch (e) {} });
      }
    };
  }
  function install() {
    var bridge = window.__dripExtBridge;
    var chrome = window.chrome;
    if (!bridge || !chrome) { setTimeout(install, 40); return; }

    var tabs = {
      onCreated: makeEvent(),
      onUpdated: makeEvent(),
      onActivated: makeEvent(),
      onRemoved: makeEvent(),
      onReplaced: makeEvent(),
      onAttached: makeEvent(),
      onDetached: makeEvent(),
      query: function (queryInfo) { return bridge.invoke("ext:tabs-query", { queryInfo: queryInfo || {} }); },
      get: function (tabId) { return bridge.invoke("ext:tabs-get", { tabId: Number(tabId) }); },
      getCurrent: function () { return bridge.invoke("ext:tabs-get-current", {}); },
      create: function (props) { return bridge.invoke("ext:tabs-create", { props: props || {} }); },
      update: function (tabId, props) { return bridge.invoke("ext:tabs-update", { tabId: Number(tabId), props: props || {} }); },
      remove: function (tabIds) { return bridge.invoke("ext:tabs-remove", { tabIds: [].concat(tabIds).map(Number) }); },
      reload: function (tabId) { return bridge.invoke("ext:tabs-reload", { tabId: Number(tabId) }); },
      duplicate: function (tabId) { return bridge.invoke("ext:tabs-duplicate", { tabId: Number(tabId) }); }
    };

    var windows = {
      getCurrent: function () { return bridge.invoke("ext:windows-get-current", {}); },
      getLastFocused: function () { return bridge.invoke("ext:windows-get-last-focused", {}); },
      get: function (windowId, options) { return bridge.invoke("ext:windows-get", { windowId: Number(windowId), options: options || {} }); },
      getAll: function (options) { return bridge.invoke("ext:windows-get-all", { options: options || {} }); },
      create: function (props) { return bridge.invoke("ext:windows-create", { props: props || {} }); },
      update: function (windowId, props) { return bridge.invoke("ext:windows-update", { windowId: Number(windowId), props: props || {} }); },
      remove: function (windowId) { return bridge.invoke("ext:windows-remove", { windowId: Number(windowId) }); }
    };

    // Electron 自带的 chrome.tabs 只跟踪其内部扩展 webContents，无法反映浏览器真实标签，
    // 因此这里强制用主进程驱动的实现覆盖它，让扩展能看到并操作 Drip 的真实标签页。
    try {
      Object.defineProperty(chrome, "tabs", { configurable: true, enumerable: true, writable: true, value: tabs });
      Object.defineProperty(chrome, "windows", { configurable: true, enumerable: true, writable: true, value: windows });
    } catch (e) {
      try { chrome.tabs = tabs; } catch (e2) {}
      try { chrome.windows = windows; } catch (e2) {}
    }

    bridge.listen(function (channel, payload) {
      if (channel === "tabs.created") {
        if (payload && payload.tab) tabs.onCreated.dispatch(payload.tab);
      } else if (channel === "tabs.updated") {
        if (payload) tabs.onUpdated.dispatch(payload.tabId, payload.changeInfo || {}, payload.tab || {});
      } else if (channel === "tabs.activated") {
        if (payload) tabs.onActivated.dispatch({ tabId: payload.tabId, windowId: payload.windowId });
      } else if (channel === "tabs.removed") {
        if (payload) tabs.onRemoved.dispatch(payload.tabId, { windowId: payload.windowId, isWindowClosing: false });
      }
    });
    try { delete window.__dripExtBridge; } catch (e) {}
  }
  install();
})();`;

webFrame.executeJavaScript(SHIM).catch(() => {});
