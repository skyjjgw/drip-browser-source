const { contextBridge } = require("electron");

const state = {
  tabs: [{ id: 1, title: "新标签页", url: "liquid://home/index.html", displayUrl: "", canGoBack: false, canGoForward: false }],
  activeTabId: 1,
  connection: { state: "connected", label: "已连接", detail: "测试" },
  appearance: {},
  window: { isMaximized: false },
  modules: { account: { status: "signed-out" }, updates: { status: "idle" }, site: { local: true } },
  browserRoute: { selected: { mode: "default" }, nodes: [], error: null }
};
let stateListener = () => {};
contextBridge.exposeInMainWorld("liquidBrowser", {
  getState: () => Promise.resolve(state),
  onState: listener => { stateListener = listener; },
  mockAccount: account => { state.modules.account = account; stateListener(state); },
  mockNodes: nodes => { state.browserRoute.nodes = nodes; stateListener(state); },
  onFocusAddress: () => {},
  onOpenModule: () => {},
  onOpenFind: () => {},
  onFindResult: () => {},
  setOverlayOpen: open => { globalThis.routeOverlayOpen = open; },
  setBrowserRoute: route => { state.browserRoute.selected = route; return Promise.resolve(state.browserRoute); }
});
