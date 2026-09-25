const api = window.liquidBrowser;

const tabsElement = document.getElementById("tabs");
const addressInput = document.getElementById("address");
const addressForm = document.getElementById("addressForm");
const loadingIndicator = document.getElementById("loading");
const connectionIndicator = document.getElementById("connectionIndicator");
const chromeBackdropVideo = document.getElementById("chromeBackdropVideo");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const reloadButton = document.getElementById("reload");
const bookmarkButton = document.getElementById("bookmarkPage");
const siteSecurityButton = document.getElementById("siteSecurity");
const profileInitial = document.getElementById("profileInitial");
const profileButton = document.getElementById("profileButton");
const themeButton = document.getElementById("themeButton");
const appearanceButton = document.getElementById("appearanceButton");
const downloadsButton = document.getElementById("downloadsButton");
const updatePrompt = document.getElementById("updatePrompt");
const updatePromptVersion = document.getElementById("updatePromptVersion");
const updatePromptDetails = document.getElementById("updatePromptDetails");
const updatePromptDownload = document.getElementById("updatePromptDownload");
const maximizeButton = document.getElementById("maximizeWindow");
const moduleOverlay = document.getElementById("moduleOverlay");
const moduleTitle = document.getElementById("moduleTitle");
const moduleContent = document.getElementById("moduleContent");
const findBar = document.getElementById("findBar");
const findInput = document.getElementById("findInput");
const findResult = document.getElementById("findResult");
const browserRouteButton = document.getElementById("browserRouteButton");
const browserRouteOverlay = document.getElementById("browserRouteOverlay");
const browserRouteOptions = document.getElementById("browserRouteOptions");
const browserRouteForm = document.getElementById("browserRouteForm");
const browserRouteError = document.getElementById("browserRouteError");

let currentState = null;
let activeModule = null;
let accountFormMode = "login";
let dismissedUpdateVersion = null;
let dragTabId = null;
let editingBookmarkId = null;
let historySearchQuery = "";
let historySearchResults = null;
let suggestionItems = [];
let suggestionIndex = -1;
let suggestionToken = 0;
let suggestionTimer = null;
let bookmarkSearchQuery = "";
let showPasswordForm = false;
let clearDataRange = "all";
let downloadTab = "active";
let historyRange = "all";
const clearDataTypes = { history: true, cache: true, cookies: true, siteData: true, downloads: false, passwords: false, permissions: false };
const revealedPasswordIds = new Set();

const moduleTitles = {
  menu: "浏览器菜单",
  profile: "Drip 账号",
  bookmarks: "书签",
  history: "历史记录",
  downloads: "下载内容",
  extensions: "扩展程序",
  site: "网站信息",
  about: "关于 Drip",
  passwords: "密码管理器",
  "clear-data": "清除浏览数据"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function formatDayLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return "今天";
  if (sameDay(date, yesterday)) return "昨天";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function filterBookmarkItems(items, query) {
  if (!query || !items || !items.length) return items || [];
  const lower = query.toLowerCase();
  const matches = item => (item.title || "").toLowerCase().includes(lower) || (item.url || "").toLowerCase().includes(lower);
  const filtered = [];
  for (const item of items) {
    if (item.type === "folder") {
      const children = filterBookmarkItems(item.children || [], query);
      if (matches(item) || children.length) filtered.push({ ...item, children });
    } else if (matches(item)) {
      filtered.push(item);
    }
  }
  return filtered;
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function showModuleToast(text) {
  const existing = moduleContent.querySelector(".module-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "module-toast";
  toast.textContent = text;
  moduleContent.appendChild(toast);
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, 1600);
}

function renderTabs(state) {
  tabsElement.replaceChildren();
  for (const tab of state.tabs) {
    const item = document.createElement("div");
    item.className = `tab${tab.id === state.activeTabId ? " is-active" : ""}`;
    if (tab.pinned) item.classList.add("is-pinned");
    item.dataset.tabId = String(tab.id);
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", String(tab.id === state.activeTabId));

    const favicon = document.createElement("span");
    favicon.className = "tab-favicon";
    favicon.innerHTML = tab.incognito
      ? '<i data-lucide="eye-off"></i>'
      : tab.url.startsWith("liquid://")
        ? '<i data-lucide="sparkles"></i>'
        : '<i data-lucide="globe-2"></i>';
    if (tab.incognito) item.title = "隐私标签页";

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || "新标签页";

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.title = "关闭标签页";
    close.setAttribute("aria-label", "关闭标签页");
    close.innerHTML = '<i data-lucide="x"></i>';
    close.addEventListener("click", event => {
      event.stopPropagation();
      api.closeTab(tab.id);
    });

    item.append(favicon, title, close);
    item.addEventListener("click", () => api.activateTab(tab.id));
    item.addEventListener("contextmenu", event => {
      event.preventDefault();
      api.showTabMenu(tab.id);
    });
    item.draggable = true;
    item.addEventListener("dragstart", event => {
      dragTabId = tab.id;
      event.dataTransfer.effectAllowed = "move";
      try { event.dataTransfer.setData("text/plain", String(tab.id)); } catch {
      }
      item.classList.add("is-dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("is-dragging");
      const id = dragTabId;
      dragTabId = null;
      if (id === null) return;
      const dragged = tabsElement.querySelector(`[data-tab-id="${id}"]`);
      if (!dragged) return;
      const children = Array.from(tabsElement.querySelectorAll(".tab"));
      api.moveTab(id, children.indexOf(dragged));
    });
    tabsElement.appendChild(item);
  }
}

tabsElement.addEventListener("dragover", event => {
  if (dragTabId === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const dragged = tabsElement.querySelector(`[data-tab-id="${dragTabId}"]`);
  const target = event.target.closest?.(".tab");
  if (!dragged || !target || target === dragged) return;
  const rect = target.getBoundingClientRect();
  if (event.clientX > rect.left + rect.width / 2) target.after(dragged);
  else target.before(dragged);
});
tabsElement.addEventListener("drop", event => event.preventDefault());

function applyAppearance(state) {
  const appearance = state?.appearance;
  if (!appearance) return;
  const root = document.documentElement;
  if (appearance.chromeGlass) {
    root.style.setProperty("--chrome-glass-color", appearance.chromeGlassColor);
    const glassOpacity = Math.max(0.08, 0.76 - (appearance.chromeGlassAlpha / 100) * 0.62);
    root.style.setProperty("--chrome-glass-alpha", String(glassOpacity));
    root.style.setProperty("--chrome-blur", appearance.chromeBlur + "px");
  } else {
    root.style.setProperty("--chrome-glass-alpha", "0.92");
    root.style.setProperty("--chrome-blur", "0px");
  }
  root.dataset.theme = appearance.theme;
  document.body.dataset.background = appearance.background;
  root.style.setProperty("--chrome-bg-blur", appearance.bgBlur + "px");
  root.style.setProperty("--chrome-bg-scale", String(1 + appearance.bgBlur * 0.006));
}

function closeUpdatePrompt() {
  dismissedUpdateVersion = currentState?.modules?.updates?.latestVersion || null;
  updatePrompt.hidden = true;
  api.setOverlayOpen(Boolean(activeModule || !browserRouteOverlay.hidden));
}

function showUpdatePrompt() {
  const update = currentState?.modules?.updates || {};
  if (update.status !== "available") return;
  if (activeModule) closeModule();
  closeBrowserRouteMenu();
  updatePromptVersion.textContent = `Drip ${update.latestVersion || "新版本"}`;
  updatePrompt.hidden = false;
  api.setOverlayOpen(true);
  refreshIcons();
}

function maybeShowUpdatePrompt(previousState, state) {
  const update = state.modules?.updates || {};
  const previousUpdate = previousState?.modules?.updates || {};
  if (update.status === "available" && update.latestVersion !== dismissedUpdateVersion &&
      (previousUpdate.status !== "available" || previousUpdate.latestVersion !== update.latestVersion)) {
    showUpdatePrompt();
  }
}

function render(state) {
  const previousState = currentState;
  currentState = state;
  renderBrowserRoutes();
  applyAppearance(state);
  renderTabs(state);

  const active = state.tabs.find(tab => tab.id === state.activeTabId);
  const isHome = Boolean(active?.url?.startsWith("liquid://home/"));
  document.body.classList.toggle("is-home", isHome);
  document.body.classList.toggle("is-remote", !isHome);
  if (isHome || currentState?.appearance?.background !== "video") {
    chromeBackdropVideo.pause();
  } else {
    chromeBackdropVideo.play().catch(() => {});
  }
  if (document.activeElement !== addressInput) addressInput.value = active?.displayUrl || "";
  backButton.disabled = !active?.canGoBack;
  forwardButton.disabled = !active?.canGoForward;
  loadingIndicator.classList.toggle("is-visible", Boolean(active?.isLoading));
  reloadButton.title = active?.isLoading ? "停止" : "刷新";
  reloadButton.innerHTML = active?.isLoading ? '<i data-lucide="x"></i>' : '<i data-lucide="rotate-cw"></i>';
  bookmarkButton.classList.toggle("is-active", Boolean(active?.isBookmarked));
  bookmarkButton.title = active?.isBookmarked ? "取消收藏" : "收藏此页";
  connectionIndicator.className = `connection-indicator is-${state.connection.state}`;
  connectionIndicator.title = state.connection.detail || state.connection.label;
  connectionIndicator.setAttribute("aria-label", state.connection.detail || state.connection.label);

  const site = state.modules?.site;
  siteSecurityButton.className = `site-security ${site?.secure ? "is-secure" : "is-insecure"}`;
  siteSecurityButton.title = site?.local ? "Drip 本地主页" : `${site?.hostname || "网站"} · ${site?.secure ? "连接安全" : "连接不安全"}`;
  siteSecurityButton.innerHTML = site?.local
    ? '<i data-lucide="house"></i>'
    : site?.secure ? '<i data-lucide="lock-keyhole"></i>' : '<i data-lucide="triangle-alert"></i>';

  themeButton.innerHTML = state.appearance?.theme === "light"
    ? '<i data-lucide="moon"></i>'
    : '<i data-lucide="sun"></i>';
  const account = state.modules?.account;
  const profileName = account?.user?.displayName || "本地用户";
  if (account?.status === "signed-in" && account.user?.avatarData) {
    const avatar = document.createElement("img");
    avatar.src = account.user.avatarData;
    avatar.alt = "";
    profileInitial.replaceChildren(avatar);
  } else {
    profileInitial.textContent = profileName.slice(0, 1).toUpperCase();
  }
  profileButton.classList.toggle("is-signed-in", account?.status === "signed-in");
  profileButton.title = account?.status === "signed-in" ? `${profileName} · Drip 账号` : "登录 Drip 账号";
  maybeShowUpdatePrompt(previousState, state);
  const isMaximized = Boolean(state.window?.isMaximized);
  maximizeButton.title = isMaximized ? "还原" : "最大化";
  maximizeButton.setAttribute("aria-label", isMaximized ? "还原" : "最大化");
  maximizeButton.innerHTML = isMaximized ? '<i data-lucide="copy"></i>' : '<i data-lucide="square"></i>';

  if (activeModule) renderModule();
  refreshIcons();
}

function openModule(name) {
  closeBrowserRouteMenu();
  if (!updatePrompt.hidden) closeUpdatePrompt();
  activeModule = moduleTitles[name] ? name : "menu";
  if (name === "history") {
    historySearchQuery = "";
    historySearchResults = null;
  }
  if (name === "bookmarks") bookmarkSearchQuery = "";
  if (name === "passwords") {
    showPasswordForm = false;
    revealedPasswordIds.clear();
  }
  if (name === "downloads") downloadTab = "active";
  moduleOverlay.hidden = false;
  api.setOverlayOpen(true);
  renderModule();
}

function closeModule() {
  activeModule = null;
  moduleOverlay.hidden = true;
  api.setOverlayOpen(!updatePrompt.hidden || !browserRouteOverlay.hidden);
}

function closeBrowserRouteMenu() {
  if (browserRouteOverlay.hidden) return;
  browserRouteOverlay.hidden = true;
  browserRouteButton.setAttribute("aria-expanded", "false");
  browserRouteForm.hidden = true;
  browserRouteError.hidden = true;
  api.setOverlayOpen(Boolean(activeModule || !updatePrompt.hidden));
}

function addBrowserRouteOption(group, label, detail, icon, route, selected) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `browser-route-option${selected ? " selected" : ""}`;
  button.dataset.route = JSON.stringify(route);
  button.setAttribute("aria-label", `${label}，${detail}`);
  const symbol = document.createElement("i");
  symbol.dataset.lucide = icon;
  const copy = document.createElement("span");
  copy.className = "browser-route-copy";
  const title = document.createElement("strong");
  title.textContent = label;
  const sub = document.createElement("small");
  sub.textContent = detail;
  copy.append(title, sub);
  const check = document.createElement("i");
  check.dataset.lucide = "check";
  check.className = "browser-route-check";
  button.append(symbol, copy, check);
  group.append(button);
}

function renderBrowserRoutes() {
  const state = currentState?.browserRoute;
  if (!state) return;
  const selected = state.selected || { mode: "default" };
  const selectedNode = state.nodes?.find(node => node.id === selected.nodeId);
  const label = selected.mode === "node" || selected.mode === "managed" ? (selectedNode?.name || "节点不可用")
    : selected.mode === "manual" ? `${selected.protocol.toUpperCase()} ${selected.host}:${selected.port}`
    : { default: "Drip 默认线路", direct: "直连", system: "跟随系统代理" }[selected.mode];
  browserRouteButton.title = `浏览器代理：${label}${state.error ? ` · ${state.error}` : ""}`;
  browserRouteButton.dataset.mode = selected.mode;
  browserRouteButton.classList.toggle("has-error", Boolean(state.error));
  if (state.error) {
    browserRouteError.textContent = state.error;
    browserRouteError.hidden = false;
  }
  const options = document.createDocumentFragment();
  const caption = value => {
    const element = document.createElement("div");
    element.className = "browser-route-caption";
    element.textContent = value;
    options.append(element);
  };
  caption("线路");
  addBrowserRouteOption(options, "Drip 默认线路", "需要账号及邀请码授权", "route", { mode: "default" }, selected.mode === "default");
  addBrowserRouteOption(options, "直连", "不使用浏览器代理", "globe-2", { mode: "direct" }, selected.mode === "direct");
  addBrowserRouteOption(options, "跟随系统代理", "使用 Windows 当前代理", "monitor", { mode: "system" }, selected.mode === "system");
  const managedNodes = (state.nodes || []).filter(node => node.id.startsWith("managed:"));
  if (managedNodes.length) {
    caption("Drip 授权线路");
    for (const node of managedNodes) {
      addBrowserRouteOption(options, node.name, "账号授权节点", "wifi", { mode: "managed", nodeId: node.id }, selected.mode === "managed" && selected.nodeId === node.id);
    }
  }
  const personalNodes = (state.nodes || []).filter(node => !node.id.startsWith("managed:"));
  if (personalNodes.length) {
    caption("我的订阅");
    for (const node of personalNodes) {
      addBrowserRouteOption(options, node.name, node.source || "Drip 节点", "wifi", { mode: "node", nodeId: node.id }, selected.mode === "node" && selected.nodeId === node.id);
    }
  }
  if (selected.mode === "manual") {
    caption("手动代理");
    addBrowserRouteOption(options, label, "手动添加", "server", selected, true);
  }
  browserRouteOptions.replaceChildren(options);
  refreshIcons();
}

browserRouteButton.addEventListener("click", () => {
  if (!browserRouteOverlay.hidden) return closeBrowserRouteMenu();
  if (activeModule) closeModule();
  if (!updatePrompt.hidden) closeUpdatePrompt();
  renderBrowserRoutes();
  browserRouteOverlay.hidden = false;
  browserRouteButton.setAttribute("aria-expanded", "true");
  api.setOverlayOpen(true);
});
document.getElementById("browserRouteScrim").addEventListener("click", closeBrowserRouteMenu);
browserRouteOptions.addEventListener("click", async event => {
  const button = event.target.closest("[data-route]");
  if (!button) return;
  button.disabled = true;
  try {
    await api.setBrowserRoute(JSON.parse(button.dataset.route));
    closeBrowserRouteMenu();
  } catch (error) {
    browserRouteError.textContent = error.message;
    browserRouteError.hidden = false;
  } finally {
    button.disabled = false;
  }
});
document.getElementById("browserRouteAdd").addEventListener("click", () => {
  browserRouteForm.hidden = !browserRouteForm.hidden;
  browserRouteError.hidden = true;
  if (!browserRouteForm.hidden) browserRouteForm.elements.host.focus();
});
browserRouteForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = browserRouteForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api.setBrowserRoute({
      mode: "manual", protocol: browserRouteForm.elements.protocol.value,
      host: browserRouteForm.elements.host.value, port: Number(browserRouteForm.elements.port.value)
    });
    closeBrowserRouteMenu();
  } catch (error) {
    browserRouteError.textContent = error.message;
    browserRouteError.hidden = false;
  } finally {
    button.disabled = false;
  }
});

function menuMarkup() {
  const active = currentState?.tabs.find(tab => tab.id === currentState.activeTabId);
  const zoom = Math.round((active?.zoomFactor || 1) * 100);
  return `
    <div class="menu-list">
      <button class="menu-row" data-command="new-tab"><i data-lucide="square-plus"></i><span>新建标签页</span><span class="shortcut">Ctrl+T</span></button>
      <button class="menu-row" data-command="new-incognito-tab"><i data-lucide="eye-off"></i><span>新建隐私标签页</span><span class="shortcut">Ctrl+Shift+N</span></button>
      <button class="menu-row" data-command="new-window"><i data-lucide="panels-top-left"></i><span>新建窗口</span><span class="shortcut">Ctrl+N</span></button>
      <button class="menu-row" data-command="reopen-closed" ${currentState?.modules?.recentlyClosed?.length ? "" : "disabled"}><i data-lucide="rotate-ccw"></i><span>重新打开关闭的标签页</span><span class="shortcut">Ctrl+Shift+T</span></button>
      <button class="menu-row" data-command="toggle-bookmark"><i data-lucide="star"></i><span>${active?.isBookmarked ? "取消收藏此页" : "收藏此页"}</span><span class="shortcut">Ctrl+D</span></button>
      <div class="menu-divider"></div>
      <button class="menu-row" data-module="bookmarks"><i data-lucide="bookmark"></i><span>书签</span></button>
      <button class="menu-row" data-module="history"><i data-lucide="history"></i><span>历史记录</span><span class="shortcut">Ctrl+H</span></button>
      <button class="menu-row" data-module="downloads"><i data-lucide="download"></i><span>下载内容</span><span class="shortcut">Ctrl+J</span></button>
      <button class="menu-row" data-module="extensions"><i data-lucide="puzzle"></i><span>扩展程序</span></button>
      <button class="menu-row" data-module="passwords"><i data-lucide="key-round"></i><span>密码管理器</span></button>
      <button class="menu-row" data-module="clear-data"><i data-lucide="eraser"></i><span>清除浏览数据</span></button>
      <div class="menu-divider"></div>
      <button class="menu-row" data-command="find"><i data-lucide="search"></i><span>在网页中查找</span><span class="shortcut">Ctrl+F</span></button>
      <div class="menu-row"><i data-lucide="zoom-in"></i><span>缩放</span><div class="zoom-control"><button class="mini-button" data-command="zoom-out" title="缩小"><i data-lucide="minus"></i></button><span class="zoom-value">${zoom}%</span><button class="mini-button" data-command="zoom-in" title="放大"><i data-lucide="plus"></i></button></div></div>
      <button class="menu-row" data-command="print"><i data-lucide="printer"></i><span>打印</span><span class="shortcut">Ctrl+P</span></button>
      <button class="menu-row" data-command="share"><i data-lucide="share-2"></i><span>分享当前页面</span></button>
      <button class="menu-row" data-command="translate"><i data-lucide="languages"></i><span>翻译此网页</span></button>
      <div class="menu-divider"></div>
      <button class="menu-row" data-command="open-dev-tools"><i data-lucide="code-2"></i><span>开发者工具</span><span class="shortcut">F12</span></button>
      <button class="menu-row" data-command="close-window"><i data-lucide="x"></i><span>关闭窗口</span></button>
      <button class="menu-row" data-command="open-settings"><i data-lucide="settings"></i><span>设置</span></button>
      <button class="menu-row" data-module="about"><i data-lucide="info"></i><span>关于</span></button>
    </div>`;
}

function bookmarkRowMarkup(item, depth) {
  const pad = `padding-left:${10 + depth * 14}px`;
  if (editingBookmarkId === item.id) {
    return `<form class="form-section" data-bookmark-form="${escapeHtml(item.id)}" style="${pad}">
      <label>名称</label>
      <input class="form-input" name="title" maxlength="80" value="${escapeHtml(item.title || "")}" required>
      ${item.type === "folder" ? "" : `<label>网址</label><input class="form-input" name="url" value="${escapeHtml(item.url || "")}">`}
      <div class="form-actions">
        <button class="primary-button" type="submit">保存</button>
        <button class="text-button" type="button" data-cancel-edit="1">取消</button>
      </div>
    </form>`;
  }
  if (item.type === "folder") {
    const children = (item.children || []).map(child => bookmarkRowMarkup(child, depth + 1)).join("");
    return `<div class="data-row" style="${pad}">
      <span class="data-icon"><i data-lucide="folder"></i></span>
      <div class="data-main"><div class="data-title">${escapeHtml(item.title || "文件夹")}</div><div class="data-meta">文件夹 · ${(item.children || []).length} 项</div></div>
      <div class="data-actions">
        <button class="mini-button" data-show-folder="${escapeHtml(item.id)}" title="打开文件夹内容"><i data-lucide="chevron-right"></i></button>
        <button class="mini-button" data-edit-bookmark="${escapeHtml(item.id)}" title="重命名"><i data-lucide="pencil"></i></button>
        <button class="mini-button" data-delete-bookmark="${escapeHtml(item.id)}" title="删除"><i data-lucide="trash-2"></i></button>
      </div>
    </div>${children}`;
  }
  return `<div class="data-row" data-open-url="${escapeHtml(item.url)}" style="${pad}">
    <span class="data-icon"><i data-lucide="globe-2"></i></span>
    <div class="data-main"><div class="data-title">${escapeHtml(item.title || item.url)}</div><div class="data-meta">${escapeHtml(hostLabel(item.url))}</div></div>
    <div class="data-actions">
      <button class="mini-button" data-edit-bookmark="${escapeHtml(item.id)}" title="编辑"><i data-lucide="pencil"></i></button>
      <button class="mini-button" data-delete-bookmark="${escapeHtml(item.id)}" title="删除"><i data-lucide="trash-2"></i></button>
    </div>
  </div>`;
}

function bookmarksMarkup() {
  const items = filterBookmarkItems(currentState?.modules?.bookmarks || [], bookmarkSearchQuery);
  const toolbar = `<div class="module-toolbar">
    <input class="form-input history-search" type="search" placeholder="搜索书签" value="${escapeHtml(bookmarkSearchQuery)}" data-bookmark-search autocomplete="off">
    <span class="spacer"></span>
    <button class="text-button" data-command="add-bookmark-folder"><i data-lucide="folder-plus"></i>新建文件夹</button>
    <button class="text-button" data-command="import-bookmarks"><i data-lucide="upload"></i>导入</button>
    <button class="text-button" data-command="export-bookmarks"><i data-lucide="download"></i>导出</button>
  </div>`;
  if (!items.length) {
    const emptyText = bookmarkSearchQuery ? "没有匹配的书签" : "还没有书签<br>在任意网页按 Ctrl+D 即可收藏";
    return `${toolbar}<div class="empty-state"><div><i data-lucide="bookmark"></i><br>${emptyText}</div></div>`;
  }
  return `${toolbar}<div class="data-list">${items.map(item => bookmarkRowMarkup(item, 0)).join("")}</div>`;
}

function historyMarkup() {
  const searching = historySearchQuery.trim().length > 0;
  const items = searching && historySearchResults ? historySearchResults : currentState?.modules?.history || [];
  const recentlyClosed = currentState?.modules?.recentlyClosed || [];
  const rangeOptions = [["all", "全部时间"], ["hour", "过去1小时"], ["day", "过去24小时"], ["week", "过去7天"], ["month", "过去30天"]];
  const toolbar = `<div class="module-toolbar">
    <input class="form-input history-search" type="search" placeholder="搜索历史记录" value="${escapeHtml(historySearchQuery)}" data-history-search autocomplete="off">
    <span class="spacer"></span>
    <select class="form-input setting-select" data-history-range>${rangeOptions.map(([value, label]) => `<option value="${value}" ${historyRange === value ? "selected" : ""}>${label}</option>`).join("")}</select>
    <button class="text-button" data-command="clear-history-range"><i data-lucide="trash-2"></i>按范围清理</button>
    <button class="text-button" data-command="clear-history"><i data-lucide="eraser"></i>清空</button>
  </div>`;
  const closedMarkup = recentlyClosed.length ? `<div class="settings-group"><h3>最近关闭</h3><div class="data-list">${recentlyClosed.slice(0, 5).map(item => `
    <button class="data-row" data-open-url="${escapeHtml(item.url)}"><span class="data-icon"><i data-lucide="rotate-ccw"></i></span><div class="data-main"><div class="data-title">${escapeHtml(item.title)}</div><div class="data-meta">${escapeHtml(hostLabel(item.url))}</div></div></button>`).join("")}</div></div>` : "";
  if (!items.length) {
    const emptyText = searching ? "没有匹配的浏览记录" : "暂无浏览记录";
    return `${toolbar}${closedMarkup}<div class="empty-state"><div><i data-lucide="history"></i><br>${emptyText}</div></div>`;
  }
  const groups = {};
  const sorted = [...items].sort((a, b) => new Date(b.visitedAt) - new Date(a.visitedAt));
  for (const item of sorted) {
    const key = new Date(item.visitedAt).toDateString();
    (groups[key] ||= []).push(item);
  }
  const groupedMarkup = Object.entries(groups).map(([key, groupItems]) => {
    const label = formatDayLabel(groupItems[0].visitedAt);
    const rows = groupItems.map(item => `
      <div class="data-row">
        <button class="history-open-row" data-open-url="${escapeHtml(item.url)}">
          <span class="data-icon"><i data-lucide="clock-3"></i></span>
          <div class="data-main"><div class="data-title">${escapeHtml(item.title)}</div><div class="data-meta">${escapeHtml(hostLabel(item.url))} · ${formatDate(item.visitedAt)}</div>${searching && item.snippet ? `<div class="data-snippet">${escapeHtml(item.snippet)}</div>` : ""}</div>
        </button>
        <div class="data-actions"><button class="mini-button" data-delete-history="${escapeHtml(item.id)}" title="删除此记录"><i data-lucide="trash-2"></i></button></div>
      </div>`).join("");
    return `<div class="settings-group"><div class="history-day-header">${escapeHtml(label)}</div><div class="data-list">${rows}</div></div>`;
  }).join("");
  const heading = searching ? `搜索结果 · ${items.length} 条` : `浏览记录 · ${items.length} 条`;
  return `${toolbar}${closedMarkup}<div class="settings-group"><h3>${heading}</h3></div>${groupedMarkup}`;
}

function downloadRowMarkup(item) {
  const total = Number(item.totalBytes) || 0;
  const progress = total ? Math.min(100, Math.round((Number(item.receivedBytes) || 0) / total * 100)) : 0;
  const status = item.state === "progressing"
    ? item.paused ? `已暂停 ${progress}%` : `下载中 ${progress}%`
    : item.state === "completed" ? "已完成" : item.state === "cancelled" ? "已取消" : "已中断";
  const id = escapeHtml(item.id);
  const actions = [];
  if (item.state === "progressing") {
    actions.push(item.paused
      ? `<button class="mini-button" data-resume-download="${id}" title="继续下载"><i data-lucide="play"></i></button>`
      : `<button class="mini-button" data-pause-download="${id}" title="暂停下载"><i data-lucide="pause"></i></button>`);
    actions.push(`<button class="mini-button" data-cancel-download="${id}" title="取消"><i data-lucide="x"></i></button>`);
  } else {
    if (item.state !== "completed") actions.push(`<button class="mini-button" data-retry-download="${id}" title="重新下载"><i data-lucide="rotate-ccw"></i></button>`);
    actions.push(`<button class="mini-button" data-show-download="${id}" title="在文件夹中显示"><i data-lucide="folder-search"></i></button>`);
  }
  return `<div class="data-row"><span class="data-icon"><i data-lucide="file-down"></i></span><div class="data-main"><div class="data-title">${escapeHtml(item.filename)}</div><div class="data-meta">${status}${total ? ` · ${formatBytes(total)}` : ""}</div></div><div class="data-actions">${actions.join("")}</div></div>`;
}

function downloadsMarkup() {
  const items = currentState?.modules?.downloads || [];
  const toolbar = '<div class="module-toolbar"><button class="text-button" data-command="open-downloads"><i data-lucide="folder-open"></i>下载文件夹</button><span class="spacer"></span><button class="text-button" data-command="clear-downloads">清除记录</button></div>';
  if (!items.length) return `${toolbar}<div class="empty-state"><div><i data-lucide="download"></i><br>暂无下载内容</div></div>`;
  const active = items.filter(item => item.state === "progressing");
  const completed = items.filter(item => item.state === "completed");
  const other = items.filter(item => item.state !== "progressing" && item.state !== "completed");
  const tabs = [["active", "进行中", active.length], ["completed", "已完成", completed.length], ["other", "其他", other.length]];
  const tabBar = `<div class="download-tabs">${tabs.map(([key, label, count]) => `<button class="download-tab${downloadTab === key ? " is-active" : ""}" data-download-tab="${key}">${label}${count ? ` · ${count}` : ""}</button>`).join("")}</div>`;
  const listItems = downloadTab === "active" ? active : downloadTab === "completed" ? completed : other;
  if (!listItems.length) {
    const emptyText = downloadTab === "active" ? "没有进行中的下载" : downloadTab === "completed" ? "还没有完成的下载" : "没有其他下载记录";
    return `${toolbar}${tabBar}<div class="empty-state"><div><i data-lucide="download"></i><br>${emptyText}</div></div>`;
  }
  return `${toolbar}${tabBar}<div class="data-list">${listItems.map(downloadRowMarkup).join("")}</div>`;
}

function extensionsMarkup() {
  const items = currentState?.modules?.extensions || [];
  const devMode = Boolean(currentState?.modules?.settings?.extensionDevMode);
  const toolbar = '<div class="module-toolbar"><button class="primary-button" data-command="add-extension"><i data-lucide="folder-plus"></i>加载已解压扩展</button></div><label class="setting-toggle"><div><strong>开发者模式</strong><small>加载本地已解压扩展目录；扩展程序不支持从 Chrome 商店直接安装 CRX 文件。</small></div><span class="toggle-control"><input type="checkbox" data-setting="extensionDevMode" ${devMode ? "checked" : ""}><span class="toggle-track"></span></span></label>';
  if (!items.length) return `${toolbar}<div class="empty-state"><div><i data-lucide="puzzle"></i><br>暂无已加载扩展</div></div>`;
  return `${toolbar}<div class="data-list">${items.map(item => `<div class="data-row"><span class="data-icon"><i data-lucide="puzzle"></i></span><div class="data-main"><div class="data-title">${escapeHtml(item.name)}</div><div class="data-meta">版本 ${escapeHtml(item.version || "-")}</div></div><div class="data-actions"><label class="toggle-control" title="${item.enabled === false ? "已停用，点击启用" : "已启用，点击停用"}"><input type="checkbox" data-extension-toggle="${escapeHtml(item.id)}" ${item.enabled === false ? "" : "checked"}><span class="toggle-track"></span></label><button class="mini-button" data-remove-extension="${escapeHtml(item.id)}" title="移除"><i data-lucide="trash-2"></i></button></div></div>`).join("")}</div>`;
}

function profileMarkup() {
  const account = currentState?.modules?.account || { status: "signed-out", busy: false, user: null, error: null };
  if (account.status === "restoring") {
    return '<div class="empty-state"><div><i data-lucide="loader-circle"></i><br>正在恢复账号登录状态</div></div>';
  }
  if (account.status !== "signed-in" || !account.user) {
    const isRegister = accountFormMode === "register";
    const error = account.error ? `<p class="form-message is-error"><i data-lucide="circle-alert"></i>${escapeHtml(account.error)}</p>` : "";
    return `
      <div class="profile-hero">
        <div class="profile-avatar-large"><i data-lucide="user-round"></i></div>
        <div><h3>Drip 账号</h3><p>账号与会话由服务器统一管理</p></div>
      </div>
      <div class="account-tabs" role="tablist">
        <button type="button" class="account-tab${isRegister ? "" : " is-active"}" data-command="account-show-login">登录</button>
        <button type="button" class="account-tab${isRegister ? " is-active" : ""}" data-command="account-show-register">注册</button>
      </div>
      <form class="form-section account-form" data-account-form="${isRegister ? "register" : "login"}">
        <label for="accountUsername">用户名</label>
        <input class="form-input" id="accountUsername" name="username" autocomplete="username" maxlength="32" required>
        ${isRegister ? `<label for="accountDisplayName">显示名称</label><input class="form-input" id="accountDisplayName" name="displayName" autocomplete="nickname" maxlength="24" required>` : ""}
        <label for="accountPassword">密码</label>
        <input class="form-input" id="accountPassword" name="password" type="password" autocomplete="${isRegister ? "new-password" : "current-password"}" minlength="8" maxlength="128" required>
        ${isRegister ? `<label for="accountPasswordConfirm">确认密码</label><input class="form-input" id="accountPasswordConfirm" name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>` : ""}
        ${error}
        <div class="form-actions"><button class="primary-button" type="submit" ${account.busy ? "disabled" : ""}>${account.busy ? "请稍候…" : isRegister ? "创建账号" : "登录"}</button></div>
      </form>
      <p class="status-note">密码仅发送到 Drip 服务器进行加盐哈希校验；当前电脑只保存 Windows 加密后的登录令牌。</p>`;
  }

  const user = account.user;
  const grant = account.entitlement;
  const usage = grant ? `${(grant.usedBytes / 1024 ** 3).toFixed(2)} / ${(grant.quotaBytes / 1024 ** 3).toFixed(0)} GB` : "尚未授权";
  const expiry = grant?.endsAt ? new Date(grant.endsAt * 1000).toLocaleDateString("zh-CN") : "-";
  const created = user.createdAt ? new Date(user.createdAt * 1000).toLocaleDateString("zh-CN") : "-";
  const message = account.error
    ? `<p class="form-message is-error"><i data-lucide="circle-alert"></i>${escapeHtml(account.error)}</p>`
    : account.notice ? `<p class="form-message is-success"><i data-lucide="circle-check"></i>${escapeHtml(account.notice)}</p>` : "";
  return `
    <div class="profile-hero">
      <button class="profile-avatar-large profile-avatar-edit" type="button" data-command="account-avatar-select" title="更换头像" aria-label="更换头像" ${account.busy ? "disabled" : ""}>${user.avatarData ? `<img src="${escapeHtml(user.avatarData)}" alt="">` : escapeHtml(user.displayName.slice(0, 1).toUpperCase())}<span class="avatar-edit-icon"><i data-lucide="camera"></i></span></button>
      <input id="accountAvatarInput" type="file" accept="image/jpeg,image/png,image/webp" hidden>
      <div><h3>${escapeHtml(user.displayName)}</h3><p>@${escapeHtml(user.username)} · 服务器账号已连接</p>${user.avatarData ? `<button class="avatar-remove" type="button" data-command="account-avatar-remove" ${account.busy ? "disabled" : ""}>移除头像</button>` : ""}</div>
    </div>
    <div class="account-meta"><span>账号编号</span><strong>${escapeHtml(user.id)}</strong><span>注册日期</span><strong>${escapeHtml(created)}</strong></div>
    <div class="settings-group"><h3>Drip 线路</h3></div>
    <div class="account-meta"><span>授权状态</span><strong>${grant?.active ? "可用" : "未授权或已失效"}</strong><span>服务器计量</span><strong>${escapeHtml(usage)}</strong><span>到期日期</span><strong>${escapeHtml(expiry)}</strong></div>
    <form class="form-section account-form" data-account-form="redeem"><label for="inviteCode">邀请码</label><input class="form-input" id="inviteCode" name="code" autocomplete="off" maxlength="100" required><div class="form-actions"><button class="primary-button" type="submit" ${account.busy ? "disabled" : ""}>${grant?.active ? "叠加兑换" : "兑换线路"}</button></div></form>
    ${message}
    <form class="form-section account-form" data-account-form="profile">
      <label for="accountDisplayName">显示名称</label>
      <input class="form-input" id="accountDisplayName" name="displayName" maxlength="24" value="${escapeHtml(user.displayName)}" required>
      <div class="form-actions"><button class="primary-button" type="submit" ${account.busy ? "disabled" : ""}>保存资料</button></div>
    </form>
    <div class="settings-group"><h3>账号安全</h3></div>
    <form class="form-section account-form compact-form" data-account-form="password">
      <label for="currentPassword">当前密码</label>
      <input class="form-input" id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" minlength="8" maxlength="128" required>
      <label for="newPassword">新密码</label>
      <input class="form-input" id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
      <div class="form-actions"><button class="text-button" type="submit" ${account.busy ? "disabled" : ""}>更新密码</button></div>
    </form>
    <div class="settings-group"><h3>设备管理</h3><div id="accountDevices" class="device-list"></div><button class="menu-row" data-command="account-revoke-all"><i data-lucide="log-out"></i><span>退出其他所有设备</span></button></div>
    <div class="settings-group"><h3>云同步</h3><button class="menu-row" data-command="account-sync-up"><i data-lucide="upload"></i><span>将设置上传到云端</span></button><button class="menu-row" data-command="account-sync-down"><i data-lucide="download"></i><span>从云端恢复设置</span></button></div>
    <div class="account-footer"><button class="text-button danger-button" type="button" data-command="account-logout"><i data-lucide="log-out"></i>退出登录</button></div>
    <p class="status-note">账号身份与登录会话由服务器统一管理；书签、历史记录和网站 Cookie 仍只保存在这台电脑，设置项可手动同步到云端。</p>`;
}

async function prepareAccountAvatar(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error("请选择不超过 10 MB 的 JPG、PNG 或 WebP 图片");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const side = Math.min(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2,
      side, side, 0, 0, 256, 256);
    for (const quality of [0.88, 0.75, 0.6, 0.45]) {
      const data = canvas.toDataURL("image/jpeg", quality);
      if (data.length <= 90000 && (data.length - "data:image/jpeg;base64,".length) * 0.75 <= 64 * 1024) return data;
    }
    throw new Error("头像压缩后仍超过 64 KB，请换一张图片");
  } finally {
    bitmap.close();
  }
}

async function renderAccountDevices() {
  const container = document.getElementById("accountDevices");
  if (!container) return;
  try {
    const devices = await api.accountDevices();
    if (!container.isConnected) return;
    const current = (devices || []).filter(device => device.current);
    const others = (devices || []).filter(device => !device.current);
    const rows = device => `
      <div class="menu-row device-row">
        <i data-lucide="monitor"></i>
        <div class="device-info"><span>${escapeHtml(device.name)}</span><small>${device.current ? "当前设备" : "上次活跃 " + formatDeviceTime(device.lastSeen)}</small></div>
        ${device.current ? '<span class="shortcut">本机</span>' : `<button type="button" class="text-button danger-button" data-command="account-revoke-device" data-device-id="${escapeHtml(device.deviceId)}">退出</button>`}
      </div>`;
    if (current.length) container.innerHTML = current.map(rows).join("") + (others.length ? `<div class="menu-row"><i data-lucide="monitor"></i><div class="device-info"><span>其他设备</span><small>${others.length} 台已登录</small></div></div>` : "");
    else if (others.length) container.innerHTML = others.map(rows).join("");
    else container.innerHTML = '<div class="menu-row"><i data-lucide="monitor"></i><span>暂无已登录设备</span></div>';
  } catch {
    if (!container.isConnected) return;
    container.innerHTML = '<div class="menu-row"><i data-lucide="monitor"></i><span>设备列表加载失败</span></div>';
  }
}

function formatDeviceTime(ts) {
  if (!ts) return "—";
  const date = new Date(ts * 1000);
  return `${date.toLocaleDateString("zh-CN")} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

function showAccountNotice(text) {
  const account = currentState?.modules?.account || { status: "signed-out" };
  currentState.modules.account = { ...account, notice: text, error: null };
  render(currentState);
  renderModule();
}

function siteMarkup() {
  const site = currentState?.modules?.site || {};
  const permissions = Object.keys(site.permissions || {});
  const permissionLabels = {
    media: "摄像头和麦克风",
    geolocation: "位置信息",
    notifications: "通知",
    "clipboard-read": "读取剪贴板"
  };
  const securityText = site.local ? "浏览器内置页面" : site.secure ? "使用 HTTPS 加密连接" : "此页面未使用安全连接";
  const dataUsage = site.dataUsage || site.cookies || site.storageSize;
  const dataSection = dataUsage
    ? `<div class="account-meta"><span>Cookie / 存储</span><strong>${escapeHtml(dataUsage)}</strong></div>`
    : `<p class="status-note">此网站的数据</p>`;
  return `<div class="site-summary"><h3>${escapeHtml(site.hostname || "网站信息")}</h3><p>${escapeHtml(site.origin || "")}</p><div class="security-line"><i data-lucide="${site.secure ? "shield-check" : "shield-alert"}"></i><span>${securityText}</span></div></div>${site.local ? '<div class="empty-state"><div><i data-lucide="house"></i><br>这是 Drip 的本地主页</div></div>' : `<div class="settings-group"><h3>网站权限</h3>${permissions.length ? permissions.map(permission => `<div class="menu-row"><i data-lucide="key-round"></i><span>${escapeHtml(permissionLabels[permission] || permission)}</span><select class="form-input setting-select site-permission-select" data-site-permission="${escapeHtml(permission)}"><option value="allow" ${site.permissions[permission] ? "selected" : ""}>允许</option><option value="block" ${!site.permissions[permission] ? "selected" : ""}>阻止</option></select></div>`).join("") : '<div class="menu-row"><i data-lucide="shield"></i><span>没有已记住的权限</span></div>'}<button class="menu-row" data-command="reset-site-permissions"><i data-lucide="rotate-ccw"></i><span>重置此网站权限</span></button></div><div class="settings-group"><h3>网站数据</h3>${dataSection}<button class="menu-row" data-command="clear-site-data"><i data-lucide="database-zap"></i><span>清除此网站的数据</span></button></div>`}`;
}

function aboutMarkup() {
  const appInfo = currentState?.app || {};
  const update = currentState?.modules?.updates || {};
  const statusText = {
    idle: "尚未检查更新",
    development: "当前为开发预览版",
    checking: "正在检查服务器版本",
    "up-to-date": "当前已是最新版本",
    available: `发现新版本 ${update.latestVersion || ""}`.trim(),
    downloading: `正在下载 ${Math.round(update.progress || 0)}%`,
    downloaded: `版本 ${update.latestVersion || ""} 已准备好`.trim(),
    error: "检查更新失败"
  }[update.status] || "尚未检查更新";
  const action = update.status === "available"
    ? '<button class="primary-button" data-command="download-update"><i data-lucide="download"></i>下载更新</button>'
    : update.status === "downloaded"
      ? '<button class="primary-button" data-command="install-update"><i data-lucide="refresh-cw"></i>重启并安装</button>'
      : `<button class="text-button" data-command="check-updates" ${["checking", "downloading"].includes(update.status) ? "disabled" : ""}><i data-lucide="refresh-cw"></i>检查更新</button>`;
  const progress = update.status === "downloading"
    ? `<div class="update-progress" aria-label="更新下载进度"><span style="width:${Math.max(0, Math.min(100, update.progress || 0))}%"></span></div>`
    : "";
  const error = update.error ? `<p class="form-message is-error"><i data-lucide="circle-alert"></i>${escapeHtml(update.error)}</p>` : "";
  return `<div class="profile-hero"><div class="profile-avatar-large update-avatar"><img src="liquid://assets/icon.png" alt=""></div><div><h3>Drip ${escapeHtml(appInfo.version || "")}</h3><p>Chromium ${escapeHtml(appInfo.chromium || "")}</p></div></div><div class="settings-group update-section"><h3>软件更新</h3><div class="update-status"><div><strong>${escapeHtml(statusText)}</strong><small>正式安装版会在启动后自动检查，并每 6 小时复查一次。</small></div>${action}</div>${progress}${error}</div><p class="status-note">网页由当前电脑本地 Chromium 渲染，外部网络请求和更新检查通过 Drip 的服务器通道；通道不可用时保持禁止直连。</p>`;
}

function passwordsMarkup() {
  const items = currentState?.modules?.passwords || [];
  const autoFill = Boolean(currentState?.modules?.settings?.passwordAutoFill);
  const toolbar = `<div class="module-toolbar"><button class="text-button" data-command="add-password"><i data-lucide="plus"></i>新增登录项</button></div>`;
  const masterNote = `<div class="settings-group"><h3>主密码保护</h3><label class="setting-toggle"><div><strong>本地保存密码</strong><small>密码条目仅保存在这台电脑上；主密码保护需要后端安全设置支持。</small></div><span class="toggle-control"><input type="checkbox" data-setting="passwordAutoFill" ${autoFill ? "checked" : ""}><span class="toggle-track"></span></span></label></div>`;
  const formSection = showPasswordForm ? `<form class="form-section" data-password-form>
    <label>名称</label>
    <input class="form-input" name="title" maxlength="80" placeholder="例如：GitHub" required>
    <label>网址</label>
    <input class="form-input" name="url" placeholder="https://example.com" required>
    <label>用户名</label>
    <input class="form-input" name="username" maxlength="120" required>
    <label>密码</label>
    <input class="form-input" name="password" type="password" maxlength="256" required>
    <div class="form-actions"><button class="primary-button" type="submit"><i data-lucide="save"></i>保存</button><button class="text-button" type="button" data-command="cancel-password">取消</button></div>
  </form>` : "";
  if (!items.length) return `${toolbar}${formSection}${masterNote}<div class="empty-state"><div><i data-lucide="key-round"></i><br>还没有保存的登录项<br>点击“新增登录项”开始记录</div></div>`;
  const list = `<div class="data-list">${items.map(item => {
    const id = escapeHtml(item.id);
    const revealed = revealedPasswordIds.has(item.id);
    return `<div class="data-row password-row">
      <span class="data-icon"><i data-lucide="key-round"></i></span>
      <div class="data-main">
        <div class="data-title">${escapeHtml(item.title || item.username || hostLabel(item.url))}</div>
        <div class="data-meta">${escapeHtml(hostLabel(item.url))} · ${escapeHtml(item.username || "—")}</div>
        <div class="password-value">${revealed ? escapeHtml(item.password) : "••••••••"}</div>
      </div>
      <div class="data-actions">
        <button class="mini-button" data-show-password="${id}" title="${revealed ? "隐藏密码" : "显示密码"}"><i data-lucide="${revealed ? "eye-off" : "eye"}"></i></button>
        <button class="mini-button" data-copy-username="${id}" title="复制用户名"><i data-lucide="copy"></i></button>
        <button class="mini-button" data-copy-password="${id}" title="复制密码"><i data-lucide="clipboard-copy"></i></button>
        <button class="mini-button" data-delete-password="${id}" title="删除"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`;
  }).join("")}</div>`;
  return `${toolbar}${formSection}${masterNote}${list}`;
}

function clearDataMarkup() {
  const rangeLabels = { all: "全部时间", hour: "过去1小时", day: "过去24小时", week: "过去7天", month: "过去30天" };
  const typeLabels = [["history", "浏览历史记录"], ["cache", "缓存的图片和文件"], ["cookies", "Cookie 及其他网站数据"], ["siteData", "已保存的网站数据"], ["downloads", "下载记录"], ["passwords", "已保存的密码"], ["permissions", "网站权限"]];
  const rangeNames = ["all", "hour", "day", "week", "month"];
  const radioGroup = `<div class="settings-group"><h3>时间范围</h3><div class="check-group">${rangeNames.map(r => `<label class="check-row"><input type="radio" name="clear-range" data-clear-range="${r}" ${clearDataRange === r ? "checked" : ""}><span>${rangeLabels[r]}</span></label>`).join("")}</div></div>`;
  const checkboxGroup = `<div class="settings-group"><h3>数据类型</h3><div class="check-group">${typeLabels.map(([t, label]) => `<label class="check-row"><input type="checkbox" data-clear-type="${t}" ${clearDataTypes[t] ? "checked" : ""}><span>${label}</span></label>`).join("")}</div></div>`;
  const footer = `<div class="account-footer"><button class="primary-button" data-command="run-clear-data"><i data-lucide="eraser"></i>清除数据</button></div>`;
  return `${radioGroup}${checkboxGroup}<p class="status-note">清除后无法撤销。密码与网站权限仅在勾选对应数据类型时才会清除。</p>${footer}`;
}

function renderModule() {
  if (!activeModule || !currentState) return;
  moduleTitle.textContent = moduleTitles[activeModule];
  const markup = {
    menu: menuMarkup,
    bookmarks: bookmarksMarkup,
    history: historyMarkup,
    downloads: downloadsMarkup,
    extensions: extensionsMarkup,
    profile: profileMarkup,
    site: siteMarkup,
    about: aboutMarkup,
    passwords: passwordsMarkup,
    "clear-data": clearDataMarkup
  }[activeModule]?.() || menuMarkup();
  moduleContent.innerHTML = markup;
  refreshIcons();
  if (activeModule === "profile") renderAccountDevices();
}

moduleContent.addEventListener("click", async event => {
  const target = event.target.closest("button");
  if (target?.dataset.module) {
    openModule(target.dataset.module);
    return;
  }
  if (target?.dataset.editBookmark) {
    editingBookmarkId = target.dataset.editBookmark;
    renderModule();
    return;
  }
  if (target?.dataset.cancelEdit !== undefined) {
    editingBookmarkId = null;
    renderModule();
    return;
  }
  if (target?.dataset.showFolder) return api.showBookmarkFolder(target.dataset.showFolder);
  if (target?.dataset.deleteBookmark) return api.deleteBookmark(target.dataset.deleteBookmark);
  if (target?.dataset.deleteHistory) {
    await api.deleteHistoryItem(target.dataset.deleteHistory);
    if (historySearchQuery.trim()) runHistorySearch();
    return;
  }
  if (target?.dataset.pauseDownload) return api.pauseDownload(target.dataset.pauseDownload);
  if (target?.dataset.resumeDownload) return api.resumeDownload(target.dataset.resumeDownload);
  if (target?.dataset.retryDownload) return api.retryDownload(target.dataset.retryDownload);
  if (target?.dataset.showDownload) return api.showDownload(target.dataset.showDownload);
  if (target?.dataset.cancelDownload) return api.cancelDownload(target.dataset.cancelDownload);
  if (target?.dataset.removeExtension) return api.removeExtension(target.dataset.removeExtension);
  if (target?.dataset.showPassword) {
    const id = target.dataset.showPassword;
    if (revealedPasswordIds.has(id)) revealedPasswordIds.delete(id);
    else revealedPasswordIds.add(id);
    renderModule();
    return;
  }
  if (target?.dataset.copyUsername) {
    const item = (currentState?.modules?.passwords || []).find(p => String(p.id) === target.dataset.copyUsername);
    if (item) showModuleToast((await copyToClipboard(item.username || "")) ? "用户名已复制" : "复制失败");
    return;
  }
  if (target?.dataset.copyPassword) {
    const item = (currentState?.modules?.passwords || []).find(p => String(p.id) === target.dataset.copyPassword);
    if (item) showModuleToast((await copyToClipboard(item.password || "")) ? "密码已复制" : "复制失败");
    return;
  }
  if (target?.dataset.deletePassword) {
    await api.deletePassword(target.dataset.deletePassword);
    return;
  }
  if (target?.dataset.downloadTab) {
    downloadTab = target.dataset.downloadTab || "active";
    renderModule();
    return;
  }

  const openRow = event.target.closest("[data-open-url]");
  if (openRow) {
    api.openUrl(openRow.dataset.openUrl);
    closeModule();
    return;
  }
  if (!target) return;

  const command = target.dataset.command;
  if (command === "new-tab") { api.newTab(); closeModule(); }
  if (command === "new-incognito-tab") { api.newIncognitoTab(); closeModule(); }
  if (command === "reopen-closed") { api.reopenClosedTab(); closeModule(); }
  if (command === "find") { closeModule(); openFind(); }
  if (command === "toggle-bookmark") api.toggleBookmark();
  if (command === "clear-history") {
    historySearchQuery = "";
    historySearchResults = null;
    api.clearHistory();
  }
  if (command === "clear-downloads") api.clearDownloadRecords();
  if (command === "open-downloads") api.openDownloadsFolder();
  if (command === "print") { api.print(); closeModule(); }
  if (command === "zoom-in") api.zoom(0.1);
  if (command === "zoom-out") api.zoom(-0.1);
  if (command === "appearance") { await api.openAppearance(); closeModule(); }
  if (command === "open-settings") { api.openSettings(); closeModule(); }
  if (command === "add-bookmark-folder") await api.addBookmarkFolder();
  if (command === "import-bookmarks") await api.importBookmarks();
  if (command === "export-bookmarks") await api.exportBookmarks();
  if (command === "choose-download-path") await api.setDownloadPath();
  if (command === "account-show-login") { accountFormMode = "login"; renderModule(); }
  if (command === "account-show-register") { accountFormMode = "register"; renderModule(); }
  if (command === "account-avatar-select") document.getElementById("accountAvatarInput")?.click();
  if (command === "account-avatar-remove") {
    const result = await api.accountUpdateAvatar("");
    currentState.modules.account = result;
    render(currentState);
    renderModule();
  }
  if (command === "account-logout") {
    const result = await api.accountLogout();
    currentState.modules.account = result;
    render(currentState);
    renderModule();
  }
  if (command === "account-revoke-device") {
    const proceed = window.confirm ? window.confirm("确定退出该设备上的登录吗？") : true;
    if (!proceed) return;
    await api.accountRevokeDevice(target?.dataset?.deviceId, false);
    await renderAccountDevices();
  }
  if (command === "account-revoke-all") {
    const proceed = window.confirm ? window.confirm("确定退出所有其他设备吗？当前设备将保留登录状态。") : true;
    if (!proceed) return;
    await api.accountRevokeDevice("", true);
    await renderAccountDevices();
  }
  if (command === "account-sync-up") {
    try {
      await api.accountSyncSettingsUp();
      showAccountNotice("设置已上传到云端");
    } catch (error) {
      showAccountNotice(error?.message || "设置上传失败");
    }
  }
  if (command === "account-sync-down") {
    try {
      await api.accountSyncSettingsDown();
      showAccountNotice("已从云端恢复设置");
    } catch (error) {
      showAccountNotice(error?.message || "云端恢复失败");
    }
  }
  if (command === "check-updates") {
    const result = await api.checkForUpdates();
    currentState.modules.updates = result;
    render(currentState);
    renderModule();
  }
  if (command === "download-update") {
    const result = await api.downloadUpdate();
    currentState.modules.updates = result;
    render(currentState);
    renderModule();
  }
  if (command === "install-update") api.installUpdate();
  if (command === "clear-cache") {
    target.disabled = true;
    target.querySelector("span").textContent = "正在清理…";
    await api.clearCache();
    target.querySelector("span").textContent = "缓存已清理";
  }
  if (command === "clear-site-data") {
    target.disabled = true;
    await api.clearSiteData();
    target.querySelector("span").textContent = "网站数据已清除";
  }
  if (command === "reset-site-permissions") await api.resetSitePermissions();
  if (command === "clear-browsing-data") await api.clearBrowsingData();
  if (command === "add-extension") {
    const result = await api.addExtension();
    if (result?.error) {
      const note = document.createElement("p");
      note.className = "status-note";
      note.textContent = `扩展加载失败：${result.error}`;
      moduleContent.prepend(note);
    }
  }
  if (command === "save-profile") {
    const input = document.getElementById("profileNameInput");
    await api.updateProfile(input?.value || "本地用户");
    renderModule();
  }
  if (command === "add-password") { showPasswordForm = true; renderModule(); }
  if (command === "cancel-password") { showPasswordForm = false; renderModule(); }
  if (command === "run-clear-data") {
    await api.clearBrowsingData({ range: clearDataRange, dataTypes: { ...clearDataTypes } });
    showModuleToast("浏览数据已清除");
  }
  if (command === "clear-history-range") {
    await api.clearHistory(historyRange);
    historySearchQuery = "";
    historySearchResults = null;
  }
  if (command === "new-window") { api.openWindow(); closeModule(); }
  if (command === "share") api.share();
  if (command === "translate") api.translate();
  if (command === "open-dev-tools") { api.openDevTools(); closeModule(); }
  if (command === "close-window") api.closeWindow();
});

moduleContent.addEventListener("submit", async event => {
  const bookmarkForm = event.target.closest("form[data-bookmark-form]");
  if (bookmarkForm) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(bookmarkForm).entries());
    const fields = { title: values.title };
    if (values.url !== undefined) fields.url = values.url;
    await api.updateBookmark(bookmarkForm.dataset.bookmarkForm, fields);
    editingBookmarkId = null;
    return;
  }
  const passwordForm = event.target.closest("form[data-password-form]");
  if (passwordForm) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(passwordForm).entries());
    await api.savePassword({
      title: values.title,
      url: values.url,
      username: values.username,
      password: values.password
    });
    showPasswordForm = false;
    return;
  }
  const form = event.target.closest("form[data-account-form]");
  if (!form) return;
  event.preventDefault();
  const mode = form.dataset.accountForm;
  const values = Object.fromEntries(new FormData(form).entries());
  if (mode === "register" && values.password !== values.passwordConfirm) {
    currentState.modules.account = { ...currentState.modules.account, error: "两次输入的密码不一致" };
    renderModule();
    return;
  }
  for (const control of form.elements) control.disabled = true;
  let result;
  if (mode === "login") {
    result = await api.accountLogin({ username: values.username, password: values.password });
  } else if (mode === "register") {
    result = await api.accountRegister({ username: values.username, displayName: values.displayName, password: values.password });
  } else if (mode === "profile") {
    result = await api.accountUpdateProfile(values.displayName);
  } else if (mode === "password") {
    result = await api.accountChangePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
  } else if (mode === "redeem") {
    try { result = await api.accountRedeem(values.code); }
    catch (error) { result = { ...currentState.modules.account, error: error.message }; }
  }
  if (result) {
    currentState.modules.account = result;
    render(currentState);
    renderModule();
  }
});

moduleContent.addEventListener("change", event => {
  if (event.target.id === "accountAvatarInput") {
    const file = event.target.files?.[0];
    if (!file) return;
    (async () => {
      try {
        const result = await api.accountUpdateAvatar(await prepareAccountAvatar(file));
        currentState.modules.account = result;
      } catch (error) {
        currentState.modules.account = { ...currentState.modules.account, error: error.message, notice: null };
      }
      render(currentState);
      renderModule();
    })();
    return;
  }
  if (event.target.dataset.extensionToggle) {
    api.toggleExtension(event.target.dataset.extensionToggle, event.target.checked);
    return;
  }
  if (event.target.dataset.historyRange) {
    historyRange = event.target.value;
    return;
  }
  if (event.target.dataset.clearRange) {
    clearDataRange = event.target.value;
    return;
  }
  if (event.target.dataset.clearType) {
    clearDataTypes[event.target.dataset.clearType] = event.target.checked;
    return;
  }
  if (event.target.dataset.sitePermission) {
    api.setSitePermission(event.target.dataset.sitePermission, event.target.value === "allow");
    return;
  }
  const setting = event.target.dataset.setting;
  if (!setting) return;
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  api.updateSetting(setting, value);
});

let historySearchTimer = null;

async function runHistorySearch() {
  const query = historySearchQuery.trim();
  if (!query) {
    historySearchResults = null;
    renderModule();
    return;
  }
  const results = await api.searchHistory(query);
  if (historySearchQuery.trim() !== query) return;
  historySearchResults = results || [];
  renderModule();
  const input = moduleContent.querySelector("[data-history-search]");
  if (input) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

moduleContent.addEventListener("input", event => {
  if (event.target.matches("[data-bookmark-search]")) {
    bookmarkSearchQuery = event.target.value;
    renderModule();
    const input = moduleContent.querySelector("[data-bookmark-search]");
    if (input) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    return;
  }
  if (!event.target.matches("[data-history-search]")) return;
  historySearchQuery = event.target.value;
  if (historySearchTimer) clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => {
    historySearchTimer = null;
    runHistorySearch();
  }, 150);
});

function runFind(forward = true, findNext = false) {
  const query = findInput.value;
  findResult.textContent = query ? "…" : "0/0";
  api.find(query, { forward, findNext });
}

function openFind() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  runFind(true, false);
}

function closeFind() {
  findBar.hidden = true;
  findResult.textContent = "0/0";
  api.stopFind("keepSelection");
}

findBar.addEventListener("submit", event => {
  event.preventDefault();
  runFind(!event.shiftKey, true);
});
findInput.addEventListener("input", () => runFind(true, false));
document.getElementById("findPrevious").addEventListener("click", () => runFind(false, true));
document.getElementById("findNext").addEventListener("click", () => runFind(true, true));
document.getElementById("closeFind").addEventListener("click", closeFind);

const addressSuggestionsBox = document.getElementById("addressSuggestions");

function hideAddressSuggestions() {
  suggestionItems = [];
  suggestionIndex = -1;
  if (addressSuggestionsBox) {
    addressSuggestionsBox.hidden = true;
    addressSuggestionsBox.innerHTML = "";
  }
}

function renderAddressSuggestions() {
  if (!addressSuggestionsBox) return;
  if (!suggestionItems.length) {
    addressSuggestionsBox.hidden = true;
    addressSuggestionsBox.innerHTML = "";
    return;
  }
  const icons = { bookmark: "bookmark", history: "clock-3", url: "globe-2", search: "search" };
  addressSuggestionsBox.innerHTML = suggestionItems.map((item, index) => `
    <button type="button" class="suggestion-row${index === suggestionIndex ? " is-active" : ""}" data-suggestion-index="${index}">
      <span class="data-icon"><i data-lucide="${icons[item.kind] || "globe-2"}"></i></span>
      <div class="data-main">
        <div class="data-title">${escapeHtml(item.title || item.url)}</div>
        <div class="data-meta">${escapeHtml(item.kind === "search" ? `使用 ${item.engine || "搜索引擎"} 搜索` : item.kind === "bookmark" ? "书签" : item.kind === "history" ? "历史记录" : item.url)}</div>
      </div>
    </button>`).join("");
  addressSuggestionsBox.hidden = false;
  refreshIcons();
}

function pickAddressSuggestion(item) {
  hideAddressSuggestions();
  api.navigate(item.url);
  addressInput.blur();
}

addressForm.addEventListener("submit", event => {
  event.preventDefault();
  const picked = suggestionIndex >= 0 ? suggestionItems[suggestionIndex] : null;
  hideAddressSuggestions();
  api.navigate(picked ? picked.url : addressInput.value);
  addressInput.blur();
});
addressInput.addEventListener("focus", () => addressInput.select());
addressInput.addEventListener("input", () => {
  const query = addressInput.value.trim();
  if (suggestionTimer) clearTimeout(suggestionTimer);
  if (!query) {
    hideAddressSuggestions();
    return;
  }
  suggestionTimer = setTimeout(async () => {
    const token = ++suggestionToken;
    const results = await api.suggestAddress(query);
    if (token !== suggestionToken) return;
    suggestionItems = Array.isArray(results) ? results : [];
    suggestionIndex = -1;
    renderAddressSuggestions();
  }, 120);
});
addressInput.addEventListener("keydown", event => {
  if (!suggestionItems.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    suggestionIndex = (suggestionIndex + 1) % suggestionItems.length;
    renderAddressSuggestions();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    suggestionIndex = suggestionIndex <= 0 ? suggestionItems.length - 1 : suggestionIndex - 1;
    renderAddressSuggestions();
  } else if (event.key === "Enter" && suggestionIndex >= 0) {
    event.preventDefault();
    pickAddressSuggestion(suggestionItems[suggestionIndex]);
  } else if (event.key === "Escape") {
    hideAddressSuggestions();
  }
});
addressInput.addEventListener("blur", () => {
  setTimeout(() => {
    if (suggestionIndex < 0) hideAddressSuggestions();
  }, 150);
});
addressSuggestionsBox?.addEventListener("mousedown", event => {
  event.preventDefault();
});
addressSuggestionsBox?.addEventListener("click", event => {
  const row = event.target.closest("[data-suggestion-index]");
  if (!row) return;
  const item = suggestionItems[Number(row.dataset.suggestionIndex)];
  if (item) pickAddressSuggestion(item);
});
document.getElementById("back").addEventListener("click", () => api.goBack());
document.getElementById("forward").addEventListener("click", () => api.goForward());
document.getElementById("reload").addEventListener("click", () => api.reload());
document.getElementById("home").addEventListener("click", () => api.goHome());
siteSecurityButton.addEventListener("click", () => openModule("site"));
document.getElementById("newTab").addEventListener("click", () => api.newTab());
bookmarkButton.addEventListener("click", () => api.toggleBookmark());
themeButton.addEventListener("click", () => api.toggleTheme());
appearanceButton.addEventListener("click", () => api.openAppearance());
downloadsButton.addEventListener("click", () => openModule("downloads"));
updatePromptDetails.addEventListener("click", () => {
  api.openUrl(currentState?.modules?.updates?.detailsUrl || "https://example.invalid/releases");
  closeUpdatePrompt();
});
updatePromptDownload.addEventListener("click", async () => {
  updatePromptDownload.disabled = true;
  closeUpdatePrompt();
  try {
    const result = await api.downloadUpdate();
    currentState.modules.updates = result;
    render(currentState);
  } finally {
    updatePromptDownload.disabled = false;
  }
});
document.getElementById("closeUpdatePrompt").addEventListener("click", closeUpdatePrompt);
profileButton.addEventListener("click", () => openModule("profile"));
document.getElementById("menuButton").addEventListener("click", () => openModule("menu"));
document.getElementById("moduleScrim").addEventListener("click", closeModule);
document.getElementById("closeModule").addEventListener("click", closeModule);
connectionIndicator.addEventListener("click", () => openModule("about"));
document.getElementById("minimizeWindow").addEventListener("click", () => api.minimizeWindow());
maximizeButton.addEventListener("click", () => api.toggleMaximizeWindow());
document.getElementById("closeWindow").addEventListener("click", () => api.closeWindow());
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (!browserRouteOverlay.hidden) {
    closeBrowserRouteMenu();
  } else if (!updatePrompt.hidden) {
    closeUpdatePrompt();
  } else if (activeModule) {
    closeModule();
  } else if (!findBar.hidden) {
    closeFind();
  }
});

api.onState(render);
api.onFocusAddress(() => {
  closeBrowserRouteMenu();
  if (activeModule) closeModule();
  addressInput.focus();
  addressInput.select();
});
api.onOpenModule(openModule);
api.onOpenFind(openFind);
api.onFindResult(result => {
  if (!result) return;
  findResult.textContent = `${result.activeMatchOrdinal || 0}/${result.matches || 0}`;
});
api.getState().then(render);
refreshIcons();
