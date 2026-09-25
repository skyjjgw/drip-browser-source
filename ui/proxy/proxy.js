"use strict";

const api = window.dripProxy;
const pageTitles = {
  home: "首页", proxies: "代理", profiles: "订阅", connections: "连接",
  rules: "规则", logs: "日志", test: "测试", settings: "设置"
};
const returnButton = document.getElementById("return-browser");
const dialog = document.getElementById("confirm-dialog");
const cancelButton = document.getElementById("cancel-close");
const confirmButton = document.getElementById("confirm-close");
const subscriptionForm = document.getElementById("subscription-form");
const subscriptionList = document.getElementById("subscription-list");
const subscriptionMessage = document.getElementById("subscription-message");
const nodeList = document.getElementById("node-list");
const runtimeToggle = document.getElementById("runtime-toggle");
const runtimeBadge = document.getElementById("runtime-badge");
const systemProxySwitch = document.getElementById("system-proxy-switch");
const tunSwitch = document.getElementById("tun-switch");
const settingsSystemProxy = document.getElementById("settings-system-proxy");
const settingsTun = document.getElementById("settings-tun");
const modeNote = document.getElementById("mode-note");
let localNode = { imported: false };
let subscriptions = [];
let nodes = [];
let selectedNodeId = "local";
let preferences = { mode: "rule", systemProxy: true, tun: false };
let runtime = { active: false, starting: false, error: null };
let statsPolling = false;
let latencyTesting = false;

window.lucide?.createIcons();

function showPage(name) {
  if (!pageTitles[name]) return;
  for (const button of document.querySelectorAll(".side-nav button")) {
    button.classList.toggle("active", button.dataset.page === name);
  }
  for (const page of document.querySelectorAll(".page")) {
    page.classList.toggle("active", page.id === `page-${name}`);
  }
  document.getElementById("page-title").textContent = pageTitles[name];
  document.querySelector(".page-scroll").scrollTop = 0;
  if (name === "rules") refreshRules();
  if (name === "logs") refreshLogs();
}

document.querySelectorAll(".side-nav button").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});
document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.go));
});

function icon(name) {
  const element = document.createElement("i");
  element.dataset.lucide = name;
  element.className = "icon";
  return element;
}

function setSwitch(element, value, disabled = false) {
  if (!element) return;
  element.classList.toggle("on", Boolean(value));
  element.setAttribute("aria-checked", String(Boolean(value)));
  element.disabled = disabled;
}

function syncControls() {
  const locked = runtime.active || runtime.starting || runtime.restarting;
  setSwitch(systemProxySwitch, preferences.systemProxy, locked);
  setSwitch(tunSwitch, preferences.tun, locked);
  setSwitch(settingsSystemProxy, preferences.systemProxy, locked);
  setSwitch(settingsTun, preferences.tun, locked);
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.classList.toggle("selected", button.dataset.mode === preferences.mode);
    button.disabled = locked;
  }
  if (modeNote) {
    modeNote.textContent = runtime.active
      ? `代理运行中：${preferences.mode === "rule" ? "规则" : preferences.mode === "global" ? "全局" : "直连"}模式`
      : runtime.error || "未启动时可先选择模式，启动后立即生效";
  }
}

function updateNodeSummary() {
  const selected = nodes.find(node => node.id === selectedNodeId);
  document.getElementById("home-node-name").textContent = selected?.name || "暂无节点";
  document.getElementById("home-node-detail").textContent = selected
    ? `${selected.source} · ${runtime.active ? "已连接" : "未连接"}`
    : "请先导入节点";
  document.getElementById("home-node-state").textContent = runtime.active ? "运行中" : selected ? "未连接" : "未导入";
}

function syncDelayButtons() {
  const enabled = nodes.length > 0 && !runtime.starting && !runtime.restarting && !latencyTesting;
  for (const button of document.querySelectorAll(".delay-button")) {
    button.disabled = !enabled;
    button.title = enabled ? "测试选中的节点" : nodes.length ? "请等待当前操作完成" : "请先导入节点";
  }
}

function renderNodes() {
  nodeList.className = nodes.length ? "saved-node-list" : "empty";
  nodeList.replaceChildren();
  if (!nodes.length) {
    nodeList.textContent = "暂无已保存节点，请先导入配置或添加订阅";
    updateNodeSummary();
    syncDelayButtons();
    return;
  }
  if (!nodes.some(node => node.id === selectedNodeId)) selectedNodeId = nodes[0].id;
  for (const entry of nodes) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `node-item${entry.id === selectedNodeId ? " selected" : ""}`;
    row.dataset.nodeId = entry.id;
    const symbol = document.createElement("span");
    symbol.className = "row-icon teal";
    symbol.append(icon("wifi"));
    const copy = document.createElement("span");
    copy.className = "list-row-main";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const source = document.createElement("small");
    source.textContent = `${entry.source} · VLESS Reality`;
    copy.append(name, source);
    const state = document.createElement("span");
    state.className = "tag";
    state.textContent = entry.id === selectedNodeId ? "已选择" : "可用";
    row.append(symbol, copy, state);
    nodeList.append(row);
  }
  updateNodeSummary();
  syncDelayButtons();
  window.lucide?.createIcons({ nodes: [nodeList] });
}

async function refreshNodes() {
  if (!api?.nodes) return;
  try {
    nodes = await api.nodes();
    renderNodes();
  } catch {
    nodes = [];
    renderNodes();
  }
}

function renderLocalNode(status) {
  localNode = status;
  const detail = status.error || (status.imported ? "已导入 · 可用于启动代理" : "未导入 · 代理未启用");
  document.getElementById("local-node-detail").textContent = detail;
  document.getElementById("import-node").querySelector("span").textContent = status.imported ? "重新导入" : "从 Clash Verge 导入";
  refreshNodes();
}

function showSubscriptionMessage(message, error = false) {
  subscriptionMessage.textContent = message;
  subscriptionMessage.classList.toggle("error", error);
}

function makeAction(iconName, label, action, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.action = action;
  button.dataset.id = id;
  button.append(icon(iconName), document.createTextNode(label));
  return button;
}

function renderSubscriptions(items) {
  subscriptions = items;
  subscriptionList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无订阅";
    subscriptionList.append(empty);
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "list-row";
    const symbol = document.createElement("span");
    symbol.className = "row-icon";
    symbol.append(icon("cloud-download"));
    const copy = document.createElement("span");
    copy.className = "list-row-main";
    const title = document.createElement("strong");
    title.textContent = item.name;
    const details = document.createElement("small");
    details.textContent = `${item.host} · ${item.nodeCount} 个节点${item.skipped ? ` · 跳过 ${item.skipped}` : ""}${item.insecure ? " · HTTP" : ""} · ${new Date(item.updatedAt).toLocaleString("zh-CN")}`;
    copy.append(title, details);
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "已保存";
    const actions = document.createElement("div");
    actions.className = "subscription-row-actions";
    actions.append(makeAction("refresh-cw", "刷新", "refresh", item.id), makeAction("trash-2", "移除", "remove", item.id));
    row.append(symbol, copy, tag, actions);
    subscriptionList.append(row);
  }
  const first = items[0];
  const count = items.reduce((sum, item) => sum + item.nodeCount, 0);
  document.getElementById("home-sub-name").textContent = first?.name || "暂无订阅";
  document.getElementById("home-sub-count").textContent = `${count} 个已保存节点`;
  document.getElementById("home-sub-host").textContent = `来自：${first?.host || "--"}`;
  document.getElementById("home-sub-time").textContent = `更新于：${first ? new Date(first.updatedAt).toLocaleString("zh-CN") : "--"}`;
  document.getElementById("home-sub-total").textContent = `${items.length} / 10 个订阅`;
  document.getElementById("subscription-meter").style.width = `${items.length * 10}%`;
  refreshNodes();
  window.lucide?.createIcons({ nodes: [subscriptionList] });
}

function renderRuntime(status) {
  runtime = status || runtime;
  const active = Boolean(runtime.active);
  const starting = Boolean(runtime.starting);
  if ((active || starting) && runtime.nodeId && runtime.nodeId !== selectedNodeId) {
    selectedNodeId = runtime.nodeId;
    if (nodes.length) renderNodes();
  }
  runtimeBadge.textContent = starting ? "正在启动" : active ? "代理运行中" : runtime.error ? "启动失败" : "代理未启用";
  if (runtime.restarting) runtimeBadge.textContent = "正在请求管理员权限";
  runtimeBadge.classList.toggle("active", active);
  runtimeToggle.disabled = starting || Boolean(runtime.restarting);
  runtimeToggle.querySelector("span").textContent = starting ? "启动中…" : active ? "停止代理" : "启动代理";
  runtimeToggle.classList.toggle("stop", active);
  syncDelayButtons();
  document.querySelector(".side-status strong").textContent = active ? "代理运行中" : starting ? "代理启动中" : "代理未启用";
  document.querySelector(".side-status small").textContent = active
    ? `${runtime.tun ? "TUN" : runtime.systemProxy ? "系统代理" : "浏览器代理"} · ${runtime.nodeName || "节点"}`
    : "下载 -- · 上传 --";
  document.querySelector(".meter-labels span").textContent = active ? "代理已启动" : "代理未启用";
  document.getElementById("settings-runtime-state").textContent = active ? "运行中" : starting ? "启动中" : "未启动";
  document.getElementById("settings-runtime-port").textContent = runtime.port || "--";
  preferences.mode = runtime.mode || preferences.mode;
  if (active) {
    preferences.systemProxy = runtime.systemProxy;
    preferences.tun = runtime.tun;
  }
  syncControls();
  updateNodeSummary();
}

function formatBytes(value) {
  const bytes = Number.isFinite(value) && value > 0 ? value : 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** unit;
  return `${amount.toFixed(unit === 0 ? 0 : amount < 10 ? 1 : 0)} ${units[unit]}`;
}

function renderTrafficChart(history) {
  const samples = Array.isArray(history) ? history.slice(-120) : [];
  const values = Array.from({ length: 120 }, (_, index) => samples[index - (120 - samples.length)] || { upload: 0, download: 0 });
  const maximum = Math.max(1024, ...values.map(item => Math.max(item.upload || 0, item.download || 0)));
  const points = direction => values.map((item, index) => {
    const x = (index * 800 / 119).toFixed(1);
    const y = (145 - Math.min(1, (item[direction] || 0) / maximum) * 125).toFixed(1);
    return `${x},${y}`;
  }).join(" ");
  document.getElementById("download-line").setAttribute("points", points("download"));
  document.getElementById("upload-line").setAttribute("points", points("upload"));
}

function renderConnections(stats) {
  const connections = Array.isArray(stats.connections) ? stats.connections : [];
  const body = document.getElementById("connections-body");
  const rows = connections.map(item => {
    const row = document.createElement("tr");
    const values = [
      item.port ? `${item.target}:${item.port}` : item.target,
      item.process, item.rule, item.chain,
      formatBytes(item.upload), formatBytes(item.download)
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value || "--";
      cell.title = value || "--";
      row.append(cell);
    }
    return row;
  });
  body.replaceChildren(...rows);
  document.getElementById("connections-table").hidden = rows.length === 0;
  document.getElementById("connections-empty").hidden = rows.length > 0;
  document.getElementById("connections-empty").textContent = stats.active ? "当前没有活动连接" : "代理未启用，暂无连接数据";
  document.getElementById("connections-count").textContent = String(stats.activeConnections || 0);
}

function renderTraffic(stats) {
  const active = Boolean(stats.active);
  document.getElementById("traffic-state").textContent = active
    ? stats.error ? "统计暂不可用" : "实时 · 每秒更新"
    : "代理未启用 · 保留今日累计";
  document.getElementById("traffic-down-speed").textContent = `${formatBytes(stats.downloadSpeed)}/s`;
  document.getElementById("traffic-up-speed").textContent = `${formatBytes(stats.uploadSpeed)}/s`;
  document.getElementById("traffic-today-down").textContent = formatBytes(stats.todayDownload);
  document.getElementById("traffic-today-up").textContent = formatBytes(stats.todayUpload);
  document.getElementById("traffic-connections").textContent = String(stats.activeConnections || 0);
  document.getElementById("traffic-memory").textContent = active ? formatBytes(stats.memory) : "--";
  if (active) {
    document.querySelector(".side-status small").textContent = `↓ ${formatBytes(stats.downloadSpeed)}/s · ↑ ${formatBytes(stats.uploadSpeed)}/s`;
  }
  renderTrafficChart(stats.history);
  renderConnections(stats);
}

function renderTableRows(bodyId, rows) {
  const body = document.getElementById(bodyId);
  body.replaceChildren(...rows.map(values => {
    const row = document.createElement("tr");
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value || "--";
      row.append(cell);
    }
    return row;
  }));
}

async function refreshRules() {
  if (!api?.rules) return;
  try {
    const rules = await api.rules();
    renderTableRows("rules-body", rules.map(rule => [rule.type, rule.content, rule.outbound === "direct" ? "直连" : "代理"]));
    document.getElementById("rules-table").hidden = rules.length === 0;
    document.getElementById("rules-empty").hidden = rules.length > 0;
    document.getElementById("rules-heading").textContent = runtime.active ? "当前分流规则" : "上次启动的分流规则";
  } catch {
    document.getElementById("rules-empty").textContent = "暂时无法读取分流规则";
  }
}

async function refreshLogs() {
  if (!api?.logs) return;
  try {
    const logs = await api.logs();
    renderTableRows("logs-body", logs.map(entry => [entry.time, entry.level, entry.message]));
    document.getElementById("logs-table").hidden = logs.length === 0;
    document.getElementById("logs-empty").hidden = logs.length > 0;
  } catch {
    document.getElementById("logs-empty").textContent = "暂时无法读取内核日志";
  }
}

async function refreshTraffic() {
  if (!api?.stats || statsPolling) return;
  statsPolling = true;
  try {
    const stats = await api.stats();
    if (Boolean(stats.active) !== Boolean(runtime.active)) {
      renderRuntime(await api.status());
    }
    renderTraffic(stats);
  } catch {
    document.getElementById("traffic-state").textContent = runtime.active ? "统计暂不可用" : "代理未启用";
    api.status().then(renderRuntime).catch(() => {});
  } finally {
    statsPolling = false;
  }
}

function togglePreference(key) {
  if (runtime.active || runtime.starting || runtime.restarting) return;
  preferences[key] = !preferences[key];
  syncControls();
}

document.querySelectorAll("[data-mode]").forEach(button => {
  button.addEventListener("click", () => {
    if (runtime.active || runtime.starting || runtime.restarting) return;
    preferences.mode = button.dataset.mode;
    syncControls();
  });
});
systemProxySwitch.addEventListener("click", () => togglePreference("systemProxy"));
tunSwitch.addEventListener("click", () => togglePreference("tun"));
settingsSystemProxy.addEventListener("click", () => togglePreference("systemProxy"));
settingsTun.addEventListener("click", () => togglePreference("tun"));

nodeList.addEventListener("click", event => {
  const row = event.target.closest("[data-node-id]");
  if (!row || runtime.active || runtime.starting || runtime.restarting) return;
  selectedNodeId = row.dataset.nodeId;
  renderNodes();
});

runtimeToggle.addEventListener("click", async () => {
  if (!api || runtime.starting || runtime.restarting) return;
  runtimeToggle.disabled = true;
  try {
    renderRuntime({ ...runtime, starting: !runtime.active, error: null });
    const status = runtime.active
      ? await api.stop()
      : await api.start({ nodeId: selectedNodeId, mode: preferences.mode, systemProxy: preferences.systemProxy, tun: preferences.tun });
    renderRuntime(status);
    refreshTraffic();
  } catch (error) {
    renderRuntime({ ...runtime, active: false, starting: false, error: error.message || "代理启动失败" });
  } finally {
    runtimeToggle.disabled = Boolean(runtime.starting || runtime.restarting);
  }
});

if (api) {
  api.onStatus?.(renderRuntime);
  api.nodeStatus().then(renderLocalNode).catch(() => {
    document.getElementById("local-node-detail").textContent = "暂时无法读取本机节点";
  });
  api.subscriptions().then(renderSubscriptions).catch(() => showSubscriptionMessage("无法读取已保存的订阅", true));
  api.status().then(renderRuntime).catch(() => {});
  refreshTraffic();
  setInterval(refreshTraffic, 1000);
  setInterval(() => {
    if (document.getElementById("page-logs").classList.contains("active")) refreshLogs();
  }, 2000);
}

document.querySelectorAll(".delay-button").forEach(button => {
  button.addEventListener("click", async () => {
    if (!api?.delay || latencyTesting || !nodes.length) return;
    latencyTesting = true;
    syncDelayButtons();
    document.getElementById("delay-result").textContent = "正在测试选中的节点…";
    try {
      const result = await api.delay(selectedNodeId);
      const selected = nodes.find(node => node.id === selectedNodeId);
      document.getElementById("delay-result").textContent = `${selected?.name || "当前节点"} · ${result.delay} ms`;
    } catch (error) {
      document.getElementById("delay-result").textContent = error.message || "延迟测试失败";
    } finally {
      latencyTesting = false;
      syncDelayButtons();
    }
  });
});

document.getElementById("import-node").addEventListener("click", async event => {
  if (!api || runtime.active) return;
  const button = event.currentTarget;
  button.disabled = true;
  try { renderLocalNode(await api.importJapan()); }
  catch (error) { document.getElementById("local-node-detail").textContent = error.message || "导入失败"; }
  finally { button.disabled = false; }
});

subscriptionForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!api || runtime.active) return;
  const button = subscriptionForm.querySelector("button[type=submit]");
  button.disabled = true;
  showSubscriptionMessage("正在导入订阅…");
  try {
    const url = document.getElementById("subscription-url").value.trim();
    const name = document.getElementById("subscription-name").value.trim();
    renderSubscriptions(await api.addSubscription(url, name));
    subscriptionForm.reset();
    showSubscriptionMessage("订阅已保存，选择节点后即可启动代理");
  } catch (error) {
    showSubscriptionMessage(error.message || "导入失败", true);
  } finally {
    button.disabled = false;
  }
});

subscriptionList.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button || !api || runtime.active) return;
  const action = button.dataset.action;
  if (action === "remove" && !window.confirm("移除这个订阅？")) return;
  button.disabled = true;
  showSubscriptionMessage(action === "refresh" ? "正在刷新订阅…" : "正在移除订阅…");
  try {
    renderSubscriptions(action === "refresh"
      ? await api.refreshSubscription(button.dataset.id)
      : await api.removeSubscription(button.dataset.id));
    showSubscriptionMessage(action === "refresh" ? "订阅已刷新" : "订阅已移除");
  } catch (error) {
    showSubscriptionMessage(error.message || "操作失败", true);
    button.disabled = false;
  }
});

function showCloseDialog() {
  dialog.hidden = false;
  const busy = runtime.starting || runtime.restarting;
  document.getElementById("dialog-title").textContent = busy ? "代理正在启动" : runtime.active ? "停止代理并返回？" : "关闭代理中心并返回？";
  document.getElementById("dialog-description").textContent = busy
    ? "请等待代理启动完成后再关闭并返回。"
    : runtime.active ? "将停止 Drip 代理，恢复网络设置后返回浏览器。" : "当前代理未启用。返回不会影响 Clash Verge 或系统网络设置。";
  confirmButton.textContent = runtime.active ? "停止并返回" : "关闭并返回";
  confirmButton.disabled = busy;
  cancelButton.focus();
}
function hideCloseDialog() {
  if (cancelButton.disabled) return;
  dialog.hidden = true;
  returnButton.focus();
}
returnButton.addEventListener("click", showCloseDialog);
document.getElementById("sidebar-close").addEventListener("click", showCloseDialog);
cancelButton.addEventListener("click", hideCloseDialog);
for (const [id, action] of [["minimize-window", "minimize"], ["maximize-window", "maximize"], ["close-window", "close"]]) {
  document.getElementById(id).addEventListener("click", () => api?.windowAction(action));
}
confirmButton.addEventListener("click", async () => {
  if (!api || confirmButton.disabled) return;
  confirmButton.disabled = true;
  cancelButton.disabled = true;
  document.getElementById("dialog-description").textContent = runtime.active ? "正在停止代理并恢复网络设置…" : "正在返回浏览器…";
  try { await api.closeCenter(); }
  catch (error) {
    confirmButton.disabled = false;
    cancelButton.disabled = false;
    document.getElementById("dialog-description").textContent = error.message || "暂时无法返回浏览器，请重试。";
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (dialog.hidden) showCloseDialog();
  else hideCloseDialog();
});

syncControls();
