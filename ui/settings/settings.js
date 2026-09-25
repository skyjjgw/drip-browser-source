const body = document.getElementById("settingsBody");
const backHome = document.getElementById("backHome");
const bridge = window.liquidHome;
const ENGINES = [["google", "谷歌"], ["bing", "必应"], ["duckduckgo", "DuckDuckGo"], ["baidu", "百度"]];

let settings = {};

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toggleMarkup(key, label, hint, checked) {
  return `<label class="setting-toggle">
    <div><strong>${label}</strong>${hint ? `<small>${hint}</small>` : ""}</div>
    <span class="toggle-control"><input type="checkbox" data-setting="${key}" ${checked ? "checked" : ""}><span class="toggle-track"></span></span>
  </label>`;
}

function renderGroups() {
  const s = settings;
  const groups = [];

  groups.push(`<section class="settings-group"><h3>启动</h3>${toggleMarkup("restoreSession", "继续上次浏览", "启动时恢复最多 8 个标签页；关闭可获得更快启动速度。", Boolean(s.restoreSession))}</section>`);

  const engineOptions = ENGINES.map(([value, label]) => `<option value="${value}" ${s.searchEngine === value ? "selected" : ""}>${label}</option>`).join("");
  groups.push(`<section class="settings-group"><h3>搜索引擎</h3>
    <div class="setting-toggle"><div><strong>地址栏默认搜索引擎</strong><small>在地址栏输入关键词时使用的搜索服务。</small></div>
    <select class="setting-select" data-setting="searchEngine">${engineOptions}</select></div>
  </section>`);

  groups.push(`<section class="settings-group"><h3>下载</h3>
    ${toggleMarkup("askDownloadLocation", "下载前询问保存位置", "关闭后自动保存到下方指定的下载位置。", Boolean(s.askDownloadLocation))}
    <div class="setting-toggle"><div><strong>下载位置</strong><small class="download-path-text">${escapeHtml(s.downloadPath || "默认下载文件夹")}</small></div>
    <button class="text-button" data-command="choose-download-path">更改</button></div>
  </section>`);

  groups.push(`<section class="settings-group"><h3>隐私与数据</h3>
    ${toggleMarkup("doNotTrack", "发送“请勿跟踪”请求", "随浏览流量附带 DNT 请求头，部分网站会尊重该设置。", Boolean(s.doNotTrack))}
    ${toggleMarkup("contentBlocking", "拦截广告与追踪", "基于内置清单拦截常见广告/追踪域名；关闭后恢复这些请求。", Boolean(s.contentBlocking))}
    <div class="setting-actions"><button class="text-button" data-command="clear-cache"><i data-lucide="gauge"></i>仅清理网页缓存</button></div>
  </section>`);

  groups.push(`<section class="settings-group"><h3>外观</h3>
    <div class="setting-actions"><button class="text-button" data-command="appearance"><i data-lucide="palette"></i>主页外观设置</button></div>
    <label class="setting-toggle" style="flex-direction:column;align-items:flex-start;gap:4px;">
      <div><strong>主页</strong><small>启动时打开的主页地址，留空使用默认主页。</small></div>
      <input class="text-input" type="text" data-setting="homepage" value="${escapeHtml(s.homepage || "")}" placeholder="https://drip.home">
    </label>
    ${toggleMarkup("showBookmarksBar", "显示书签栏", "在工具栏下方显示书签栏，便于快速访问收藏。", Boolean(s.showBookmarksBar))}
  </section>`);

  groups.push(`<section class="settings-group"><h3>侧边栏与标签页</h3>
    ${toggleMarkup("sidebar", "侧边栏", "在窗口左侧显示内置侧边栏。", Boolean(s.sidebar))}
    ${toggleMarkup("verticalTabs", "垂直标签页", "在侧边栏中垂直排列标签页。", Boolean(s.verticalTabs))}
  </section>`);

  groups.push(`<section class="settings-group"><h3>默认浏览器</h3>
    <div class="setting-toggle"><div><strong>设为默认浏览器</strong><small>当前电脑的默认浏览器设置由操作系统管理；请在系统设置中把 Drip 设为默认以从链接打开页面。</small></div></div>
  </section>`);

  groups.push(`<p class="status-note">浏览历史、书签、资料名称与扩展目录保存在当前电脑。外部网页流量通过服务器通道。</p>`);

  body.innerHTML = groups.join("");
}

async function load() {
  try {
    settings = (await bridge.getSettings()) || {};
  } catch (error) {
    settings = {};
  }
  renderGroups();
  if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

body.addEventListener("change", event => {
  const el = event.target;
  const key = el.dataset.setting;
  if (!key) return;
  const value = el.type === "checkbox" ? el.checked : el.value;
  bridge.updateSetting(key, value);
});

body.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  const command = button.dataset.command;
  if (command === "choose-download-path") bridge.chooseDownloadPath();
  if (command === "clear-cache") bridge.clearCache();
  if (command === "appearance") bridge.openAppearance();
});

backHome.addEventListener("click", () => bridge.goHome());

load();
