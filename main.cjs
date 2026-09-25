const {
  app,
  BaseWindow,
  clipboard,
  WebContentsView,
  dialog,
  ipcMain,
  Menu,
  net: electronNet,
  protocol,
  safeStorage,
  session,
  shell,
  webContents
} = require("electron");
const { EventEmitter } = require("node:events");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const yaml = require("js-yaml");
const { AccountService } = require("./account-service.cjs");
const { UpdateManager } = require("./update-manager.cjs");
const { ProxyNodeStore } = require("./proxy-node-store.cjs");
const { ProxySubscriptionStore, parseSubscription } = require("./proxy-subscription-store.cjs");
const { buildProxyConfig } = require("./proxy-config.cjs");
const { normalizeBrowserRoute, proxyRulesForManual } = require("./browser-route.cjs");
const { routeUsesManagedAccess, isManagedNodeAuthorized } = require("./managed-access.cjs");
const { ProxyTrafficTracker } = require("./proxy-traffic.cjs");
const { writeElevationIntent, consumeElevationIntent } = require("./proxy-elevation.cjs");

const APP_NAME = "Drip";
const PROCESS_STARTED_AT = Date.now();
const SERVER_EGRESS_IP = process.env.DRIP_SERVER_EGRESS_IP || "";
const HOME_URL = "liquid://home/index.html";
const PROXY_CENTER_URL = "liquid://ui/proxy/index.html";
const SETTINGS_URL = "liquid://settings/index.html";
const PARTITION = "persist:liquid-browser";
const INCOGNITO_PARTITION = "liquid-incognito";
const CHROME_HEIGHT = 94;
const FAIL_CLOSED_PROXY = "http://127.0.0.1:9";
const SEARCH_ENGINES = {
  google: { label: "Google", url: query => `https://www.google.com/search?q=${encodeURIComponent(query)}` },
  bing: { label: "必应", url: query => `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
  duckduckgo: { label: "DuckDuckGo", url: query => `https://duckduckgo.com/?q=${encodeURIComponent(query)}` },
  baidu: { label: "百度", url: query => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}` }
};
const SELF_TEST = process.argv.includes("--self-test");
const VISUAL_TEST = process.argv.includes("--visual-test");
const ACCEPT_TEST = process.argv.includes("--accept");
const IMPORT_CLASH_JAPAN = process.argv.includes("--import-clash-japan");
const ELEVATION_ARGUMENT = "--drip-proxy-resume=";
const ELEVATION_NONCE = process.argv.find(argument => argument.startsWith(ELEVATION_ARGUMENT))?.slice(ELEVATION_ARGUMENT.length) || null;
const WINDOW_TITLE_SUFFIX = SELF_TEST
  ? "Drip Self Test"
  : VISUAL_TEST ? "Drip Preview" : ACCEPT_TEST ? "Drip Accept" : APP_NAME;

if (SELF_TEST || VISUAL_TEST || ACCEPT_TEST) {
  const profileName = SELF_TEST ? "Drip Self Test" : VISUAL_TEST ? "Drip Preview" : "Drip Accept";
  app.setPath("userData", path.join(app.getPath("temp"), profileName));
}

let mainWindow = null;
let chromeView = null;
let proxyView = null;
let browserSession = null;
let incognitoSession = null;
let tunnel = null;
let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let quitting = false;
let tunnelStarting = false;
let chromeOverlayOpen = false;
let appearanceSettings = null;
let accountService = null;
let updateManager = null;
let proxyNodeStore = null;
let proxySubscriptionStore = null;
let managedProxyChild = null;
let managedProxyLogStream = null;
let managedProxyStopping = false;
let managedProxySystemProxy = false;
let managedProxySystemProxyOriginal = null;
let managedProxyPort = null;
let managedProxyApiPort = null;
let managedProxyApiSecret = null;
let managedProxyTraffic = null;
let managedProxyStatsPending = null;
let managedProxyStatsTimer = null;
let managedProxyStatsError = null;
let managedProxyRules = [];
let managedProxyDelayPending = null;
let managedProxyQuitCleanup = false;
let browserRoute = { mode: "default" };
let browserRouteChild = null;
let browserRoutePort = null;
let browserRouteError = null;
let browserRouteOwnerUserId = null;
let browserRouteManagedNodeId = null;
let managedProxyOwnerUserId = null;
let accountAccessEpoch = 0;
let accountAccessFingerprint = "";
let browserRouteChange = Promise.resolve();
let managedProxyState = {
  active: false,
  starting: false,
  error: null,
  mode: "rule",
  systemProxy: true,
  tun: false,
  nodeId: "local",
  nodeName: "日本代理",
  groupName: "PROXY"
};
let saveBrowserDataTimer = null;
const startupTimings = {};

// A single browser tab. Encapsulates the WebContentsView lifecycle so that
// activations toggle visibility instead of continually detaching/reattaching
// child views (which causes reparent churn and flicker).
class Tab {
  constructor({ id, url, incognito = false, pinned = false }) {
    this.id = id;
    this.title = "新标签页";
    this.url = url;
    this.isLoading = false;
    this.isError = false;
    this.pinned = pinned;
    this.incognito = incognito;
    this.view = new WebContentsView({
      webPreferences: {
        partition: incognito ? INCOGNITO_PARTITION : PARTITION,
        preload: path.join(__dirname, "home-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        safeDialogs: true,
        spellcheck: true,
        backgroundThrottling: true
      }
    });
    this.view.setBackgroundColor("#ffffff");
    // Hide until activated; keep the chrome strip above tab views so the
    // toolbar never gets covered by content (no re-parenting on switch).
    this.view.setVisible(false);
    if (mainWindow) {
      mainWindow.contentView.addChildView(this.view);
      if (chromeView) mainWindow.contentView.addChildView(chromeView);
      if (proxyView) mainWindow.contentView.addChildView(proxyView);
    }
  }

  show() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.invalidateLayout();
    this.view.setVisible(!proxyView);
  }

  hide() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.setVisible(false);
  }

  invalidateLayout() {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getContentSize();
    const homeActive = Boolean(this.url?.startsWith("liquid://home/"));
    this.view.setBounds({
      x: 0,
      y: homeActive ? 0 : CHROME_HEIGHT,
      width,
      height: Math.max(1, height - (homeActive ? 0 : CHROME_HEIGHT))
    });
  }

  destroy() {
    if (!this.view) return;
    try { mainWindow?.contentView.removeChildView(this.view); } catch {}
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = undefined;
  }
}
let browserData = {
  profile: { name: "本地用户" },
  bookmarks: [],
  history: [],
  downloads: [],
  extensions: [],
  recentlyClosed: [],
  permissions: {},
  passwords: [],
  settings: {
    restoreSession: false,
    searchEngine: "google",
    askDownloadLocation: false,
    downloadPath: "",
    doNotTrack: false,
    contentBlocking: true,
    showBookmarksBar: false,
    sidebar: false,
    verticalTabs: false,
    passwordAutoFill: true,
    extensionDevMode: false,
    homepage: ""
  },
  session: { tabs: [], activeIndex: 0 }
};
const activeDownloads = new Map();
let connection = {
  state: "connecting",
  label: "连接中",
  detail: "正在建立服务器通道",
  egressIp: null
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "liquid",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

app.commandLine.appendSwitch("disable-quic");
app.enableSandbox();
app.setName(APP_NAME);

class TunnelManager extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.port = null;
    this.stopping = false;
    this.logStream = null;
  }

  get runtimeDirectory() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "app.asar.unpacked", "runtime");
    }
    return path.join(__dirname, "runtime");
  }

  async start() {
    this.stop();
    this.stopping = false;
    this.port = await findFreePort();

    const executable = path.join(this.runtimeDirectory, "sing-box.exe");
    const template = path.join(this.runtimeDirectory, "config.template.json");
    if (!fs.existsSync(executable) || !fs.existsSync(template)) {
      throw new Error("服务器通道运行文件不完整");
    }

    const runtimeData = path.join(app.getPath("userData"), "runtime");
    const logDirectory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(runtimeData, { recursive: true });
    fs.mkdirSync(logDirectory, { recursive: true });

    const config = JSON.parse(fs.readFileSync(template, "utf8"));
    const mixedInbound = config.inbounds?.find(inbound => inbound.type === "mixed");
    if (!mixedInbound) {
      throw new Error("服务器通道配置缺少 mixed 入口");
    }
    mixedInbound.listen = "127.0.0.1";
    mixedInbound.listen_port = this.port;

    const generatedConfig = path.join(runtimeData, "config.json");
    fs.writeFileSync(generatedConfig, JSON.stringify(config, null, 2), "utf8");

    const logPath = path.join(logDirectory, "sing-box.log");
    this.logStream = fs.createWriteStream(logPath, { flags: "w" });
    this.logStream.write(`${new Date().toISOString()} Drip tunnel starting\n`);

    this.child = spawn(executable, ["run", "-c", generatedConfig], {
      cwd: this.runtimeDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child.stdout.pipe(this.logStream, { end: false });
    this.child.stderr.pipe(this.logStream, { end: false });
    this.child.once("exit", (code, signal) => {
      const unexpected = !this.stopping;
      this.logStream?.write(`${new Date().toISOString()} tunnel exit code=${code} signal=${signal}\n`);
      this.logStream?.end();
      this.child = null;
      if (unexpected) {
        this.emit("unexpected-exit", { code, signal });
      }
    });
    this.child.once("error", error => this.emit("error", error));

    await waitForPort(this.port, this.child, 12000);
    return this.port;
  }

  stop() {
    this.stopping = true;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    this.logStream?.end();
    this.logStream = null;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPort(port, child, timeoutMs, failureDetail = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(failureDetail() || `代理内核提前退出，代码 ${child.exitCode}`);
    }
    const open = await new Promise(resolve => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = value => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(350);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
    if (open) return;
    await delay(150);
  }
  throw new Error(failureDetail() || "等待代理内核启动超时");
}

function runPowerShell(script) {
  if (process.platform !== "win32") throw new Error("系统代理仅支持 Windows");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim() || "Windows 系统代理操作失败"));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function elevationIntentPath() {
  return path.join(app.getPath("userData"), "proxy-elevation-intent.json");
}

async function isElevated() {
  const result = await runPowerShell(`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
`);
  return result.toLowerCase() === "true";
}

async function restartElevatedForTun(options) {
  if (!app.isPackaged) throw new Error("请使用已安装的 Drip 测试 TUN 管理员授权");
  const intentPath = elevationIntentPath();
  const nonce = writeElevationIntent(intentPath, options);
  const executable = Buffer.from(process.execPath, "utf8").toString("base64");
  app.releaseSingleInstanceLock();
  try {
    const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$executable = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${executable}'))
$process = Start-Process -FilePath $executable -ArgumentList '${ELEVATION_ARGUMENT}${nonce}' -Verb RunAs -PassThru
$process.Id
`);
    if (!/^\d+$/.test(output)) throw new Error("未能启动管理员进程");
    managedProxyState = { ...managedProxyState, restarting: true, error: null };
    sendState();
    setTimeout(() => app.quit(), 400);
    return managedProxyStatus();
  } catch (error) {
    fs.rmSync(intentPath, { force: true });
    if (!app.requestSingleInstanceLock()) app.quit();
    throw new Error(`管理员授权未完成，TUN 未启动：${error.message}`);
  }
}

async function readWindowsProxySettings() {
  const output = await runPowerShell(`
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
function Value($name) {
  $property = $item.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return $property.Value
}
[pscustomobject]@{
  proxyEnable = Value 'ProxyEnable'
  proxyServer = Value 'ProxyServer'
  proxyOverride = Value 'ProxyOverride'
  autoConfigUrl = Value 'AutoConfigURL'
  autoDetect = Value 'AutoDetect'
} | ConvertTo-Json -Compress
`);
  return JSON.parse(output || "{}");
}

async function writeWindowsProxySettings(settings) {
  const payload = Buffer.from(JSON.stringify(settings), "utf8").toString("base64");
  await runPowerShell(`
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$state = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', $true)
if ($null -eq $registry) { throw 'Windows 代理注册表不可用' }
function SetValue($name, $value, $type) {
  if ($null -eq $value) {
    $registry.DeleteValue($name, $false)
  } else {
    if ($type -eq 'DWord') { $registry.SetValue($name, [int]$value, [Microsoft.Win32.RegistryValueKind]::DWord) }
    else { $registry.SetValue($name, [string]$value, [Microsoft.Win32.RegistryValueKind]::String) }
  }
}
SetValue 'ProxyEnable' $state.proxyEnable 'DWord'
SetValue 'ProxyServer' $state.proxyServer 'String'
SetValue 'ProxyOverride' $state.proxyOverride 'String'
SetValue 'AutoConfigURL' $state.autoConfigUrl 'String'
SetValue 'AutoDetect' $state.autoDetect 'DWord'
$registry.Dispose()
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DripWinInet {
  [DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int length);
}
'@
[DripWinInet]::InternetSetOption([IntPtr]::Zero, 95, [IntPtr]::Zero, 0) | Out-Null
[DripWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[DripWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
`);
}

function systemProxyMarkerPath() {
  return path.join(app.getPath("userData"), "drip-system-proxy.json");
}

async function restoreStaleSystemProxy() {
  if (process.platform !== "win32") return;
  const markerPath = systemProxyMarkerPath();
  if (!fs.existsSync(markerPath)) return;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const current = await readWindowsProxySettings();
  if (marker?.owner === "drip" && marker.original && marker.applied &&
      current.proxyEnable === 1 && current.proxyServer === marker.applied) {
    await writeWindowsProxySettings(marker.original);
  }
  fs.rmSync(markerPath, { force: true });
}

async function enableManagedSystemProxy(port) {
  if (process.platform !== "win32") throw new Error("系统代理仅支持 Windows");
  if (!managedProxySystemProxyOriginal) managedProxySystemProxyOriginal = await readWindowsProxySettings();
  fs.mkdirSync(path.dirname(systemProxyMarkerPath()), { recursive: true });
  fs.writeFileSync(systemProxyMarkerPath(), JSON.stringify({
    owner: "drip", original: managedProxySystemProxyOriginal, applied: `127.0.0.1:${port}`
  }), "utf8");
  managedProxySystemProxy = true;
  await writeWindowsProxySettings({
    proxyEnable: 1,
    proxyServer: `127.0.0.1:${port}`,
    proxyOverride: managedProxySystemProxyOriginal.proxyOverride || "<local>",
    autoConfigUrl: null,
    autoDetect: 0
  });
}

async function restoreManagedSystemProxy() {
  if (!managedProxySystemProxy) return;
  const current = await readWindowsProxySettings();
  if (managedProxySystemProxyOriginal && current.proxyEnable === 1 &&
      current.proxyServer === `127.0.0.1:${managedProxyPort}`) {
    await writeWindowsProxySettings(managedProxySystemProxyOriginal);
  }
  managedProxySystemProxy = false;
  managedProxySystemProxyOriginal = null;
  try { fs.rmSync(systemProxyMarkerPath(), { force: true }); } catch {}
}

function managedProxyStatus() {
  return {
    ...managedProxyState,
    port: managedProxyState.active ? managedProxyPort : null,
    systemProxy: managedProxySystemProxy,
    apiAvailable: Boolean(managedProxyState.active && managedProxyApiPort)
  };
}

function trafficTracker() {
  if (!managedProxyTraffic) {
    managedProxyTraffic = new ProxyTrafficTracker(path.join(app.getPath("userData"), "proxy-traffic.json"));
  }
  return managedProxyTraffic;
}

function readCoreJson(port, secret, urlPath, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1", port, path: urlPath, agent: false,
      headers: { Authorization: `Bearer ${secret}` }
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`代理内核接口返回 ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          request.destroy(new Error("代理内核响应超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("代理内核响应格式无效")); }
      });
      response.once("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("代理内核接口超时")));
    request.once("error", reject);
  });
}

function writeCoreJson(port, secret, urlPath, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request({
      hostname: "127.0.0.1", port, path: urlPath, method: "PUT", agent: false,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, response => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`代理内核接口返回 ${response.statusCode}`));
          return;
        }
        resolve({ ok: true });
      });
      response.once("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("代理内核接口超时")));
    request.once("error", reject);
    request.end(body);
  });
}

function preferredCoreGroup(config, nodeName) {
  const groups = Array.isArray(config?.["proxy-groups"]) ? config["proxy-groups"] : [];
  const candidates = groups.filter(group => group?.name && Array.isArray(group.proxies) && group.proxies.includes(nodeName));
  if (!candidates.length) return "";
  const matchRule = Array.isArray(config?.rules)
    ? config.rules.find(rule => /^MATCH,/i.test(String(rule)))
    : "";
  const ruleGroup = String(matchRule || "").split(",")[1] || "";
  return candidates.find(group => group.name === ruleGroup)?.name || candidates[0].name;
}

async function selectCoreNode(port, secret, nodeName, preferredGroup = "") {
  if (!nodeName) return;
  const snapshot = await readCoreJson(port, secret, "/proxies");
  const proxies = snapshot?.proxies && typeof snapshot.proxies === "object" ? snapshot.proxies : snapshot;
  const entries = Object.entries(proxies || {}).filter(([, proxy]) =>
    proxy?.type === "Selector" && Array.isArray(proxy.all) && proxy.all.includes(nodeName)
  );
  const preferred = preferredGroup && entries.find(([name]) => name === preferredGroup);
  const group = preferred || entries[0];
  if (group) await writeCoreJson(port, secret, `/proxies/${encodeURIComponent(group[0])}`, { name: nodeName });
}

async function managedProxyStats() {
  const tracker = trafficTracker();
  if (!managedProxyState.active || !managedProxyApiPort || !managedProxyApiSecret) return tracker.current(false);
  if (managedProxyStatsPending) return managedProxyStatsPending;
  const port = managedProxyApiPort;
  managedProxyStatsPending = (async () => {
    const snapshot = await readCoreJson(port, managedProxyApiSecret, "/connections");
    if (!managedProxyState.active || managedProxyApiPort !== port) return tracker.current(false);
    return tracker.ingest(snapshot);
  })();
  try { return await managedProxyStatsPending; }
  finally { managedProxyStatsPending = null; }
}

async function runProxyDelay(port, secret, nodeName = "proxy") {
  const query = new URLSearchParams({ url: "https://www.gstatic.com/generate_204", timeout: "5000" });
  const result = await readCoreJson(port, secret, `/proxies/${encodeURIComponent(nodeName)}/delay?${query}`, 6500);
  if (!Number.isFinite(result.delay) || result.delay <= 0) throw new Error("节点未返回有效延迟");
  return { delay: result.delay };
}

async function testProxyNode(nodeId) {
  const entry = availableProxyNodes().find(item => item.id === nodeId);
  if (!entry) throw new Error("请先选择节点");
  if (managedProxyState.active) {
    if (entry.id !== managedProxyState.nodeId) throw new Error("运行中只能测试当前节点");
    return runProxyDelay(managedProxyApiPort, managedProxyApiSecret, entry.name);
  }
  if (managedProxyState.starting) throw new Error("请等待代理启动完成");
  if (managedProxyDelayPending) return managedProxyDelayPending;
  managedProxyDelayPending = (async () => {
    const baseDirectory = path.resolve(app.getPath("userData"));
    fs.mkdirSync(baseDirectory, { recursive: true });
    const directory = fs.mkdtempSync(path.join(baseDirectory, "proxy-latency-"));
    let child = null;
    let childClosed = false;
    try {
      const mixedPort = await findFreePort();
      const apiPort = await findFreePort();
      const secret = crypto.randomBytes(24).toString("hex");
      const config = buildProxyConfig(entry, { mixedPort, apiPort, apiSecret: secret, mode: "global", tun: false });
      const configPath = path.join(directory, "config.yaml");
      fs.writeFileSync(configPath, yaml.dump(config, { noRefs: true, lineWidth: -1 }), "utf8");
      const executable = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", "runtime", "mihomo.exe") : path.join(__dirname, "runtime", "mihomo.exe");
      if (!fs.existsSync(executable)) throw new Error("代理内核文件不完整");
      child = spawn(executable, ["-d", directory, "-f", configPath], {
        cwd: path.dirname(executable), windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
      });
      child.once("close", () => { childClosed = true; });
      let output = "";
      child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-4000); });
      child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-4000); });
      child.once("error", error => { output = error.message; });
      await waitForPort(apiPort, child, 8000, () => output.split(/\r?\n/).findLast(line => /FATAL|ERROR/i.test(line)) || "");
      await selectCoreNode(apiPort, secret, entry.name, preferredCoreGroup(config, entry.name));
      return await runProxyDelay(apiPort, secret, entry.name);
    } finally {
      if (child && !childClosed) {
        const closed = new Promise(resolve => {
          child.once("close", resolve);
          setTimeout(resolve, 1500).unref();
        });
        try { child.kill(); } catch {}
        await closed;
      }
      const resolved = path.resolve(directory);
      if ((!child || childClosed) && resolved.startsWith(`${baseDirectory}${path.sep}`)) fs.rmSync(resolved, { recursive: true, force: true });
    }
  })();
  try { return await managedProxyDelayPending; }
  finally { managedProxyDelayPending = null; }
}

function summarizeProxyRules(config) {
  if (Array.isArray(config.rules)) {
    return config.rules.slice(0, 80).map(rule => {
      const parts = String(rule).split(",");
      return { type: "规则", content: String(rule).slice(0, 180), outbound: parts[parts.length - 1] || "--" };
    });
  }
  const rules = (config.route?.rules || []).flatMap(rule => {
    if (rule.action === "hijack-dns") return [{ type: "DNS", content: "TUN 的 53 端口请求", outbound: "内置 DNS" }];
    if (rule.ip_is_private) return [{ type: "IP", content: "局域网及私有地址", outbound: rule.outbound }];
    if (Array.isArray(rule.domain_suffix)) {
      return rule.domain_suffix.map(suffix => ({ type: "域名后缀", content: suffix, outbound: rule.outbound }));
    }
    return [];
  });
  rules.push({ type: "兜底", content: "其余连接", outbound: config.route?.final || "direct" });
  return rules;
}

function readManagedProxyLogs() {
  const logPath = path.join(app.getPath("userData"), "proxy-runtime", "mihomo.log");
  if (!fs.existsSync(logPath)) return [];
  const fd = fs.openSync(logPath, "r");
  let raw;
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    raw = buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  return raw.split(/\r?\n/).filter(Boolean).slice(-80).map(line => {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 2000);
    const match = clean.match(/^(?:\+\d{4}\s+)?(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(INFO|WARN|ERROR|DEBUG|TRACE)\s+(.*)$/);
    return match ? { time: match[1], level: match[2], message: match[3] }
      : { time: "--", level: /FATAL|ERROR/.test(clean) ? "ERROR" : "INFO", message: clean };
  });
}

function availableProxyNodes() {
  const nodes = [];
  const account = accountService?.snapshot();
  if (account?.status === "signed-in" && account.entitlement?.active) {
    for (const managed of accountService.nodeLinks || []) {
      try {
        const node = parseSubscription(managed.url).nodes[0];
        node.name = managed.name;
        nodes.push({ id: `managed:${managed.id}`, name: managed.name,
          source: "Drip 授权线路", node });
      } catch {}
    }
  }
  try {
    nodes.push(...(proxySubscriptionStore?.listNodes() || []));
  } catch {}
  return nodes;
}

function availableProxyGroups() {
  const names = new Set();
  for (const entry of availableProxyNodes()) {
    const groups = entry.profile?.["proxy-groups"];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (typeof group?.name === "string" && group.name.trim()) names.add(group.name.trim().slice(0, 120));
    }
  }
  if (!names.size) names.add("PROXY");
  return [...names].slice(0, 50);
}

function proxyNodeList() {
  return availableProxyNodes().map(({ id, name, source }) => ({ id, name, source }));
}

function browserRoutePath() {
  return path.join(app.getPath("userData"), "browser-route.json");
}

function browserRouteSnapshot() {
  return { selected: browserRoute, nodes: proxyNodeList(), error: browserRouteError };
}

async function stopUnauthorizedManagedProxy() {
  if (!managedProxyState.nodeId?.startsWith("managed:")) return;
  const account = accountService?.snapshot();
  if (isManagedNodeAuthorized(account, managedProxyOwnerUserId,
      managedProxyState.nodeId.slice("managed:".length), id => accountService?.managedNode(id))) return;
  if (managedProxyState.active || managedProxyChild || managedProxySystemProxy) {
    await stopManagedProxy("账号线路授权已失效");
  }
}

async function revokeManagedRoutesImmediately() {
  if (browserRouteUsesManagedAccess()) {
    stopBrowserRouteCore();
    await applyActiveBrowserProxy();
  }
  await stopUnauthorizedManagedProxy();
}

function browserRouteUsesManagedAccess() {
  return routeUsesManagedAccess(browserRoute);
}

async function reconcileBrowserRoute() {
  if (!browserRouteUsesManagedAccess()) return;
  const account = accountService?.snapshot();
  const selectedId = browserRoute.mode === "default" ? accountService.nodeLinks?.[0]?.id
    : browserRoute.nodeId?.replace(/^managed:/, "");
  const selectedNode = selectedId && accountService.managedNode(selectedId);
  if (account?.status !== "signed-in" || !account.entitlement?.active || !selectedNode) {
    stopBrowserRouteCore();
    await applyActiveBrowserProxy();
    browserRouteError = "请先登录并兑换邀请码，才能使用 Drip 线路";
    connection = { state: "error", label: "尚未授权", detail: browserRouteError, egressIp: null };
    sendState();
    return;
  }
  if (browserRouteChild && browserRoutePort && isManagedNodeAuthorized(account, browserRouteOwnerUserId,
      selectedId, id => accountService?.managedNode(id)) &&
      browserRouteManagedNodeId === selectedId) return;
  stopBrowserRouteCore();
  await applyActiveBrowserProxy();
  try {
    await selectBrowserRoute(browserRoute, false);
    connection = { state: "connected", label: "Drip 线路已连接",
      detail: "当前线路由账号授权管理", egressIp: null };
  } catch (error) {
    stopBrowserRouteCore();
    await applyActiveBrowserProxy();
    browserRouteError = error.message;
    connection = { state: "error", label: "线路连接失败", detail: error.message, egressIp: null };
  }
  sendState();
}

function stopBrowserRouteCore() {
  const child = browserRouteChild;
  browserRouteChild = null;
  browserRoutePort = null;
  browserRouteOwnerUserId = null;
  browserRouteManagedNodeId = null;
  if (child && !child.killed) child.kill();
  try { fs.rmSync(path.join(app.getPath("userData"), "browser-route-runtime", "config.yaml"), { force: true }); } catch {}
}

async function startBrowserRouteCore(entry) {
  const mixedPort = await findFreePort();
  const apiPort = await findFreePort();
  const apiSecret = crypto.randomBytes(24).toString("hex");
  const dataPath = path.join(app.getPath("userData"), "browser-route-runtime");
  fs.mkdirSync(dataPath, { recursive: true });
  const config = buildProxyConfig({ node: entry.node }, { mixedPort, apiPort, apiSecret, mode: "rule", tun: false });
  const configPath = path.join(dataPath, "config.yaml");
  fs.writeFileSync(configPath, yaml.dump(config, { noRefs: true, lineWidth: -1 }), "utf8");
  const executable = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", "runtime", "mihomo.exe") : path.join(__dirname, "runtime", "mihomo.exe");
  if (!fs.existsSync(executable)) throw new Error("代理内核文件不完整");
  const child = spawn(executable, ["-d", dataPath, "-f", configPath], {
    cwd: path.dirname(executable), windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const capture = chunk => { output = (output + String(chunk)).slice(-12000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", error => capture(error.message));
  try {
    await waitForPort(mixedPort, child, 12000, () => output.split(/\r?\n/).findLast(line => /FATAL|ERROR/i.test(line)) || "");
    await waitForPort(apiPort, child, 12000, () => output.split(/\r?\n/).findLast(line => /FATAL|ERROR/i.test(line)) || "");
    await selectCoreNode(apiPort, apiSecret, entry.name);
  } catch (error) {
    child.kill();
    throw error;
  }
  child.once("exit", () => {
    if (browserRouteChild !== child || quitting) return;
    browserRouteChild = null;
    browserRoutePort = null;
    browserRouteOwnerUserId = null;
    browserRouteManagedNodeId = null;
    browserRouteError = "浏览器节点已断开，请重新选择线路";
    applyActiveBrowserProxy().catch(() => {});
    sendState();
  });
  return { child, port: mixedPort };
}

async function selectBrowserRoute(value, persist = true) {
  const next = normalizeBrowserRoute(value);
  let running = null;
  let selectedOwnerUserId = null;
  let selectedManagedNodeId = null;
  const accessEpoch = accountAccessEpoch;
  if (next.mode === "node" || next.mode === "managed" || next.mode === "default") {
    let entry;
    if (next.mode === "node") {
      entry = availableProxyNodes().find(item => item.id === next.nodeId);
      if (entry?.id.startsWith("managed:")) selectedManagedNodeId = entry.id.slice("managed:".length);
    }
    else {
      const account = accountService?.snapshot();
      if (account?.status !== "signed-in" || !account.entitlement?.active) throw new Error("请先登录并兑换邀请码，才能使用 Drip 线路");
      const id = next.mode === "managed" ? next.nodeId.replace(/^managed:/, "") : accountService.nodeLinks?.[0]?.id;
      const managed = accountService.managedNode(id);
      if (managed) {
        selectedManagedNodeId = managed.id;
        const node = parseSubscription(managed.url).nodes[0];
        node.name = managed.name;
        entry = { id: `managed:${managed.id}`, name: managed.name, node };
      }
    }
    if (!entry) throw new Error("授权节点已不存在，请重新选择");
    if (selectedManagedNodeId) selectedOwnerUserId = accountService?.snapshot().user?.id;
    running = await startBrowserRouteCore(entry);
    if (selectedManagedNodeId && (accessEpoch !== accountAccessEpoch ||
        !isManagedNodeAuthorized(accountService?.snapshot(), selectedOwnerUserId,
          selectedManagedNodeId, id => accountService?.managedNode(id)))) {
      running.child.kill();
      throw new Error("账号线路授权已失效");
    }
  }
  const oldChild = browserRouteChild;
  const oldPort = browserRoutePort;
  const previous = browserRoute;
  const oldOwnerUserId = browserRouteOwnerUserId;
  const oldManagedNodeId = browserRouteManagedNodeId;
  browserRoute = next;
  browserRouteChild = running?.child || null;
  browserRoutePort = running?.port || null;
  browserRouteOwnerUserId = selectedOwnerUserId;
  browserRouteManagedNodeId = selectedManagedNodeId;
  browserRouteError = null;
  try {
    await applyActiveBrowserProxy();
  } catch (error) {
    browserRoute = previous;
    browserRouteChild = oldChild;
    browserRoutePort = oldPort;
    browserRouteOwnerUserId = oldOwnerUserId;
    browserRouteManagedNodeId = oldManagedNodeId;
    if (running?.child) running.child.kill();
    await applyActiveBrowserProxy().catch(() => {});
    throw error;
  }
  if (oldChild && oldChild !== running?.child) oldChild.kill();
  connection = next.mode === "default" || next.mode === "managed" || next.mode === "node"
    ? { state: "connected", label: "浏览器代理已连接", detail: "当前线路已生效", egressIp: null }
    : { state: "connected", label: next.mode === "direct" ? "直连" : "系统线路", detail: "浏览器线路已生效", egressIp: null };
  if (persist) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(browserRoutePath(), JSON.stringify(next), "utf8");
  }
  sendState();
  return browserRouteSnapshot();
}

function activeBrowserProxyRules() {
  if (browserRouteChild && browserRoutePort) return `http://127.0.0.1:${browserRoutePort}`;
  return FAIL_CLOSED_PROXY;
}

async function applyActiveBrowserProxy() {
  let options;
  if (browserRoute.mode === "direct") options = { mode: "direct" };
  else if (browserRoute.mode === "system") options = { mode: "system" };
  else {
    const proxyRules = browserRoute.mode === "manual" ? proxyRulesForManual(browserRoute)
      : ["node", "managed"].includes(browserRoute.mode) ? (browserRouteChild && browserRoutePort ? `http://127.0.0.1:${browserRoutePort}` : FAIL_CLOSED_PROXY)
      : activeBrowserProxyRules();
    options = { mode: "fixed_servers", proxyRules };
  }
  for (const target of allBrowserSessions()) {
    await target.setProxy(options);
    await target.closeAllConnections();
  }
}

async function stopManagedProxy(reason = "代理已停止") {
  if (managedProxyStatsTimer) clearInterval(managedProxyStatsTimer);
  managedProxyStatsTimer = null;
  managedProxyStatsError = null;
  const child = managedProxyChild;
  managedProxyChild = null;
  managedProxyStopping = true;
  let restoreError = null;
  try {
    try { await restoreManagedSystemProxy(); } catch (error) { restoreError = error; }
    if (child && !child.killed) child.kill();
    try { fs.rmSync(path.join(app.getPath("userData"), "proxy-runtime", "config.yaml"), { force: true }); } catch {}
    managedProxyLogStream?.end();
    managedProxyLogStream = null;
    if (!restoreError) managedProxyPort = null;
    managedProxyApiPort = null;
    managedProxyApiSecret = null;
    managedProxyOwnerUserId = null;
    managedProxyState = {
      ...managedProxyState,
      active: false,
      starting: false,
      error: reason === "代理已停止" ? null : reason
    };
    await applyActiveBrowserProxy();
  } finally {
    try { managedProxyTraffic?.save(); } catch (error) { console.error("Failed to save proxy traffic:", error); }
    managedProxyStopping = false;
    sendState();
  }
  if (restoreError) throw restoreError;
}

async function startManagedProxy(options = {}) {
  if (managedProxyState.active) {
    await stopUnauthorizedManagedProxy();
    if (managedProxyState.active) return managedProxyStatus();
  }
  if (managedProxyState.starting) throw new Error("代理正在启动");
  await restoreStaleSystemProxy();
  const nodes = availableProxyNodes();
  const nodeEntry = nodes.find(item => item.id === (options.nodeId || managedProxyState.nodeId)) || (!options.nodeId && nodes[0]);
  if (!nodeEntry) throw new Error("请先兑换邀请码或添加订阅");
  const selectedManagedId = nodeEntry.id.startsWith("managed:") ? nodeEntry.id.slice("managed:".length) : null;
  const ownerUserId = selectedManagedId ? accountService?.snapshot().user?.id : null;
  const accessEpoch = accountAccessEpoch;
  const mode = ["rule", "global", "direct"].includes(options.mode) ? options.mode : managedProxyState.mode;
  const systemProxy = options.systemProxy !== false;
  const tun = options.tun === true;
  const requestedGroup = typeof options.groupName === "string" ? options.groupName.trim().slice(0, 120) : "";
  if (selectedManagedId && (accessEpoch !== accountAccessEpoch ||
      !isManagedNodeAuthorized(accountService?.snapshot(), ownerUserId,
        selectedManagedId, id => accountService?.managedNode(id)))) throw new Error("账号线路授权已失效");
  if (tun && !await isElevated()) {
    if (selectedManagedId && (accessEpoch !== accountAccessEpoch ||
        !isManagedNodeAuthorized(accountService?.snapshot(), ownerUserId,
          selectedManagedId, id => accountService?.managedNode(id)))) throw new Error("账号线路授权已失效");
    if (ELEVATION_NONCE) throw new Error("管理员身份未生效，TUN 没有启动");
    return restartElevatedForTun({ nodeId: nodeEntry.id, groupName: requestedGroup, mode, systemProxy, tun });
  }
  managedProxyState = { ...managedProxyState, active: false, starting: true, error: null, mode, systemProxy, tun, nodeId: nodeEntry.id, nodeName: nodeEntry.name, groupName: requestedGroup || managedProxyState.groupName };
  managedProxyOwnerUserId = ownerUserId;
  sendState();
  try {
    managedProxyPort = await findFreePort();
    managedProxyApiPort = await findFreePort();
    managedProxyApiSecret = crypto.randomBytes(24).toString("hex");
    const config = buildProxyConfig(nodeEntry, {
      mixedPort: managedProxyPort,
      apiPort: managedProxyApiPort,
      apiSecret: managedProxyApiSecret,
      mode,
      tun
    });
    const configuredGroup = Array.isArray(config["proxy-groups"])
      ? config["proxy-groups"].find(group => group?.name === requestedGroup && Array.isArray(group.proxies) && group.proxies.includes(nodeEntry.name))?.name
      : "";
    const groupName = configuredGroup || preferredCoreGroup(config, nodeEntry.name);
    managedProxyState = { ...managedProxyState, groupName };
    managedProxyRules = summarizeProxyRules(config);
    const runtimeData = path.join(app.getPath("userData"), "proxy-runtime");
    fs.mkdirSync(runtimeData, { recursive: true });
    const configPath = path.join(runtimeData, "config.yaml");
    fs.writeFileSync(configPath, yaml.dump(config, { noRefs: true, lineWidth: -1 }), "utf8");
    const logPath = path.join(runtimeData, "mihomo.log");
    managedProxyLogStream = fs.createWriteStream(logPath, { flags: "w" });
    const executable = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", "runtime", "mihomo.exe") : path.join(__dirname, "runtime", "mihomo.exe");
    const runtimeDirectory = path.dirname(executable);
    if (!fs.existsSync(executable)) throw new Error("代理内核文件不完整");
    managedProxyChild = spawn(executable, ["-d", runtimeData, "-f", configPath], { cwd: runtimeDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let startupOutput = "";
    const captureOutput = chunk => { startupOutput = (startupOutput + String(chunk)).slice(-12000); };
    const failureDetail = () => {
      const fatal = startupOutput.split(/\r?\n/).findLast(line => /FATAL|ERROR/i.test(line));
      return fatal ? `代理内核启动失败：${fatal.trim()}` : "";
    };
    managedProxyChild.stdout.on("data", captureOutput);
    managedProxyChild.stderr.on("data", captureOutput);
    managedProxyChild.stdout.pipe(managedProxyLogStream, { end: false });
    managedProxyChild.stderr.pipe(managedProxyLogStream, { end: false });
    const childRef = managedProxyChild;
    managedProxyChild.once("exit", () => {
      if (managedProxyChild === childRef) {
        managedProxyChild = null;
        if (!managedProxyStopping && !managedProxyState.starting) stopManagedProxy("代理内核已退出").catch(() => {});
      }
    });
    managedProxyChild.once("error", error => {
      if (!managedProxyStopping && !managedProxyState.starting) stopManagedProxy(error.message).catch(() => {});
    });
    await waitForPort(managedProxyPort, managedProxyChild, 12000, failureDetail);
    await waitForPort(managedProxyApiPort, managedProxyChild, 12000, failureDetail);
    await selectCoreNode(managedProxyApiPort, managedProxyApiSecret, nodeEntry.name, groupName);
    if (selectedManagedId && (accessEpoch !== accountAccessEpoch ||
        !isManagedNodeAuthorized(accountService?.snapshot(), ownerUserId,
          selectedManagedId, id => accountService?.managedNode(id)))) throw new Error("账号线路授权已失效");
    trafficTracker().beginRun();
    managedProxyStatsError = null;
    managedProxyState = { ...managedProxyState, active: true, starting: false, error: null };
    if (systemProxy) await enableManagedSystemProxy(managedProxyPort);
    if (selectedManagedId && (accessEpoch !== accountAccessEpoch ||
        !isManagedNodeAuthorized(accountService?.snapshot(), ownerUserId,
          selectedManagedId, id => accountService?.managedNode(id)))) throw new Error("账号线路授权已失效");
    await applyActiveBrowserProxy();
    managedProxyStatsTimer = setInterval(() => {
      managedProxyStats().then(() => { managedProxyStatsError = null; })
        .catch(error => { managedProxyStatsError = error.message; });
    }, 1000);
    sendState();
    return managedProxyStatus();
  } catch (error) {
    await stopManagedProxy(error.message).catch(() => {});
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function sanitizeAppearance(value) {
  const src = value && typeof value === "object" ? value : {};
  const bounded = (candidate, min, max, fallback) => {
    const n = Number(candidate);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const hexColor = (candidate, fallback) =>
    /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
  return {
    chromeGlass: src.chromeGlass !== false,
    chromeGlassColor: hexColor(src.chromeGlassColor, "#12304f"),
    chromeGlassAlpha: bounded(src.chromeGlassAlpha, 0, 100, 0),
    chromeBlur: bounded(src.chromeBlur, 0, 60, 60),
    theme: src.theme === "light" ? "light" : "dark",
    background: src.background === "aurora" ? "aurora" : "video",
    bgBlur: bounded(src.bgBlur, 0, 60, 0)
  };
}

function loadBrowserData() {
  const filePath = path.join(app.getPath("userData"), "browser-data.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    browserData = {
      profile: {
        name: cleanTitle(parsed.profile?.name || "本地用户").slice(0, 24) || "本地用户"
      },
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks.slice(0, 200) : [],
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 500) : [],
      downloads: Array.isArray(parsed.downloads) ? parsed.downloads.slice(0, 200) : [],
      extensions: Array.isArray(parsed.extensions) ? parsed.extensions.slice(0, 50) : [],
      recentlyClosed: Array.isArray(parsed.recentlyClosed) ? parsed.recentlyClosed.slice(0, 20) : [],
      permissions: parsed.permissions && typeof parsed.permissions === "object" ? parsed.permissions : {},
      passwords: Array.isArray(parsed.passwords) ? parsed.passwords.slice(0, 200) : [],
      settings: {
        restoreSession: Boolean(parsed.settings?.restoreSession),
        searchEngine: SEARCH_ENGINES[parsed.settings?.searchEngine] ? parsed.settings.searchEngine : "google",
        askDownloadLocation: Boolean(parsed.settings?.askDownloadLocation),
        downloadPath: typeof parsed.settings?.downloadPath === "string" ? parsed.settings.downloadPath : "",
        doNotTrack: Boolean(parsed.settings?.doNotTrack),
        contentBlocking: parsed.settings?.contentBlocking !== false,
        showBookmarksBar: Boolean(parsed.settings?.showBookmarksBar),
        sidebar: Boolean(parsed.settings?.sidebar),
        verticalTabs: Boolean(parsed.settings?.verticalTabs),
        passwordAutoFill: parsed.settings?.passwordAutoFill !== false,
        extensionDevMode: Boolean(parsed.settings?.extensionDevMode),
        homepage: typeof parsed.settings?.homepage === "string" ? parsed.settings.homepage : ""
      },
      session: {
        tabs: Array.isArray(parsed.session?.tabs)
          ? parsed.session.tabs.filter(item => isAllowedNavigation(item?.url)).slice(0, 8)
          : [],
        activeIndex: Math.max(0, Number(parsed.session?.activeIndex) || 0)
      }
    };
  } catch {
  }
}

function captureSession() {
  const persistable = tabs.filter(tab => !tab.incognito);
  if (!persistable.length) return;
  browserData.session = {
    tabs: persistable.slice(0, 8).map(tab => ({
      url: sanitizeTarget(tab.url),
      title: cleanTitle(tab.title) || "新标签页"
    })),
    activeIndex: Math.max(0, persistable.findIndex(tab => tab.id === activeTabId))
  };
}

function scheduleSessionSave() {
  captureSession();
  scheduleBrowserDataSave();
}

function originFrom(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

function saveBrowserData() {
  clearTimeout(saveBrowserDataTimer);
  saveBrowserDataTimer = null;
  const directory = app.getPath("userData");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "browser-data.json"), JSON.stringify(browserData, null, 2), "utf8");
}

function scheduleBrowserDataSave() {
  clearTimeout(saveBrowserDataTimer);
  saveBrowserDataTimer = setTimeout(saveBrowserData, 250);
}

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function recordHistory(url, title) {
  if (!isWebUrl(url)) return;
  const now = Date.now();
  const recent = browserData.history[0];
  if (recent?.url === url && now - recent.visitedAt < 5000) {
    recent.title = cleanTitle(title) || recent.title || url;
    recent.visitedAt = now;
  } else {
    browserData.history.unshift({
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: cleanTitle(title) || url,
      visitedAt: now
    });
    browserData.history = browserData.history.slice(0, 500);
  }
  scheduleBrowserDataSave();
}

function updateRecentHistoryTitle(url, title) {
  const entry = browserData.history.find(item => item.url === url);
  if (!entry) return;
  entry.title = cleanTitle(title) || entry.title;
  scheduleBrowserDataSave();
}

function rangeCutoffForHistory(range) {
  const milliseconds = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000
  }[range];
  return milliseconds ? Date.now() - milliseconds : 0;
}

function clearHistoryForRange(range) {
  if (!range || range === "all") {
    browserData.history = [];
    return;
  }
  const cutoff = rangeCutoffForHistory(range);
  browserData.history = browserData.history.filter(item => Number(item.visitedAt) < cutoff);
}

// ---- P4 Min 式隐私：全文本历史 ----
// Min 会为浏览过的页面建立全文索引，历史检索不仅匹配标题/URL，还能命中正文关键词。
// Drip 同样为每次访问的网页提取正文文本并随历史条目保存（截断以控制体积），
// 检索时对标题、URL 与正文做包含匹配。非 http(s) 页面与隐身窗口一律不采集。
const HISTORY_TEXT_LIMIT = 6000;

async function extractPageBodyText(contents) {
  try {
    if (!contents || contents.isDestroyed()) return "";
    const text = await contents.executeJavaScript(
      "(function () { try { var el = document.body || document.documentElement; var t = el ? el.innerText : ''; return String(t).replace(/\\s+/g, ' ').trim(); } catch (e) { return ''; } })()"
    );
    return typeof text === "string" ? text.slice(0, HISTORY_TEXT_LIMIT) : "";
  } catch {
    return "";
  }
}

function attachHistoryText(url, text) {
  if (!url || !text) return;
  const entry = browserData.history.find(item => item.url === url && !item.text);
  if (!entry) return;
  entry.text = text;
  entry.snippet = text.slice(0, 200);
  scheduleBrowserDataSave();
}

function uniqueDownloadPath(filename) {
  const directory = app.getPath("downloads");
  const safeName = path.basename(filename || "download").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const extension = path.extname(safeName);
  const stem = path.basename(safeName, extension);
  let candidate = path.join(directory, safeName);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${stem} (${suffix++})${extension}`);
  }
  return candidate;
}

function isInside(baseDirectory, candidate) {
  const relative = path.relative(baseDirectory, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function registerLocalProtocol(protocolApi = protocol) {
  protocolApi.handle("liquid", request => {
    const url = new URL(request.url);
    let baseDirectory;
    let relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");

    if (url.host === "home") {
      baseDirectory = path.join(__dirname, "home");
      relativePath ||= "index.html";
    } else if (url.host === "assets") {
      baseDirectory = path.join(__dirname, "assets");
      relativePath ||= "icon.png";
    } else if (url.host === "ui") {
      baseDirectory = path.join(__dirname, "ui");
      relativePath ||= "chrome.html";
    } else if (url.host === "settings") {
      baseDirectory = path.join(__dirname, "ui", "settings");
      relativePath ||= "index.html";
    } else {
      return new Response("Not found", { status: 404 });
    }

    const filePath = path.resolve(baseDirectory, relativePath);
    if (!isInside(baseDirectory, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return new Response("Not found", { status: 404 });
    }

    return electronNet.fetch(pathToFileURL(filePath).toString(), {
      method: request.method,
      headers: request.headers
    });
  });
}

async function failClosed(reason) {
  if (managedProxyState.active) {
    connection = {
      state: "error",
      label: "服务器通道断开",
      detail: reason || "服务器通道不可用，但代理中心仍在运行",
      egressIp: null
    };
    sendState();
    return;
  }
  await applyActiveBrowserProxy();
  connection = {
    state: "error",
    label: "服务器断开",
    detail: reason || "服务器通道不可用，已禁止直接联网",
    egressIp: null
  };
  sendState();
}

async function startTunnel() {
  if (tunnelStarting) return;
  tunnelStarting = true;
  connection = {
    state: "connecting",
    label: "连接中",
    detail: "正在验证服务器出口",
    egressIp: null
  };
  sendState();

  try {
    tunnel?.stop();
    tunnel = new TunnelManager();
    tunnel.on("unexpected-exit", () => {
      failClosed("服务器通道进程已退出，已禁止直接联网").catch(() => {});
    });
    tunnel.on("error", error => {
      failClosed(error.message).catch(() => {});
    });

    const port = await tunnel.start();
    await applyActiveBrowserProxy();

    const verificationSession = session.fromPartition("drip-tunnel-verification");
    await verificationSession.setProxy({ mode: "fixed_servers", proxyRules: `http://127.0.0.1:${port}` });
    const proxyResolution = await verificationSession.resolveProxy("https://api.ipify.org/");
    if (!proxyResolution.includes(`127.0.0.1:${port}`)) {
      throw new Error(`浏览器未采用专属代理：${proxyResolution}`);
    }

    const response = await verificationSession.fetch("https://api.ipify.org/", {
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });
    const egressIp = (await response.text()).trim();
    if (!response.ok || egressIp !== SERVER_EGRESS_IP) {
      throw new Error(`服务器出口校验失败：${egressIp || response.status}`);
    }

    connection = {
      state: "connected",
      label: "服务器已连接",
      detail: `所有网页流量经由 ${egressIp}`,
      egressIp
    };
    await updateManager?.useTunnel(port).catch(() => {});
    startupTimings.tunnelReadyMilliseconds ||= Date.now() - PROCESS_STARTED_AT;
    sendState();
    if (!SELF_TEST) accountService?.restore().catch(() => {});
    if (!SELF_TEST) updateManager?.schedule();
  } catch (error) {
    tunnel?.stop();
    await failClosed(error.message);
    if (SELF_TEST) throw error;
  } finally {
    tunnelStarting = false;
  }
}

function allBrowserSessions() {
  return [browserSession, incognitoSession].filter(Boolean);
}

function wireDownloadItem(item) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const suggestedPath = uniqueDownloadPath(item.getFilename());
  item.pause();

  const register = savePath => {
    item.setSavePath(savePath);
    const entry = {
      id,
      filename: path.basename(savePath),
      savePath,
      url: item.getURL(),
      state: "progressing",
      paused: false,
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now()
    };
    browserData.downloads.unshift(entry);
    browserData.downloads = browserData.downloads.slice(0, 200);
    activeDownloads.set(id, item);
    scheduleBrowserDataSave();
    sendState();

    item.on("updated", (_updatedEvent, state) => {
      entry.state = state;
      entry.paused = item.isPaused();
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes();
      entry.bytesPerSecond = item.getCurrentBytesPerSecond();
      sendState();
    });
    item.once("done", (_doneEvent, state) => {
      entry.state = state;
      entry.paused = false;
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes();
      entry.finishedAt = Date.now();
      activeDownloads.delete(id);
      scheduleBrowserDataSave();
      sendState();
    });
    item.resume();
  };

  if (!browserData.settings.askDownloadLocation) {
    register(suggestedPath);
    return;
  }
  dialog.showSaveDialog(mainWindow, {
    title: "保存文件",
    defaultPath: suggestedPath
  }).then(result => {
    if (result.canceled || !result.filePath) {
      item.cancel();
      return;
    }
    register(result.filePath);
  }).catch(() => item.cancel());
}

function applyDoNotTrack(target) {
  target.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (browserData.settings.doNotTrack) requestHeaders.DNT = "1";
    callback({ requestHeaders });
  });
}

// ---- P4 Min 式隐私：内容拦截 ----
// 自研内置拦截清单（去广告/追踪域名），零外部依赖、无需联网拉取过滤规则。
// 仅拦截已知的广告/追踪主机，不触碰正常站点，保证 fail-closed 代理与自检不受影响。
// Min 浏览器基于 uBlock Origin；这里遵循同样的"默认拦截常用广告/追踪"理念，用精简清单实现。
const AD_BLOCK_HOSTS = new Set([
  "doubleclick.net", "googlesyndication.com", "googletagmanager.com", "googletagservices.com",
  "googleadservices.com", "google-analytics.com", "adservice.google.com", "adsafeprotected.com",
  "scorecardresearch.com", "adnxs.com", "adsrvr.org", "moatads.com", "criteo.com", "criteo.net",
  "taboola.com", "outbrain.com", "pubmatic.com", "rubiconproject.com", "openx.net", "demdex.net",
  "amazon-adsystem.com", "zedo.com", "yieldmo.com", "lijit.com", "adroll.com", "quantcast.com",
  "quantserve.com", "segment.com", "branch.io", "mixpanel.com", "amplitude.com", "hotjar.com",
  "clarity.ms", "braze.com", "onesignal.com", "pushwoosh.com", "adjust.com", "appsflyer.com",
  "chartbeat.com", "parsely.com", "nielsen.com", "krxd.net", "e-planning.net", "smartadserver.com",
  "serving-sys.com", "teads.tv", "media.net", "undertone.com", "yieldmanager.com", "revsci.net"
]);

function isBlockedRequest(details) {
  try {
    const host = new URL(details.url).hostname.toLowerCase();
    if (!host || host.length < 3) return false;
    if (AD_BLOCK_HOSTS.has(host)) return true;
    // 命中清单域名作为主域时，其任意子域一并拦截。
    const parts = host.split(".");
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (AD_BLOCK_HOSTS.has(parts.slice(i).join("."))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function applyContentBlocking(target) {
  // 单一监听器在请求时读取当前开关，切换开关无需重新注册，两个会话各自注册一次。
  target.webRequest.onBeforeRequest((details, callback) => {
    if (!browserData.settings.contentBlocking) { callback({}); return; }
    if (details.url && isBlockedRequest(details)) { callback({ cancel: true }); return; }
    callback({});
  });
}

function configureSession(target, { persist }) {
  registerLocalProtocol(target.protocol);
  target.setDownloadPath(browserData.settings.downloadPath || app.getPath("downloads"));
  target.on("will-download", (_event, item) => wireDownloadItem(item));
  applyDoNotTrack(target);
  applyContentBlocking(target);
  target.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission === "fullscreen" || permission === "clipboard-sanitized-write") return true;
    const origin = originFrom(requestingOrigin || details?.requestingUrl || details?.embeddingOrigin);
    return persist && browserData.permissions[origin]?.[permission] === "allow";
  });
  if (!persist) {
    target.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "fullscreen" || permission === "clipboard-sanitized-write");
    });
    return;
  }

  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === "fullscreen" || permission === "clipboard-sanitized-write") {
      callback(true);
      return;
    }
    if (SELF_TEST) {
      callback(false);
      return;
    }

    const requestingOrigin = originFrom(details.requestingUrl || webContents.getURL());
    const remembered = browserData.permissions[requestingOrigin]?.[permission];
    if (remembered === "allow") {
      callback(true);
      return;
    }

    let origin = "该网站";
    try { origin = new URL(requestingOrigin).hostname || origin; } catch {
    }
    const labels = {
      media: "摄像头或麦克风",
      geolocation: "位置信息",
      notifications: "通知",
      "clipboard-read": "剪贴板"
    };
    const label = labels[permission];
    if (!label) {
      callback(false);
      return;
    }

    dialog.showMessageBox({
      type: "question",
      title: "网站权限",
      message: `${origin} 请求使用${label}`,
      detail: "仅在你确认信任该网站时允许。",
      buttons: ["拒绝", "仅本次允许", "总是允许"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }).then(result => {
      if (result.response === 2 && requestingOrigin) {
        browserData.permissions[requestingOrigin] ||= {};
        browserData.permissions[requestingOrigin][permission] = "allow";
        scheduleBrowserDataSave();
        sendState();
      }
      callback(result.response === 1 || result.response === 2);
    }).catch(() => callback(false));
  });
}

function setupBrowserSession() {
  browserSession = session.fromPartition(PARTITION, { cache: true });
  incognitoSession = session.fromPartition(INCOGNITO_PARTITION);
  configureSession(browserSession, { persist: true });
  configureSession(incognitoSession, { persist: false });
  // 注入扩展 API 兼容层 shim，仅对扩展自身页面生效（见 extension-preload.cjs）。
  try {
    browserSession.registerPreloadScript({ type: "frame", filePath: path.join(__dirname, "extension-preload.cjs") });
  } catch {
  }
}

async function loadPersistedExtensions() {
  const loaded = [];
  for (const saved of browserData.extensions) {
    if (saved?.enabled === false) {
      loaded.push({ ...saved, enabled: false });
      continue;
    }
    if (!saved?.path || !fs.existsSync(saved.path)) continue;
    try {
      const extension = await browserSession.extensions.loadExtension(saved.path, { allowFileAccess: false });
      loaded.push({ id: extension.id, name: extension.name, version: extension.version, path: saved.path, enabled: true });
    } catch {
    }
  }
  browserData.extensions = loaded;
  scheduleBrowserDataSave();
}

function createWindow() {
  mainWindow = new BaseWindow({
    width: 1440,
    height: 920,
    minWidth: 920,
    minHeight: 640,
    show: !SELF_TEST,
    title: WINDOW_TITLE_SUFFIX,
    backgroundColor: "#101724",
    autoHideMenuBar: true,
    frame: false,
    icon: path.join(__dirname, "assets", "icon.ico")
  });

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  chromeView.setBackgroundColor("#00000000");
  mainWindow.contentView.addChildView(chromeView);
  chromeView.webContents.loadURL("liquid://ui/chrome.html");
  chromeView.webContents.on("did-finish-load", () => {
    startupTimings.chromeReadyMilliseconds ||= Date.now() - PROCESS_STARTED_AT;
    sendState();
  });

  mainWindow.on("resize", layoutViews);
  mainWindow.on("maximize", sendState);
  mainWindow.on("unmaximize", sendState);
  mainWindow.on("app-command", (_event, command) => {
    const tab = getActiveTab();
    if (command === "browser-backward" && tab?.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack();
    }
    if (command === "browser-forward" && tab?.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.navigationHistory.goForward();
    }
  });
  mainWindow.on("closed", () => {
    for (const tab of tabs) tab.destroy();
    tabs = [];
    if (proxyView && !proxyView.webContents.isDestroyed()) proxyView.webContents.close();
    proxyView = null;
    if (chromeView && !chromeView.webContents.isDestroyed()) chromeView.webContents.close();
    chromeView = null;
    mainWindow = null;
  });

  createTab(HOME_URL, true);
  layoutViews();
}

function restoreStartupSession(savedSession) {
  const savedTabs = savedSession?.tabs?.filter(item => isAllowedNavigation(item?.url)).slice(0, 8) || [];
  if (!savedTabs.length) return;

  const startupTab = tabs[0];
  if (startupTab) startupTab.destroy();
  tabs = [];
  activeTabId = null;

  for (const item of savedTabs) createTab(item.url, false);
  const activeIndex = Math.min(Math.max(0, Number(savedSession.activeIndex) || 0), tabs.length - 1);
  activateTab(tabs[activeIndex].id);
}

function layoutViews() {
  if (!mainWindow || !chromeView) return;
  const [width, height] = mainWindow.getContentSize();
  chromeView.setBounds({ x: 0, y: 0, width, height: chromeOverlayOpen ? height : CHROME_HEIGHT });
  getActiveTab()?.invalidateLayout();
  if (proxyView) proxyView.setBounds({ x: 0, y: 0, width, height });
}

function openProxyCenter() {
  if (!mainWindow) return Promise.resolve();
  if (proxyView) {
    proxyView.webContents.focus();
    return Promise.resolve();
  }
  proxyView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "proxy-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  proxyView.setBackgroundColor("#12253d");
  proxyView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  proxyView.webContents.on("will-navigate", event => event.preventDefault());
  chromeView?.setVisible(false);
  getActiveTab()?.hide();
  mainWindow.contentView.addChildView(proxyView);
  layoutViews();
  return proxyView.webContents.loadURL(PROXY_CENTER_URL);
}

function closeProxyCenter() {
  if (!proxyView) return;
  const view = proxyView;
  proxyView = null;
  try { mainWindow?.contentView.removeChildView(view); } catch {}
  if (!view.webContents.isDestroyed()) view.webContents.close();
  chromeView?.setVisible(true);
  getActiveTab()?.show();
  getActiveTab()?.view.webContents.focus();
}

function createTab(initialUrl = HOME_URL, activate = true, options = {}) {
  const tab = new Tab({ id: nextTabId++, url: initialUrl, incognito: Boolean(options.incognito), pinned: Boolean(options.pinned) });
  tabs.push(tab);
  wireTab(tab);
  tab.view.webContents.loadURL(sanitizeTarget(initialUrl));
  if (options.pinned) pinTab(tab.id, true);
  emitTabCreated(tab);
  if (activate) activateTab(tab.id);
  scheduleSessionSave();
  sendState();
  return tab;
}

function showPageContextMenu(tab, params) {
  const contents = tab.view.webContents;
  const template = [];

  if (params.linkURL) {
    template.push(
      { label: "在新标签页中打开链接", click: () => createTab(params.linkURL, true) },
      { label: "复制链接地址", click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" }
    );
  }

  if (params.mediaType === "image" && params.srcURL) {
    template.push(
      { label: "在新标签页中打开图片", click: () => createTab(params.srcURL, true) },
      { label: "保存图片", click: () => contents.downloadURL(params.srcURL) },
      { type: "separator" }
    );
  }

  if (params.isEditable) {
    template.push(
      { label: "撤销", role: "undo", enabled: params.editFlags.canUndo },
      { label: "重做", role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { label: "剪切", role: "cut", enabled: params.editFlags.canCut },
      { label: "复制", role: "copy", enabled: params.editFlags.canCopy },
      { label: "粘贴", role: "paste", enabled: params.editFlags.canPaste },
      { label: "全选", role: "selectAll", enabled: params.editFlags.canSelectAll },
      { type: "separator" }
    );
  } else if (params.selectionText) {
    const selected = cleanTitle(params.selectionText).slice(0, 60);
    template.push(
      { label: "复制", role: "copy" },
      { label: `使用 ${SEARCH_ENGINES[browserData.settings.searchEngine]?.label || "Google"} 搜索“${selected}”`, click: () => createTab(normalizeAddress(params.selectionText), true) },
      { type: "separator" }
    );
  }

  template.push(
    { label: "后退", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
    { label: "前进", enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
    { label: "重新加载", click: () => contents.reload() },
    { type: "separator" },
    { label: "打印", click: () => contents.print({ printBackground: true }) },
    { label: "检查", click: () => contents.inspectElement(params.x, params.y) }
  );

  Menu.buildFromTemplate(template).popup({ window: mainWindow });
}

function wireTab(tab) {
  const contents = tab.view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    setImmediate(() => createTab(sanitizeTarget(url), true));
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  contents.on("did-start-loading", () => {
    tab.isLoading = true;
    sendState();
    emitTabUpdated(tab, { status: "loading" });
  });
  contents.on("did-stop-loading", () => {
    tab.isLoading = false;
    const loadedUrl = contents.getURL();
    if (loadedUrl.startsWith("liquid://ui/error.html")) {
      try { tab.url = new URL(loadedUrl).searchParams.get("target") || tab.url; } catch {
      }
      tab.isError = true;
    } else {
      tab.url = loadedUrl || tab.url;
    }
    if (!tab.incognito && isWebUrl(tab.url)) {
      const targetUrl = tab.url;
      extractPageBodyText(contents).then(text => attachHistoryText(targetUrl, text));
    }
    if (tab.url.startsWith("liquid://home/")) {
      startupTimings.homeReadyMilliseconds ||= Date.now() - PROCESS_STARTED_AT;
    }
    if (tab.id === activeTabId) layoutViews();
    scheduleSessionSave();
    sendState();
    emitTabUpdated(tab, { status: "complete", url: tab.url });
  });
  contents.on("page-title-updated", (_event, title) => {
    tab.title = cleanTitle(title) || "新标签页";
    if (!tab.incognito) updateRecentHistoryTitle(contents.getURL(), tab.title);
    if (tab.id === activeTabId && mainWindow) mainWindow.setTitle(`${tab.title} - ${WINDOW_TITLE_SUFFIX}`);
    scheduleSessionSave();
    sendState();
    emitTabUpdated(tab, { title: tab.title });
  });
  contents.on("did-navigate", (_event, url) => {
    if (url.startsWith("liquid://ui/error.html")) {
      try { tab.url = new URL(url).searchParams.get("target") || tab.url; } catch {
      }
      tab.isError = true;
      sendState();
      return;
    }
    tab.url = url;
    tab.isError = false;
    if (!tab.incognito) recordHistory(url, tab.title);
    if (tab.id === activeTabId) layoutViews();
    scheduleSessionSave();
    sendState();
    emitTabUpdated(tab, { url: tab.url });
  });
  contents.on("did-navigate-in-page", (_event, url) => {
    tab.url = url;
    if (!tab.incognito) recordHistory(url, tab.title);
    if (tab.id === activeTabId) layoutViews();
    sendState();
    emitTabUpdated(tab, { url: tab.url });
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      tab.title = description || "页面加载失败";
      tab.url = url || tab.url;
      tab.isLoading = false;
      tab.isError = true;
      const failurePage = `liquid://ui/error.html?code=${encodeURIComponent(code)}&message=${encodeURIComponent(description || "页面加载失败")}&target=${encodeURIComponent(url || tab.url)}`;
      setImmediate(() => {
        if (!contents.isDestroyed()) contents.loadURL(failurePage).catch(() => {});
      });
      sendState();
    }
  });
  contents.on("render-process-gone", () => {
    tab.title = "页面进程异常";
    tab.isLoading = false;
    tab.isError = true;
    const failurePage = `liquid://ui/error.html?message=${encodeURIComponent("网页进程已停止")}&target=${encodeURIComponent(tab.url)}`;
    setImmediate(() => {
      if (!contents.isDestroyed()) contents.loadURL(failurePage).catch(() => {});
    });
    sendState();
  });
  contents.on("found-in-page", (_event, result) => {
    if (tab.id === activeTabId) chromeView?.webContents.send("browser:find-result", result);
  });
  contents.on("context-menu", (_event, params) => showPageContextMenu(tab, params));
  contents.on("before-input-event", (event, input) => handleBrowserShortcut(event, input, tab));
}

function handleBrowserShortcut(event, input, tab) {
  if (input.type !== "keyDown") return;
  const key = input.key.toLowerCase();
  if (input.control && key === "l") {
    event.preventDefault();
    chromeView?.webContents.send("browser:focus-address");
  } else if (input.control && input.shift && key === "t") {
    event.preventDefault();
    reopenLastClosedTab();
  } else if (input.control && input.shift && key === "n") {
    event.preventDefault();
    createTab(HOME_URL, true, { incognito: true });
  } else if (input.control && key === "t") {
    event.preventDefault();
    createTab(HOME_URL, true);
  } else if (input.control && key === "w") {
    event.preventDefault();
    closeTab(tab.id);
  } else if ((input.control && key === "r") || key === "f5") {
    event.preventDefault();
    reloadActiveTab();
  } else if (input.control && key === "d") {
    event.preventDefault();
    toggleActiveBookmark();
  } else if (input.control && key === "h") {
    event.preventDefault();
    chromeView?.webContents.send("browser:open-module", "history");
  } else if (input.control && key === "j") {
    event.preventDefault();
    chromeView?.webContents.send("browser:open-module", "downloads");
  } else if (input.control && key === "f") {
    event.preventDefault();
    chromeView?.webContents.send("browser:open-find");
  } else if (input.control && key === "p") {
    event.preventDefault();
    tab.view.webContents.print({ printBackground: true });
  } else if (input.control && key === "tab") {
    event.preventDefault();
    activateRelativeTab(input.shift ? -1 : 1);
  } else if (input.control && /^[1-9]$/.test(key)) {
    event.preventDefault();
    const index = key === "9" ? tabs.length - 1 : Number(key) - 1;
    if (tabs[index]) activateTab(tabs[index].id);
  } else if (input.control && (key === "+" || key === "=")) {
    event.preventDefault();
    setActiveZoom(0.1);
  } else if (input.control && key === "-") {
    event.preventDefault();
    setActiveZoom(-0.1);
  } else if (input.control && key === "0") {
    event.preventDefault();
    setActiveZoom(0);
  } else if (input.alt && key === "arrowleft") {
    event.preventDefault();
    if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
  } else if (input.alt && key === "arrowright") {
    event.preventDefault();
    if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
  } else if (key === "f12") {
    event.preventDefault();
    tab.view.webContents.toggleDevTools();
  } else if (key === "f11") {
    event.preventDefault();
    mainWindow?.setFullScreen(!mainWindow.isFullScreen());
  }
}

function activateRelativeTab(offset) {
  if (tabs.length < 2) return;
  const index = tabs.findIndex(tab => tab.id === activeTabId);
  const nextIndex = (index + offset + tabs.length) % tabs.length;
  activateTab(tabs[nextIndex].id);
}

function setActiveZoom(delta) {
  const contents = getActiveTab()?.view.webContents;
  if (!contents) return 1;
  const next = Number(delta) === 0 ? 1 : Math.min(3, Math.max(0.5, contents.getZoomFactor() + Number(delta)));
  contents.setZoomFactor(next);
  sendState();
  return next;
}

function activateTab(id) {
  const tab = tabs.find(item => item.id === id);
  if (!tab || !mainWindow) return;

  const previous = getActiveTab();
  if (previous && previous !== tab) previous.hide();
  activeTabId = id;
  tab.show();
  mainWindow.setTitle(`${tab.title} - ${WINDOW_TITLE_SUFFIX}`);
  layoutViews();
  tab.view.webContents.focus();
  scheduleSessionSave();
  sendState();
  emitExtensionEvent("tabs.activated", { tabId: tab.id, windowId: EXT_WINDOW_ID });
}

function closeTab(id) {
  const index = tabs.findIndex(item => item.id === id);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  if (!tab.url.startsWith("liquid://home/") && !tab.incognito) {
    browserData.recentlyClosed.unshift({
      url: sanitizeTarget(tab.url),
      title: cleanTitle(tab.title) || "已关闭标签页",
      closedAt: Date.now()
    });
    browserData.recentlyClosed = browserData.recentlyClosed.slice(0, 20);
  }
  emitExtensionEvent("tabs.removed", { tabId: tab.id, windowId: EXT_WINDOW_ID });
  if (mainWindow) tab.destroy();

  if (!tabs.length) {
    activeTabId = null;
    createTab(HOME_URL, true);
    return;
  }
  if (id === activeTabId) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = null;
    activateTab(next.id);
  } else {
    scheduleSessionSave();
    sendState();
  }
}

function reopenLastClosedTab() {
  const entry = browserData.recentlyClosed.shift();
  if (!entry) return false;
  createTab(entry.url, true);
  scheduleBrowserDataSave();
  return true;
}

function reorderTabs(sourceId, targetIndex) {
  const from = tabs.findIndex(tab => tab.id === Number(sourceId));
  if (from < 0) return false;
  let to = Math.min(Math.max(0, Number(targetIndex)), tabs.length);
  const [moved] = tabs.splice(from, 1);
  if (to > from) to -= 1;
  const pinnedCount = tabs.filter(tab => tab.pinned).length;
  to = moved.pinned ? Math.min(to, pinnedCount) : Math.max(to, pinnedCount);
  to = Math.min(Math.max(0, to), tabs.length);
  tabs.splice(to, 0, moved);
  scheduleSessionSave();
  sendState();
  return true;
}

function pinTab(id, pinned) {
  const tab = tabs.find(item => item.id === Number(id));
  if (!tab) return false;
  tab.pinned = Boolean(pinned);
  const from = tabs.indexOf(tab);
  tabs.splice(from, 1);
  const pinnedCount = tabs.filter(item => item.pinned).length;
  tabs.splice(pinnedCount, 0, tab);
  if (tab.id === activeTabId) layoutViews();
  scheduleSessionSave();
  sendState();
  return true;
}

function duplicateTab(id) {
  const source = tabs.find(item => item.id === Number(id));
  if (!source) return null;
  return createTab(sanitizeTarget(source.url), true, { incognito: source.incognito, pinned: source.pinned });
}

function closeOtherTabs(id) {
  const keep = tabs.find(item => item.id === Number(id));
  if (!keep) return;
  for (const tab of [...tabs]) {
    if (tab.id !== keep.id) closeTab(tab.id);
  }
  if (keep.id !== activeTabId) activateTab(keep.id);
}

function closeRightTabs(id) {
  const index = tabs.findIndex(item => item.id === Number(id));
  if (index < 0) return;
  const keptId = tabs[index].id;
  for (const tab of [...tabs.slice(index + 1)]) closeTab(tab.id);
  if (!tabs.some(item => item.id === activeTabId)) activateTab(keptId);
}

function showTabContextMenu(tab) {
  const index = tabs.indexOf(tab);
  Menu.buildFromTemplate([
    { label: "新建标签页", click: () => createTab(HOME_URL, true) },
    { label: "新建隐私标签页", click: () => createTab(HOME_URL, true, { incognito: true }) },
    { type: "separator" },
    { label: "重新加载", click: () => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload(); } },
    { label: "复制标签页", click: () => duplicateTab(tab.id) },
    { type: "separator" },
    { label: tab.pinned ? "取消固定标签页" : "固定标签页", click: () => pinTab(tab.id, !tab.pinned) },
    { label: "关闭其他标签页", enabled: tabs.length > 1, click: () => closeOtherTabs(tab.id) },
    { label: "关闭右侧标签页", enabled: index < tabs.length - 1, click: () => closeRightTabs(tab.id) },
    { type: "separator" },
    { label: "关闭标签页", click: () => closeTab(tab.id) }
  ]).popup({ window: mainWindow });
}

function getActiveTab() {
  return tabs.find(item => item.id === activeTabId) || null;
}

// ---- 扩展 API 兼容层：chrome.tabs / chrome.windows 数据与事件 ----

const EXT_WINDOW_ID = 1;

function extensionWebContents() {
  return webContents.getAllWebContents().filter(wc => {
    try { return !wc.isDestroyed() && wc.getURL().startsWith("chrome-extension://"); } catch {
      return false;
    }
  });
}

function emitExtensionEvent(channel, payload) {
  for (const wc of extensionWebContents()) {
    try {
      if (!wc.isDestroyed()) wc.send("ext:api-event", channel, payload);
    } catch {
    }
  }
}

function isExtensionSender(event) {
  try { return event.sender.getURL().startsWith("chrome-extension://"); } catch {
    return false;
  }
}

function tabApiSnapshot(tab) {
  if (!tab) return null;
  const contents = tab.view.webContents;
  const destroyed = !contents || contents.isDestroyed();
  return {
    id: tab.id,
    index: tabs.indexOf(tab),
    windowId: EXT_WINDOW_ID,
    active: tab.id === activeTabId,
    highlighted: tab.id === activeTabId,
    selected: tab.id === activeTabId,
    pinned: tab.pinned,
    incognito: tab.incognito,
    discarded: false,
    autoDiscardable: true,
    url: tab.url,
    title: tab.title,
    status: tab.isLoading ? "loading" : (tab.isError ? "unloaded" : "complete"),
    audible: false,
    favIconUrl: undefined,
    lastAccessed: undefined
  };
}

function windowApiSnapshot(populate) {
  const [width, height] = mainWindow ? mainWindow.getContentSize() : [1440, 920];
  const state = mainWindow ? (mainWindow.isFullScreen() ? "fullscreen" : mainWindow.isMaximized() ? "maximized" : "normal") : "normal";
  const win = {
    id: EXT_WINDOW_ID,
    focused: true,
    top: 0,
    left: 0,
    width,
    height,
    type: "normal",
    state,
    alwaysOnTop: false,
    incognito: false,
    tabs: populate ? tabs.map(tabApiSnapshot) : undefined
  };
  return win;
}

function findTabById(id) {
  return tabs.find(item => item.id === Number(id)) || null;
}

function emitTabCreated(tab) {
  emitExtensionEvent("tabs.created", { tab: tabApiSnapshot(tab) });
}

function emitTabUpdated(tab, changeInfo, tabOverride) {
  if (!tab) return;
  emitExtensionEvent("tabs.updated", {
    tabId: tab.id,
    changeInfo: changeInfo || {},
    tab: tabOverride || tabApiSnapshot(tab)
  });
}

function matchesUrlPattern(url, pattern) {
  const value = String(url || "");
  const pat = String(pattern || "");
  if (pat === "<all_urls>") return true;
  const re = new RegExp("^" + pat.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(value);
}

function matchesTabQuery(tab, query) {
  if (!query || typeof query !== "object") return true;
  if (typeof query.active === "boolean" && tab.id === activeTabId !== query.active) return false;
  if (typeof query.pinned === "boolean" && tab.pinned !== query.pinned) return false;
  if (typeof query.incognito === "boolean" && tab.incognito !== query.incognito) return false;
  if (query.windowId !== undefined && Number(query.windowId) !== EXT_WINDOW_ID) return false;
  if (query.currentWindow || query.lastFocusedWindow || query.focused) return false;
  if (query.url !== undefined) {
    const patterns = Array.isArray(query.url) ? query.url : [query.url];
    if (!patterns.some(pattern => matchesUrlPattern(tab.url, pattern))) return false;
  }
  if (query.title !== undefined) {
    const patterns = Array.isArray(query.title) ? query.title : [query.title];
    if (!patterns.some(pattern => matchesUrlPattern(tab.title, pattern))) return false;
  }
  if (typeof query.status === "string" && query.status !== tabApiSnapshot(tab).status) return false;
  return true;
}

function flattenBookmarks(items, out = []) {
  for (const item of items || []) {
    if (item?.type === "folder") {
      out.push(item);
      flattenBookmarks(item.children, out);
    } else if (item?.url) {
      out.push(item);
    }
  }
  return out;
}

function findBookmarkByUrl(items, url) {
  for (const item of items || []) {
    if (item?.type === "folder") {
      const hit = findBookmarkByUrl(item.children, url);
      if (hit) return hit;
    } else if (item?.url === url) {
      return item;
    }
  }
  return null;
}

function findBookmarkById(items, id) {
  for (const item of items || []) {
    if (item?.id === id) return item;
    if (item?.type === "folder") {
      const hit = findBookmarkById(item.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

function removeBookmarkById(items, id) {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.id === id) {
      items.splice(index, 1);
      return true;
    }
    if (item?.type === "folder" && removeBookmarkById(item.children || [], id)) return true;
  }
  return false;
}

function addBookmarkFolder(title) {
  const folder = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "folder",
    title: cleanTitle(title).slice(0, 60) || "新建文件夹",
    children: [],
    createdAt: Date.now()
  };
  browserData.bookmarks.unshift(folder);
  scheduleBrowserDataSave();
  sendState();
  return folder;
}

function updateBookmark(id, fields) {
  const bookmark = findBookmarkById(browserData.bookmarks, String(id));
  if (!bookmark) return false;
  if (typeof fields?.title === "string") bookmark.title = cleanTitle(fields.title).slice(0, 80) || bookmark.title;
  if (typeof fields?.url === "string" && bookmark.type !== "folder") {
    bookmark.url = isAllowedNavigation(fields.url) ? fields.url : bookmark.url;
  }
  scheduleBrowserDataSave();
  sendState();
  return true;
}

function decodeBookmarkEntities(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseBookmarksHtml(html) {
  const root = { type: "folder", title: "root", children: [] };
  const stack = [root];
  const tagPattern = /<DT><H3[^>]*>([\s\S]*?)<\/H3>|<DT><A\s[^>]*?HREF="([^"]*)"[^>]*>([\s\S]*?)<\/A>|<\/DL>/gi;
  let match;
  while ((match = tagPattern.exec(String(html || "")))) {
    if (match[1] !== undefined) {
      const folder = { type: "folder", title: decodeBookmarkEntities(match[1]) || "导入文件夹", children: [] };
      stack[stack.length - 1].children.push(folder);
      stack.push(folder);
    } else if (match[2] !== undefined) {
      stack[stack.length - 1].children.push({ type: "url", url: match[2], title: decodeBookmarkEntities(match[3]) });
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  return root.children;
}

async function importBookmarksFromHtml() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入书签",
    filters: [{ name: "HTML 书签文件", extensions: ["html", "htm"] }],
    properties: ["openFile"]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true, count: 0 };
  try {
    const parsed = parseBookmarksHtml(fs.readFileSync(result.filePaths[0], "utf8"));
    let count = 0;
    const merge = items => {
      for (const item of items || []) {
        if (item.type === "folder") {
          merge(item.children);
        } else if (item.url && isAllowedNavigation(item.url) && !findBookmarkByUrl(browserData.bookmarks, item.url)) {
          browserData.bookmarks.unshift({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: "url",
            url: item.url,
            title: cleanTitle(item.title) || item.url,
            createdAt: Date.now()
          });
          count += 1;
        }
      }
    };
    merge(parsed);
    browserData.bookmarks = browserData.bookmarks.slice(0, 400);
    scheduleBrowserDataSave();
    sendState();
    return { ok: true, count };
  } catch (error) {
    return { ok: false, error: error.message, count: 0 };
  }
}

async function exportBookmarksToHtml() {
  const escapeHtml = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const renderItems = items => (items || []).map(item => item.type === "folder"
    ? `    <DT><H3>${escapeHtml(item.title || "文件夹")}</H3>\n    <DL><p>\n${renderItems(item.children)}    </DL><p>\n`
    : `    <DT><A HREF="${escapeHtml(item.url)}">${escapeHtml(item.title || item.url)}</A>\n`).join("");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出书签",
    defaultPath: path.join(app.getPath("documents"), "drip-bookmarks.html"),
    filters: [{ name: "HTML 书签文件", extensions: ["html"] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    const content = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${renderItems(browserData.bookmarks)}</DL><p>\n`;
    fs.writeFileSync(result.filePath, content, "utf8");
    shell.showItemInFolder(result.filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function toggleActiveBookmark() {
  const tab = getActiveTab();
  if (!tab || !isWebUrl(tab.url)) return false;
  const existing = findBookmarkByUrl(browserData.bookmarks, tab.url);
  if (existing) {
    removeBookmarkById(browserData.bookmarks, existing.id);
  } else {
    browserData.bookmarks.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "url",
      url: tab.url,
      title: cleanTitle(tab.title) || new URL(tab.url).hostname,
      createdAt: Date.now()
    });
    if (flattenBookmarks(browserData.bookmarks).length > 200) {
      browserData.bookmarks.pop();
    }
  }
  scheduleBrowserDataSave();
  sendState();
  return !existing;
}

async function openAppearanceSettings() {
  const tab = getActiveTab();
  if (!tab) return;
  if (!tab.url.startsWith("liquid://home/")) {
    await tab.view.webContents.loadURL(HOME_URL);
  }
  await tab.view.webContents.executeJavaScript("openPanel()");
}

function cleanTitle(title) {
  return String(title || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 160);
}

function isAllowedNavigation(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "liquid:" || url.protocol === "about:";
  } catch {
    return false;
  }
}

function sanitizeTarget(value) {
  if (value === HOME_URL) return value;
  const normalized = normalizeAddress(value);
  return isAllowedNavigation(normalized) ? normalized : HOME_URL;
}

function normalizeAddress(value) {
  const input = String(value || "").trim();
  if (!input) return HOME_URL;
  try {
    const parsed = new URL(input);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "liquid:") {
      return parsed.href;
    }
  } catch {
  }

  if (!/\s/.test(input) && (input.includes(".") || /^localhost(?::\d+)?(?:\/|$)/i.test(input))) {
    try {
      return new URL(`https://${input}`).href;
    } catch {
    }
  }
  return searchUrlFor(input);
}

function searchUrlFor(query) {
  const engine = SEARCH_ENGINES[browserData.settings.searchEngine] || SEARCH_ENGINES.google;
  return engine.url(String(query || "").slice(0, 300));
}

function buildAddressSuggestions(query) {
  const input = String(query || "").trim();
  if (!input) return [];
  const lower = input.toLowerCase();
  const seen = new Set();
  const suggestions = [];
  const push = suggestion => {
    if (!suggestion?.url || seen.has(suggestion.url) || suggestions.length >= 8) return;
    seen.add(suggestion.url);
    suggestions.push(suggestion);
  };
  for (const bookmark of flattenBookmarks(browserData.bookmarks)) {
    if ((bookmark.title || "").toLowerCase().includes(lower) || (bookmark.url || "").toLowerCase().includes(lower)) {
      push({ kind: "bookmark", title: bookmark.title || bookmark.url, url: bookmark.url });
    }
  }
  for (const entry of browserData.history.slice(0, 300)) {
    if ((entry.title || "").toLowerCase().includes(lower) || (entry.url || "").toLowerCase().includes(lower)) {
      push({ kind: "history", title: entry.title || entry.url, url: entry.url });
    }
  }
  const looksLikeUrl = !/\s/.test(input)
    && (input.includes(".") || /^localhost(?::\d+)?(?:\/|$)/i.test(input));
  if (looksLikeUrl) {
    try {
      push({ kind: "url", title: input, url: new URL(`https://${input}`).href });
    } catch {
    }
  }
  const engine = SEARCH_ENGINES[browserData.settings.searchEngine] || SEARCH_ENGINES.google;
  push({ kind: "search", title: input, url: searchUrlFor(input), engine: engine.label });
  return suggestions;
}

function navigateActive(value) {
  const tab = getActiveTab();
  if (!tab) return;
  const target = normalizeAddress(value);
  if (target.startsWith("http") && connection.state !== "connected") {
    sendState();
  }
  tab.view.webContents.loadURL(target);
}

function reloadActiveTab() {
  const tab = getActiveTab();
  if (!tab) return;
  if (tab.isLoading) tab.view.webContents.stop();
  else if (tab.isError) tab.view.webContents.loadURL(sanitizeTarget(tab.url));
  else tab.view.webContents.reload();
}

function displayUrl(url) {
  if (url === HOME_URL || url.startsWith("liquid://home/")) return "";
  return url;
}

function activeSiteSnapshot() {
  const tab = getActiveTab();
  const origin = originFrom(tab?.url);
  if (!origin) {
    return {
      origin: "liquid://home",
      hostname: "Drip 主页",
      secure: true,
      local: true,
      permissions: {}
    };
  }
  const parsed = new URL(origin);
  return {
    origin,
    hostname: parsed.hostname,
    secure: parsed.protocol === "https:",
    local: false,
    permissions: { ...(browserData.permissions[origin] || {}) }
  };
}

function stateSnapshot() {
  return {
    app: {
      version: app.getVersion(),
      chromium: process.versions.chrome
    },
    activeTabId,
    connection,
    browserRoute: browserRouteSnapshot(),
    appearance: appearanceSettings,
    window: {
      isMaximized: Boolean(mainWindow?.isMaximized())
    },
    modules: {
      profile: { ...browserData.profile },
      account: accountService?.snapshot() || {
        status: "signed-out",
        busy: false,
        user: null,
        error: null
      },
      updates: updateManager?.snapshot() || {
        status: "idle",
        currentVersion: app.getVersion(),
        latestVersion: null,
        detailsUrl: process.env.DRIP_UPDATE_URL || "https://example.invalid/releases",
        progress: 0,
        error: null
      },
      bookmarks: browserData.bookmarks.slice(0, 200),
      history: browserData.history.slice(0, 120).map(({ text, ...entry }) => entry),
      downloads: browserData.downloads.slice(0, 120),
      extensions: browserData.extensions.slice(0, 50),
      recentlyClosed: browserData.recentlyClosed.slice(0, 20),
      passwords: browserData.passwords.slice(0, 200),
      settings: { ...browserData.settings },
      site: activeSiteSnapshot()
    },
    tabs: tabs.map(tab => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      displayUrl: displayUrl(tab.url),
      isLoading: tab.isLoading,
      pinned: tab.pinned,
      incognito: tab.incognito,
      canGoBack: !tab.view.webContents.isDestroyed() && tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: !tab.view.webContents.isDestroyed() && tab.view.webContents.navigationHistory.canGoForward(),
      isBookmarked: Boolean(findBookmarkByUrl(browserData.bookmarks, tab.url)),
      zoomFactor: tab.view.webContents.getZoomFactor()
    }))
  };
}

function sendState() {
  if (chromeView && !chromeView.webContents.isDestroyed()) {
    chromeView.webContents.send("browser:state", stateSnapshot());
  }
  if (proxyView && !proxyView.webContents.isDestroyed()) {
    proxyView.webContents.send("proxy:status-changed", managedProxyStatus());
  }
}

function installIpcHandlers() {
  const validate = event => {
    if (!chromeView || event.sender.id !== chromeView.webContents.id) {
      throw new Error("Invalid IPC sender");
    }
  };
  const validateTab = event => {
    if (!tabs.some(tab => tab.view.webContents.id === event.sender.id)) {
      throw new Error("Invalid IPC sender");
    }
  };
  // 允许 chrome 视图，或任何内部 liquid:// 页面（主页/设置页等受信内容）发起调用，
  // 外部网站（http/https）即便在标签页也无法访问桥接，这里做双重防御。
  const validateClient = event => {
    if (chromeView && event.sender.id === chromeView.webContents.id) return;
    if (!tabs.some(tab => tab.view.webContents.id === event.sender.id)) {
      throw new Error("Invalid IPC sender");
    }
    const frameUrl = event.senderFrame?.url || event.sender.getURL() || "";
    if (!frameUrl.startsWith("liquid://")) throw new Error("Invalid IPC sender");
  };
  const validateProxy = event => {
    if (!proxyView || event.sender.id !== proxyView.webContents.id || event.senderFrame?.url !== PROXY_CENTER_URL) {
      throw new Error("Invalid IPC sender");
    }
  };
  ipcMain.handle("home:set-appearance", (event, settings) => {
    validateTab(event);
    appearanceSettings = sanitizeAppearance(settings);
    sendState();
    return { ok: true };
  });
  ipcMain.handle("browser:get-state", event => {
    validate(event);
    return stateSnapshot();
  });
  ipcMain.handle("browser:set-route", (event, value) => {
    validate(event);
    const change = browserRouteChange.then(() => selectBrowserRoute(value));
    browserRouteChange = change.catch(() => {});
    return change;
  });
  ipcMain.handle("settings:get", event => {
    validateTab(event);
    return { ...browserData.settings };
  });
  ipcMain.handle("browser:open-proxy-center", async event => {
    validateClient(event);
    const sourceUrl = event.senderFrame?.url || event.sender.getURL();
    if (!sourceUrl.startsWith("liquid://home/")) throw new Error("Invalid proxy center opener");
    await openProxyCenter();
    return { ok: true };
  });
  ipcMain.handle("proxy:close-center", async event => {
    validateProxy(event);
    if (managedProxyState.starting || managedProxyState.restarting) {
      throw new Error("代理正在启动，请稍后再关闭并返回");
    }
    if (managedProxyState.active || managedProxySystemProxy || managedProxyChild) await stopManagedProxy();
    setImmediate(closeProxyCenter);
    return { ok: true };
  });
  ipcMain.handle("proxy:window-action", (event, action) => {
    validateProxy(event);
    if (action === "minimize") mainWindow?.minimize();
    else if (action === "maximize" && mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === "close") mainWindow?.close();
    else throw new Error("Invalid window action");
    return { ok: true };
  });
  ipcMain.handle("proxy:nodes", event => {
    validateProxy(event);
    return proxyNodeList();
  });
  ipcMain.handle("proxy:groups", event => {
    validateProxy(event);
    return availableProxyGroups();
  });
  ipcMain.handle("proxy:status", event => {
    validateProxy(event);
    return managedProxyStatus();
  });
  ipcMain.handle("proxy:stats", async event => {
    validateProxy(event);
    const tracker = trafficTracker();
    if (managedProxyState.active && !tracker.history.length) {
      try { await managedProxyStats(); } catch (error) { managedProxyStatsError = error.message; }
    }
    return { ...tracker.current(managedProxyState.active), error: managedProxyStatsError };
  });
  ipcMain.handle("proxy:rules", event => {
    validateProxy(event);
    return managedProxyRules;
  });
  ipcMain.handle("proxy:logs", event => {
    validateProxy(event);
    return readManagedProxyLogs();
  });
  ipcMain.handle("proxy:delay", async (event, nodeId) => {
    validateProxy(event);
    if (typeof nodeId !== "string" || nodeId.length > 120) throw new Error("节点标识无效");
    return testProxyNode(nodeId);
  });
  ipcMain.handle("proxy:start", async (event, options) => {
    validateProxy(event);
    const input = options && typeof options === "object" ? options : {};
    return startManagedProxy({
      nodeId: typeof input.nodeId === "string" ? input.nodeId.slice(0, 120) : undefined,
      groupName: typeof input.groupName === "string" ? input.groupName.slice(0, 120) : undefined,
      mode: typeof input.mode === "string" ? input.mode : undefined,
      systemProxy: input.systemProxy !== false,
      tun: input.tun === true
    });
  });
  ipcMain.handle("proxy:stop", async event => {
    validateProxy(event);
    await stopManagedProxy();
    return managedProxyStatus();
  });
  ipcMain.handle("proxy:subscriptions", event => {
    validateProxy(event);
    return proxySubscriptionStore.status();
  });
  ipcMain.handle("proxy:add-subscription", (event, url, name) => {
    validateProxy(event);
    return proxySubscriptionStore.add(url, name);
  });
  ipcMain.handle("proxy:refresh-subscription", (event, id) => {
    validateProxy(event);
    return proxySubscriptionStore.refresh(id);
  });
  ipcMain.handle("proxy:remove-subscription", (event, id) => {
    validateProxy(event);
    return proxySubscriptionStore.remove(id);
  });
  ipcMain.handle("browser:open-settings", event => {
    validate(event);
    createTab(SETTINGS_URL, true);
  });
  ipcMain.handle("browser:navigate", (event, value) => {
    validate(event);
    navigateActive(value);
  });
  ipcMain.handle("browser:suggest-address", (event, query) => {
    validate(event);
    return buildAddressSuggestions(query);
  });
  ipcMain.handle("browser:back", event => {
    validate(event);
    const tab = getActiveTab();
    if (tab?.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
  });
  ipcMain.handle("browser:forward", event => {
    validate(event);
    const tab = getActiveTab();
    if (tab?.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
  });
  ipcMain.handle("browser:reload", event => {
    validate(event);
    reloadActiveTab();
  });
  ipcMain.handle("browser:home", event => {
    validateClient(event);
    getActiveTab()?.view.webContents.loadURL(HOME_URL);
  });
  ipcMain.handle("browser:new-tab", (event, value) => {
    validate(event);
    return createTab(value ? normalizeAddress(value) : HOME_URL, true).id;
  });
  ipcMain.handle("browser:reopen-closed", event => {
    validate(event);
    return reopenLastClosedTab();
  });
  ipcMain.handle("browser:close-tab", (event, id) => {
    validate(event);
    closeTab(Number(id));
  });
  ipcMain.handle("browser:activate-tab", (event, id) => {
    validate(event);
    activateTab(Number(id));
  });
  ipcMain.handle("browser:move-tab", (event, sourceId, targetIndex) => {
    validate(event);
    return reorderTabs(sourceId, targetIndex);
  });
  ipcMain.handle("browser:pin-tab", (event, id, pinned) => {
    validate(event);
    return pinTab(Number(id), Boolean(pinned));
  });
  ipcMain.handle("browser:duplicate-tab", (event, id) => {
    validate(event);
    return duplicateTab(Number(id))?.id ?? null;
  });
  ipcMain.handle("browser:close-other-tabs", (event, id) => {
    validate(event);
    closeOtherTabs(Number(id));
  });
  ipcMain.handle("browser:close-right-tabs", (event, id) => {
    validate(event);
    closeRightTabs(Number(id));
  });
  ipcMain.handle("browser:show-tab-menu", (event, id) => {
    validate(event);
    const tab = tabs.find(item => item.id === Number(id));
    if (tab) showTabContextMenu(tab);
  });
  ipcMain.handle("browser:new-incognito-tab", (event, value) => {
    validate(event);
    return createTab(value ? normalizeAddress(value) : HOME_URL, true, { incognito: true }).id;
  });
  ipcMain.handle("browser:retry-tunnel", async event => {
    validate(event);
    await accountService?.refreshManagedAccess();
    await reconcileBrowserRoute();
  });
  ipcMain.handle("browser:set-overlay-open", (event, open) => {
    validate(event);
    chromeOverlayOpen = Boolean(open);
    layoutViews();
  });
  ipcMain.handle("browser:toggle-bookmark", event => {
    validate(event);
    return toggleActiveBookmark();
  });
  ipcMain.handle("browser:delete-bookmark", (event, id) => {
    validate(event);
    removeBookmarkById(browserData.bookmarks, String(id));
    scheduleBrowserDataSave();
    sendState();
  });
  ipcMain.handle("browser:add-bookmark-folder", (event, title) => {
    validate(event);
    return addBookmarkFolder(title);
  });
  ipcMain.handle("browser:update-bookmark", (event, id, fields) => {
    validate(event);
    return updateBookmark(id, fields);
  });
  ipcMain.handle("browser:import-bookmarks", async event => {
    validate(event);
    return importBookmarksFromHtml();
  });
  ipcMain.handle("browser:export-bookmarks", async event => {
    validate(event);
    return exportBookmarksToHtml();
  });
  ipcMain.handle("browser:show-bookmark-folder", (event, id) => {
    validate(event);
    const folder = findBookmarkById(browserData.bookmarks, String(id));
    if (!folder || folder.type !== "folder") return;
    const children = (folder.children || []).slice(0, 30);
    if (!children.length) return;
    Menu.buildFromTemplate(children.map(item => item.type === "folder"
      ? { label: item.title || "文件夹", enabled: false }
      : { label: item.title || item.url, click: () => createTab(sanitizeTarget(item.url), true) })).popup({ window: mainWindow });
  });
  ipcMain.handle("browser:delete-history-item", (event, id) => {
    validate(event);
    browserData.history = browserData.history.filter(item => item.id !== String(id));
    scheduleBrowserDataSave();
    sendState();
  });
  ipcMain.handle("browser:search-history", (event, query) => {
    validate(event);
    const input = String(query || "").trim().toLowerCase();
    const source = browserData.history;
    const matched = input
      ? source.filter(item =>
          (item.title || "").toLowerCase().includes(input)
          || (item.url || "").toLowerCase().includes(input)
          || (item.snippet || item.text || "").toLowerCase().includes(input))
      : source;
    return matched.slice(0, 200).map(item => {
      const { text, ...copy } = item;
      copy.snippet = copy.snippet || (text || "").slice(0, 200);
      return copy;
    });
  });
  ipcMain.handle("browser:open-url", (event, url) => {
    validate(event);
    navigateActive(url);
  });
  ipcMain.handle("browser:find", (event, query, options = {}) => {
    validate(event);
    const contents = getActiveTab()?.view.webContents;
    const text = String(query || "").slice(0, 500);
    if (!contents || !text) {
      contents?.stopFindInPage("clearSelection");
      return null;
    }
    return contents.findInPage(text, {
      forward: options.forward !== false,
      findNext: Boolean(options.findNext)
    });
  });
  ipcMain.handle("browser:stop-find", (event, action = "keepSelection") => {
    validate(event);
    getActiveTab()?.view.webContents.stopFindInPage(action === "clearSelection" ? "clearSelection" : "keepSelection");
  });
  ipcMain.handle("browser:clear-history", (event, range) => {
    validate(event);
    clearHistoryForRange(range);
    scheduleBrowserDataSave();
    sendState();
  });
  ipcMain.handle("browser:clear-download-records", event => {
    validate(event);
    browserData.downloads = browserData.downloads.filter(item => item.state === "progressing");
    scheduleBrowserDataSave();
    sendState();
  });
  ipcMain.handle("browser:show-download", (event, id) => {
    validate(event);
    const entry = browserData.downloads.find(item => item.id === String(id));
    if (entry?.savePath && fs.existsSync(entry.savePath)) shell.showItemInFolder(entry.savePath);
  });
  ipcMain.handle("browser:cancel-download", (event, id) => {
    validate(event);
    activeDownloads.get(String(id))?.cancel();
  });
  ipcMain.handle("browser:pause-download", (event, id) => {
    validate(event);
    const item = activeDownloads.get(String(id));
    if (item && !item.isPaused()) item.pause();
  });
  ipcMain.handle("browser:resume-download", (event, id) => {
    validate(event);
    const item = activeDownloads.get(String(id));
    if (item && item.isPaused()) item.resume();
  });
  ipcMain.handle("browser:retry-download", (event, id) => {
    validate(event);
    const entry = browserData.downloads.find(record => record.id === String(id));
    if (!entry?.url) return { ok: false };
    try { activeDownloads.get(String(id))?.cancel(); } catch {
    }
    browserSession.downloadURL(entry.url);
    return { ok: true };
  });
  ipcMain.handle("browser:open-downloads-folder", event => {
    validate(event);
    return shell.openPath(app.getPath("downloads"));
  });
  ipcMain.handle("browser:add-extension", async event => {
    validate(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择已解压的 Chrome 扩展目录",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const extensionPath = result.filePaths[0];
    try {
      const extension = await browserSession.extensions.loadExtension(extensionPath, { allowFileAccess: false });
      browserData.extensions = browserData.extensions.filter(item => item.id !== extension.id && item.path !== extensionPath);
      browserData.extensions.unshift({ id: extension.id, name: extension.name, version: extension.version, path: extensionPath });
      scheduleBrowserDataSave();
      sendState();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("browser:remove-extension", (event, id) => {
    validate(event);
    const extensionId = String(id);
    browserSession.extensions.removeExtension(extensionId);
    browserData.extensions = browserData.extensions.filter(item => item.id !== extensionId);
    scheduleBrowserDataSave();
    sendState();
  });
  ipcMain.handle("browser:toggle-extension", async (event, id, enabled) => {
    validate(event);
    const saved = browserData.extensions.find(item => item.id === String(id));
    if (!saved) return { ok: false, error: "扩展不存在" };
    const shouldEnable = Boolean(enabled);
    if (shouldEnable === Boolean(saved.enabled)) return { ok: true };
    if (!shouldEnable) {
      try { browserSession.extensions.removeExtension(saved.id); } catch {
      }
      saved.enabled = false;
    } else {
      if (!saved.path || !fs.existsSync(saved.path)) return { ok: false, error: "扩展目录不存在" };
      try {
        const extension = await browserSession.extensions.loadExtension(saved.path, { allowFileAccess: false });
        saved.id = extension.id;
        saved.enabled = true;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    scheduleBrowserDataSave();
    sendState();
    return { ok: true };
  });

  // ---- chrome.tabs / chrome.windows 兼容层 IPC ----
  const guardExtension = event => {
    if (!isExtensionSender(event)) throw new Error("仅允许扩展页面调用该 API");
  };

  ipcMain.handle("ext:tabs-query", (event, payload) => {
    guardExtension(event);
    const query = payload?.queryInfo || {};
    return tabs.filter(tab => matchesTabQuery(tab, query)).map(tabApiSnapshot);
  });
  ipcMain.handle("ext:tabs-get", (event, payload) => {
    guardExtension(event);
    const tab = findTabById(payload?.tabId);
    return tab ? tabApiSnapshot(tab) : null;
  });
  ipcMain.handle("ext:tabs-get-current", event => {
    guardExtension(event);
    return null;
  });
  ipcMain.handle("ext:tabs-create", (event, payload) => {
    guardExtension(event);
    const props = payload?.props || {};
    const url = typeof props.url === "string" && props.url ? sanitizeTarget(props.url) : HOME_URL;
    const incognito = Boolean(props.incognito);
    const active = props.active !== false;
    // 扩展创建标签时仅允许创建在当前窗口内。
    const tab = createTab(url, active, { incognito, pinned: Boolean(props.pinned) });
    return tabApiSnapshot(tab);
  });
  ipcMain.handle("ext:tabs-update", (event, payload) => {
    guardExtension(event);
    const tabId = Number(payload?.tabId);
    const props = payload?.props || {};
    const tab = findTabById(tabId);
    if (!tab) return null;
    if (typeof props.url === "string" && props.url) {
      const target = sanitizeTarget(props.url);
      if (tab.url !== target && !tab.view.webContents.isDestroyed()) tab.view.webContents.loadURL(target);
    }
    if (typeof props.active === "boolean") {
      if (props.active && tab.id !== activeTabId) activateTab(tab.id);
      else if (!props.active && tab.id === activeTabId) activateRelativeTab(1);
    }
    if (typeof props.pinned === "boolean" && props.pinned !== tab.pinned) pinTab(tabId, props.pinned);
    return tabApiSnapshot(tab);
  });
  ipcMain.handle("ext:tabs-remove", (event, payload) => {
    guardExtension(event);
    for (const id of Array.isArray(payload?.tabIds) ? payload.tabIds : []) closeTab(Number(id));
    return { ok: true };
  });
  ipcMain.handle("ext:tabs-reload", (event, payload) => {
    guardExtension(event);
    const tab = findTabById(payload?.tabId);
    if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    return { ok: true };
  });
  ipcMain.handle("ext:tabs-duplicate", (event, payload) => {
    guardExtension(event);
    const tab = duplicateTab(payload?.tabId);
    return tab ? tabApiSnapshot(tab) : null;
  });

  ipcMain.handle("ext:windows-get-all", (event, payload) => {
    guardExtension(event);
    const populate = Boolean(payload?.options?.populate);
    return [windowApiSnapshot(populate)];
  });
  ipcMain.handle("ext:windows-get-last-focused", event => {
    guardExtension(event);
    return windowApiSnapshot(true);
  });
  ipcMain.handle("ext:windows-get-current", event => {
    guardExtension(event);
    return windowApiSnapshot(Boolean(event && event.sender));
  });
  ipcMain.handle("ext:windows-get", (event, payload) => {
    guardExtension(event);
    if (Number(payload?.windowId) !== EXT_WINDOW_ID) return null;
    return windowApiSnapshot(Boolean(payload?.options?.populate));
  });
  ipcMain.handle("ext:windows-create", (event, payload) => {
    guardExtension(event);
    const props = payload?.props || {};
    const url = typeof props.url === "string" && props.url ? sanitizeTarget(props.url) : HOME_URL;
    const incognito = Boolean(props.incognito);
    const tab = createTab(url, true, { incognito });
    return windowApiSnapshot(true);
  });
  ipcMain.handle("ext:windows-update", (event, payload) => {
    guardExtension(event);
    if (Number(payload?.windowId) !== EXT_WINDOW_ID) return windowApiSnapshot(true);
    const props = payload?.props || {};
    if (props.state === "maximized") mainWindow?.maximize();
    else if (props.state === "minimized") mainWindow?.minimize();
    else if (props.state === "fullscreen") mainWindow?.setFullScreen(true);
    else if (props.state === "normal") {
      mainWindow?.unmaximize();
      mainWindow?.setFullScreen(false);
    }
    return windowApiSnapshot(true);
  });
  ipcMain.handle("ext:windows-remove", (event, payload) => {
    guardExtension(event);
    if (Number(payload?.windowId) === EXT_WINDOW_ID) {
      // 非工作区管理扩展通常不应关闭主窗口，这里仅做安全兜底关闭所有标签。
      for (const tab of [...tabs]) closeTab(tab.id);
    }
    return { ok: true };
  });

  ipcMain.handle("browser:update-profile", (event, name) => {
    validate(event);
    browserData.profile.name = cleanTitle(name).slice(0, 24) || "本地用户";
    scheduleBrowserDataSave();
    sendState();
  });
  ipcMain.handle("browser:account-login", async (event, credentials) => {
    validate(event);
    const login = accountService.login(
      String(credentials?.username || "").slice(0, 64),
      String(credentials?.password || "").slice(0, 160)
    );
    await revokeManagedRoutesImmediately();
    const result = await login;
    await reconcileBrowserRoute();
    await stopUnauthorizedManagedProxy();
    return result;
  });
  ipcMain.handle("browser:account-register", async (event, account) => {
    validate(event);
    const register = accountService.register(
      String(account?.username || "").slice(0, 64),
      String(account?.displayName || "").slice(0, 48),
      String(account?.password || "").slice(0, 160)
    );
    await revokeManagedRoutesImmediately();
    const result = await register;
    await reconcileBrowserRoute();
    await stopUnauthorizedManagedProxy();
    return result;
  });
  ipcMain.handle("browser:account-redeem", async (event, code) => {
    validate(event);
    const result = await accountService.redeem(String(code || "").slice(0, 100));
    await reconcileBrowserRoute();
    return result;
  });
  ipcMain.handle("browser:account-update-profile", async (event, displayName) => {
    validate(event);
    return accountService.updateProfile(String(displayName || "").slice(0, 48));
  });
  ipcMain.handle("browser:account-update-avatar", async (event, avatarData) => {
    validate(event);
    if (typeof avatarData !== "string" || avatarData.length > 90000) throw new Error("头像文件过大");
    return accountService.updateAvatar(avatarData);
  });
  ipcMain.handle("browser:account-change-password", async (event, passwords) => {
    validate(event);
    return accountService.changePassword(
      String(passwords?.currentPassword || "").slice(0, 160),
      String(passwords?.newPassword || "").slice(0, 160)
    );
  });
  ipcMain.handle("browser:account-logout", async event => {
    validate(event);
    const logout = accountService.logout();
    await revokeManagedRoutesImmediately();
    await browserRouteChange;
    await reconcileBrowserRoute();
    await stopUnauthorizedManagedProxy();
    return logout;
  });
  ipcMain.handle("browser:account-devices", async event => {
    validate(event);
    return accountService.listDevices();
  });
  ipcMain.handle("browser:account-revoke-device", async (event, deviceId, all) => {
    validate(event);
    return accountService.revokeDevice(String(deviceId || ""), Boolean(all));
  });
  ipcMain.handle("browser:account-sync-set", async (event, key, value) => {
    validate(event);
    return accountService.syncSet(String(key || "").slice(0, 64), value);
  });
  ipcMain.handle("browser:account-sync-get", async (event, key) => {
    validate(event);
    return accountService.syncGet(String(key || ""));
  });
  ipcMain.handle("browser:account-sync-settings-up", async event => {
    validate(event);
    await accountService.syncSet("browserSettings", browserData.settings);
    return { ok: true, syncedAt: Date.now() };
  });
  ipcMain.handle("browser:account-sync-settings-down", async event => {
    validate(event);
    const payload = await accountService.syncGet("browserSettings");
    if (payload?.value && typeof payload.value === "object") {
      browserData.settings = { ...browserData.settings, ...payload.value };
      scheduleBrowserDataSave();
      sendState();
    }
    return { ok: true, settings: browserData.settings };
  });
  ipcMain.handle("browser:check-for-updates", async event => {
    validate(event);
    return updateManager.check(true);
  });
  ipcMain.handle("browser:download-update", async event => {
    validate(event);
    return updateManager.download();
  });
  ipcMain.handle("browser:install-update", event => {
    validate(event);
    return updateManager.install();
  });
  ipcMain.handle("browser:toggle-theme", async event => {
    validate(event);
    let homeTab = tabs.find(tab => tab.url.startsWith("liquid://home/"));
    if (!homeTab) {
      homeTab = createTab(HOME_URL, false);
      if (homeTab.view.webContents.isLoading()) {
        await new Promise(resolve => homeTab.view.webContents.once("did-finish-load", resolve));
      }
    }
    await homeTab.view.webContents.executeJavaScript("toggleTheme()");
  });
  ipcMain.handle("browser:open-appearance", async event => {
    validateClient(event);
    await openAppearanceSettings();
  });
  ipcMain.handle("browser:clear-cache", async event => {
    validateClient(event);
    await browserSession.clearCache();
    return { ok: true };
  });
  ipcMain.handle("browser:clear-site-data", async event => {
    validate(event);
    const site = activeSiteSnapshot();
    if (site.local || !site.origin) return { ok: false };
    await browserSession.clearStorageData({ origin: site.origin });
    getActiveTab()?.view.webContents.reload();
    return { ok: true };
  });
  ipcMain.handle("browser:reset-site-permissions", event => {
    validate(event);
    const site = activeSiteSnapshot();
    if (!site.local && site.origin) delete browserData.permissions[site.origin];
    scheduleBrowserDataSave();
    sendState();
    return { ok: true };
  });
  ipcMain.handle("browser:update-setting", (event, key, value) => {
    validateClient(event);
    if (key === "restoreSession") browserData.settings.restoreSession = Boolean(value);
    else if (key === "askDownloadLocation") browserData.settings.askDownloadLocation = Boolean(value);
    else if (key === "doNotTrack") browserData.settings.doNotTrack = Boolean(value);
    else if (key === "contentBlocking") browserData.settings.contentBlocking = Boolean(value);
    else if (key === "showBookmarksBar") browserData.settings.showBookmarksBar = Boolean(value);
    else if (key === "sidebar") browserData.settings.sidebar = Boolean(value);
    else if (key === "verticalTabs") browserData.settings.verticalTabs = Boolean(value);
    else if (key === "passwordAutoFill") browserData.settings.passwordAutoFill = Boolean(value);
    else if (key === "extensionDevMode") browserData.settings.extensionDevMode = Boolean(value);
    else if (key === "homepage") browserData.settings.homepage = typeof value === "string" ? value.slice(0, 2048) : "";
    else if (key === "searchEngine") {
      if (!SEARCH_ENGINES[value]) return { ok: false, error: "未知搜索引擎" };
      browserData.settings.searchEngine = value;
    } else return { ok: false };
    scheduleBrowserDataSave();
    sendState();
    return { ok: true };
  });
  ipcMain.handle("browser:set-download-path", async event => {
    validateClient(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择下载保存位置",
      defaultPath: browserData.settings.downloadPath || app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    browserData.settings.downloadPath = result.filePaths[0];
    for (const target of allBrowserSessions()) target.setDownloadPath(browserData.settings.downloadPath);
    scheduleBrowserDataSave();
    sendState();
    return { ok: true, path: browserData.settings.downloadPath };
  });
  ipcMain.handle("browser:clear-browsing-data", async (event, options = {}) => {
    validate(event);
    const range = ["all", "hour", "day", "week", "month"].includes(options.range) ? options.range : "all";
    const dataTypes = options.dataTypes && typeof options.dataTypes === "object" ? options.dataTypes : {};
    const hasDataTypes = Boolean(options.dataTypes && typeof options.dataTypes === "object");
    const want = key => hasDataTypes ? dataTypes[key] === true : true;

    const tasks = [];
    if (want("cache")) tasks.push(browserSession.clearCache());
    if (want("cookies") || want("siteData")) {
      tasks.push(browserSession.clearStorageData());
      if (want("cookies")) tasks.push(browserSession.clearAuthCache());
    }
    await Promise.all(tasks);

    if (want("history")) {
      clearHistoryForRange(range);
      browserData.recentlyClosed = [];
    }
    if (want("permissions")) browserData.permissions = {};
    if (want("downloads")) browserData.downloads = browserData.downloads.filter(item => item.state === "progressing");
    if (want("passwords")) browserData.passwords = [];

    scheduleBrowserDataSave();
    sendState();
    return { ok: true };
  });
  ipcMain.handle("browser:save-password", (event, fields) => {
    validate(event);
    const url = isWebUrl(fields?.url) ? fields.url : "";
    const username = String(fields?.username || "").slice(0, 160);
    const password = String(fields?.password || "").slice(0, 512);
    const title = cleanTitle(fields?.title || "");
    if (!url) return { ok: false, error: "无效网址" };
    const now = Date.now();
    const key = `${url}${username}`;
    const existing = browserData.passwords.find(item => `${item.url}${item.username}` === key);
    if (existing) {
      existing.password = password;
      existing.title = title || existing.title || url;
      existing.updatedAt = now;
    } else {
      browserData.passwords.unshift({
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        url,
        username,
        password,
        title: title || url,
        createdAt: now,
        updatedAt: now
      });
      browserData.passwords = browserData.passwords.slice(0, 200);
    }
    scheduleBrowserDataSave();
    sendState();
    return { ok: true, passwords: browserData.passwords.slice(0, 200) };
  });
  ipcMain.handle("browser:delete-password", (event, id) => {
    validate(event);
    browserData.passwords = browserData.passwords.filter(item => item.id !== String(id));
    scheduleBrowserDataSave();
    sendState();
    return { ok: true };
  });
  ipcMain.handle("browser:set-site-permission", (event, permission, allowed) => {
    validate(event);
    const site = activeSiteSnapshot();
    if (site.local || !site.origin) return { ok: false };
    browserData.permissions[site.origin] ||= {};
    browserData.permissions[site.origin][String(permission || "")] = allowed ? "granted" : "denied";
    scheduleBrowserDataSave();
    sendState();
    return { ok: true };
  });
  ipcMain.handle("browser:new-window", event => {
    validate(event);
    createWindow();
    return { ok: true };
  });
  ipcMain.handle("browser:open-dev-tools", event => {
    validate(event);
    getActiveTab()?.view.webContents.openDevTools({ mode: "detach" });
    return { ok: true };
  });
  ipcMain.handle("browser:translate", event => {
    validate(event);
    createTab("https://translate.google.com/", true);
    return { ok: true };
  });
  ipcMain.handle("browser:share", event => {
    validate(event);
    const url = getActiveTab()?.url || "";
    clipboard.writeText(url);
    return { ok: true, url };
  });
  ipcMain.handle("browser:zoom", (event, delta) => {
    validate(event);
    return setActiveZoom(delta);
  });
  ipcMain.handle("browser:print", event => {
    validate(event);
    getActiveTab()?.view.webContents.print({ printBackground: true });
  });
  ipcMain.handle("browser:minimize-window", event => {
    validate(event);
    mainWindow?.minimize();
  });
  ipcMain.handle("browser:toggle-maximize-window", event => {
    validate(event);
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("browser:close-window", event => {
    validate(event);
    mainWindow?.close();
  });
}

async function navigateForTest(contents, url, waitAfterMs = 1000) {
  const startedAt = Date.now();
  const result = await new Promise(resolve => {
    const timeout = setTimeout(() => finish({ success: false, error: "timeout" }), 30000);
    const onFinish = () => finish({ success: true, error: null });
    const onFail = (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) finish({ success: false, error: `${code} ${description}`, failedUrl });
    };
    const finish = value => {
      clearTimeout(timeout);
      contents.removeListener("did-finish-load", onFinish);
      contents.removeListener("did-fail-load", onFail);
      resolve(value);
    };
    contents.once("did-finish-load", onFinish);
    contents.on("did-fail-load", onFail);
    contents.loadURL(url);
  });
  await delay(waitAfterMs);

  let documentState = { charset: "", bodyLength: 0, bodyPreview: "", video: null };
  if (result.success) {
    try {
      documentState = await contents.executeJavaScript(`(() => {
        const video = document.querySelector("video");
        return {
          charset: document.characterSet || "",
          bodyLength: document.body?.innerText?.length || 0,
          bodyPreview: (document.body?.innerText || "").slice(0, 220),
          video: video ? {
            paused: video.paused,
            readyState: video.readyState,
            currentTime: Number(video.currentTime.toFixed(2)),
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight
          } : null
        };
      })()`);
    } catch {
    }
  }
  return {
    requestedUrl: url,
    finalUrl: contents.getURL(),
    title: contents.getTitle(),
    elapsedMilliseconds: Date.now() - startedAt,
    ...result,
    ...documentState
  };
}

async function runSelfTest() {
  const diagnostics = path.join(app.getPath("userData"), "diagnostics");
  fs.mkdirSync(diagnostics, { recursive: true });
  const tab = getActiveTab();
  const contents = tab.view.webContents;
  const pages = [];
  pages.push(await navigateForTest(contents, HOME_URL, 700));
  const homeDefaults = await contents.executeJavaScript(`(() => ({
    theme: document.documentElement.dataset.theme,
    accent: document.documentElement.style.getPropertyValue("--accent"),
    glassColor: document.documentElement.style.getPropertyValue("--glass-color"),
    blur: document.documentElement.style.getPropertyValue("--blur"),
    transparencyLabel: document.getElementById("alphaValue")?.textContent || "",
    searchOutline: getComputedStyle(document.getElementById("searchInput")).outlineStyle,
    hasSourceCaption: /设计灵感|背景视频壁纸|dsh-wallpaper-engine/.test(document.body.innerText)
  }))()`);
  const homeLayoutChecks = [];
  mainWindow.showInactive();
  await delay(180);
  for (const [width, height] of [[1440, 920], [1280, 720], [920, 640]]) {
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
    await delay(80);
    layoutViews();
    await delay(180);
    homeLayoutChecks.push(await measureHomeLayout(contents, width, height));
  }
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: 1440, height: 920 });
  await delay(80);
  layoutViews();
  const chromeUi = await chromeView.webContents.executeJavaScript(`(() => {
    const backdrop = document.getElementById("chromeBackdropVideo");
    const coreIconSelectors = [
      "#newTab", "#minimizeWindow", "#maximizeWindow", "#closeWindow",
      "#back", "#forward", "#reload", "#siteSecurity",
      "#bookmarkPage", "#themeButton", "#appearanceButton", "#downloadsButton",
      "#menuButton"
    ];
    const iconButtonChecks = Object.fromEntries(coreIconSelectors.map(selector => {
      const button = document.querySelector(selector);
      const icon = button?.querySelector("svg");
      const rect = icon?.getBoundingClientRect();
      return [selector, Boolean(icon && rect && rect.width >= 12 && rect.height >= 12)];
    }));
    return {
      iconLoaded: document.querySelector(".connection-orbit img")?.naturalWidth > 0,
      lucideReady: typeof window.lucide?.createIcons === "function",
      svgIconCount: document.querySelectorAll(".browser-chrome button svg").length,
      iconButtonChecks,
      connectionClass: document.getElementById("connectionIndicator")?.className || "",
      connectionAnimation: getComputedStyle(document.querySelector(".connection-orbit"), "::before").animationName,
      hasTabs: Boolean(document.getElementById("tabs")),
      hasAddressBar: Boolean(document.getElementById("address")),
      hasVideoBackdrop: Boolean(backdrop),
      bodyClass: document.body.className,
      backdropOpacity: backdrop ? getComputedStyle(backdrop.closest(".chrome-backdrop")).opacity : "",
      backdropVideo: backdrop ? {
        paused: backdrop.paused,
        readyState: backdrop.readyState,
        currentTime: Number(backdrop.currentTime.toFixed(2)),
        videoWidth: backdrop.videoWidth,
        videoHeight: backdrop.videoHeight
      } : null,
      chromeUsesBackdropBlur: getComputedStyle(document.querySelector(".browser-chrome")).backdropFilter.includes("blur"),
      chromeHasDarkEdge: parseFloat(getComputedStyle(document.querySelector(".browser-chrome")).borderBottomWidth) > 0,
      hasFindBar: Boolean(document.getElementById("findBar")),
      hasSiteInfo: Boolean(document.getElementById("siteSecurity"))
    };
  })()`);
  chromeUi.homeViewUnderChrome = getActiveTab().view.getBounds().y === 0;
  await chromeView.webContents.executeJavaScript(`openModule("menu")`);
  await delay(180);
  const chromeModuleUi = await chromeView.webContents.executeJavaScript(`(() => ({
    overlayVisible: !document.getElementById("moduleOverlay").hidden,
    menuRowCount: document.querySelectorAll("#moduleContent .menu-row").length
  }))()`);
  chromeModuleUi.fullHeightOverlay = chromeView.getBounds().height === mainWindow.getContentSize()[1];
  await chromeView.webContents.executeJavaScript(`closeModule()`);
  await delay(80);
  let chromeScreenshotPath = path.join(diagnostics, "chrome.png");
  let chromeScreenshotError = null;
  try {
    const chromeScreenshot = await chromeView.webContents.capturePage();
    fs.writeFileSync(chromeScreenshotPath, chromeScreenshot.toPNG());
  } catch (error) {
    chromeScreenshotPath = null;
    chromeScreenshotError = String(error?.message || error);
  }
  mainWindow.hide();
  if (!homeLayoutChecks.every(check => check.fitsViewport)) throw new Error("主页未能在全部测试窗口中一屏显示");
  if ((pages[0].video?.videoWidth || 0) < 1800) throw new Error("主页未加载高清背景视频");
  if (homeDefaults.hasSourceCaption) throw new Error("主页仍显示设计来源文字");
  if (!chromeUi.iconLoaded || !chromeUi.connectionClass.includes("is-connected") || chromeUi.connectionAnimation !== "none") throw new Error("顶部静态连接图标未正确渲染");
  const missingCoreIcons = Object.entries(chromeUi.iconButtonChecks).filter(([, visible]) => !visible).map(([selector]) => selector);
  if (!chromeUi.lucideReady || chromeUi.svgIconCount < 15 || missingCoreIcons.length) {
    throw new Error(`顶部核心按钮图标未正确渲染 (lucide=${chromeUi.lucideReady}, svg=${chromeUi.svgIconCount}, missing=${missingCoreIcons.join(",") || "none"})`);
  }
  if (!chromeUi.bodyClass.includes("is-home") || Number(chromeUi.backdropOpacity) !== 0) throw new Error("主页顶部未正确透出下层高清背景视频");
  if (!chromeUi.hasTabs || !chromeUi.hasAddressBar || !chromeUi.hasVideoBackdrop || !chromeUi.chromeUsesBackdropBlur || chromeUi.chromeHasDarkEdge || !chromeUi.homeViewUnderChrome) throw new Error("玻璃浏览器状态栏或全屏视频底层未正确渲染");
  if (!chromeUi.hasFindBar || !chromeUi.hasSiteInfo) throw new Error("浏览器查找或网站信息模块缺失");
  if (!chromeModuleUi.overlayVisible || !chromeModuleUi.fullHeightOverlay || chromeModuleUi.menuRowCount < 8) throw new Error("浏览器模块面板未正确展开");
  pages.push(await navigateForTest(contents, "https://api.ipify.org/", 250));
  pages.push(await navigateForTest(contents, "https://www.google.com/search?q=twitter", 1200));
  pages.push(await navigateForTest(contents, "https://x.com/", 1800));

  const verifiedConnection = { ...connection };
  const resolvedProxy = await browserSession.resolveProxy("https://www.google.com/");
  tunnel?.stop();
  await failClosed("自检主动断开");
  let failClosedVerified = false;
  try {
    await browserSession.fetch("https://api.ipify.org/", {
      cache: "no-store",
      signal: AbortSignal.timeout(3500)
    });
  } catch {
    failClosedVerified = true;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    proxy: resolvedProxy,
    connection: verifiedConnection,
    failClosedVerified,
    startupTimings,
    homeDefaults,
    homeLayoutChecks,
    chromeUi,
    chromeModuleUi,
    chromeScreenshot: chromeScreenshotPath,
    chromeScreenshotError,
    framelessVerified: (() => {
      const bounds = mainWindow.getBounds();
      const contentBounds = mainWindow.getContentBounds();
      return bounds.width === contentBounds.width && bounds.height === contentBounds.height;
    })(),
    pages
  };
  fs.writeFileSync(path.join(diagnostics, "self-test.json"), JSON.stringify(report, null, 2), "utf8");
}

async function measureHomeLayout(contents, windowWidth, windowHeight) {
  const [actualWindowWidth, actualWindowHeight] = mainWindow.getContentSize();
  const pageBounds = getActiveTab().view.getBounds();
  const page = await contents.executeJavaScript(`(() => {
    const selectors = [".topbar", ".hero", ".links", ".foot"];
    const elements = selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return { selector, visible: false };
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        selector,
        visible: style.display !== "none" && style.visibility !== "hidden",
        top: Number(rect.top.toFixed(1)),
        bottom: Number(rect.bottom.toFixed(1)),
        height: Number(rect.height.toFixed(1))
      };
    });
    const visibleElements = elements.filter(element => element.visible);
    return {
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      elements,
      fitsViewport: document.documentElement.scrollHeight <= innerHeight + 1 &&
        visibleElements.every(element => element.top >= -1 && element.bottom <= innerHeight + 1)
    };
  })()`);
  return { requestedWindowWidth: windowWidth, requestedWindowHeight: windowHeight, actualWindowWidth, actualWindowHeight, pageBounds, ...page };
}

async function startApplication() {
  registerLocalProtocol();
  await restoreStaleSystemProxy().catch(() => {});
  loadBrowserData();
  try { browserRoute = normalizeBrowserRoute(JSON.parse(fs.readFileSync(browserRoutePath(), "utf8"))); } catch {}
  if (browserRoute.mode === "node" && browserRoute.nodeId === "local") browserRoute = { mode: "default" };
  proxyNodeStore = new ProxyNodeStore({
    safeStorage,
    userDataPath: app.getPath("userData"),
    appDataPath: app.getPath("appData")
  });
  const startupSession = browserData.settings.restoreSession
    ? JSON.parse(JSON.stringify(browserData.session))
    : null;
  setupBrowserSession();
  proxySubscriptionStore = new ProxySubscriptionStore({
    safeStorage,
    userDataPath: app.getPath("userData"),
    fetcher: (url, options) => electronNet.fetch(url, options)
  });
  accountService = new AccountService({
    session: session.fromPartition("persist:drip-account"),
    userDataPath: app.getPath("userData"),
    onChange: state => {
      const fingerprint = JSON.stringify([state.status, state.user?.id, state.entitlement?.active,
        state.managedNodes?.map(node => node.id)]);
      if (fingerprint !== accountAccessFingerprint) {
        accountAccessFingerprint = fingerprint;
        accountAccessEpoch += 1;
      }
      sendState();
    }
  });
  updateManager = new UpdateManager({
    getWindow: () => mainWindow,
    onChange: sendState,
    logDirectory: path.join(app.getPath("userData"), "logs")
  });
  // fail-closed 代理先行：外部导航必须先走这一层；此调用为本地配置，近乎瞬时。
  for (const target of allBrowserSessions()) {
    await target.setProxy({ mode: "fixed_servers", proxyRules: FAIL_CLOSED_PROXY });
  }
  if (browserRoute.mode !== "node") await applyActiveBrowserProxy();
  installIpcHandlers();

  // 首帧先行：立即创建窗口并加载本地主页（liquid://home 走自定义协议，不经过代理），
  // 让用户第一时间看到界面；隧道与扩展在后台并行预热。
  createWindow();

  if (ELEVATION_NONCE && !SELF_TEST && !ACCEPT_TEST) {
    const intent = consumeElevationIntent(elevationIntentPath(), ELEVATION_NONCE);
    if (intent) {
      openProxyCenter().then(() => startManagedProxy(intent)).catch(error => {
        managedProxyState = { ...managedProxyState, active: false, starting: false, error: error.message };
        sendState();
      });
    } else {
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "TUN 未启动",
        message: "管理员窗口未能读取之前选择的节点配置",
        detail: "如果 Windows 使用了另一个管理员账号，请在该账号下导入节点后重试。"
      }).catch(() => {});
    }
  }

  if (ACCEPT_TEST) {
    const runAcceptTest = require("./accept-test.cjs");
    await runAcceptTest({ mainWindow, chromeView, delay });
    quitting = true;
    mainWindow?.close();
    app.quit();
    return;
  }

  const tunnelPromise = SELF_TEST ? startTunnel() : accountService.restore().then(async () => {
    await reconcileBrowserRoute();
    updateManager?.schedule();
    const interval = setInterval(() => (async () => {
      await accountService.refreshManagedAccess();
      if (browserRouteUsesManagedAccess()) await reconcileBrowserRoute();
      await stopUnauthorizedManagedProxy();
    })().catch(error => console.error("授权状态刷新失败:", error)), 60000);
    interval.unref();
  });
  if (["node"].includes(browserRoute.mode)) {
    const savedRoute = browserRoute;
    browserRouteChange = selectBrowserRoute(savedRoute, false).catch(error => {
      browserRouteError = error.message;
      sendState();
    });
  }
  const extensionsPromise = loadPersistedExtensions();

  if (SELF_TEST) {
    await Promise.all([tunnelPromise, extensionsPromise]);
    await runSelfTest();
    quitting = true;
    mainWindow?.close();
    app.quit();
    return;
  }

  // 恢复会话放后台：等隧道连通后再加载外部标签，避免经 fail-closed 代理先报错。
  if (startupSession) {
    tunnelPromise.then(() => {
      if (startupSession && connection.state === "connected") restoreStartupSession(startupSession);
    });
  }
  // 扩展加载完成后即可；已在后台并行，不阻塞首帧（失败不阻断浏览器）。
  extensionsPromise.catch(() => {});
}

if (IMPORT_CLASH_JAPAN) {
  app.whenReady().then(() => {
    const store = new ProxyNodeStore({
      safeStorage,
      userDataPath: app.getPath("userData"),
      appDataPath: app.getPath("appData")
    });
    process.stdout.write(`${JSON.stringify(store.importJapan())}\n`);
    app.quit();
  }).catch(error => {
    process.stderr.write(`导入失败：${error.message}\n`);
    app.exit(1);
  });
} else {
  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
      const target = (argv || []).slice(1).find(value => /^https?:\/\//i.test(String(value)));
      if (target) createTab(sanitizeTarget(target), true);
    });
    app.whenReady().then(startApplication).catch(async error => {
      const errorDirectory = app.getPath("userData");
      fs.mkdirSync(errorDirectory, { recursive: true });
      fs.writeFileSync(path.join(errorDirectory, "startup-error.log"), error.stack || error.message, "utf8");
      if (!SELF_TEST && !ACCEPT_TEST) {
        await dialog.showMessageBox({
          type: "error",
          title: "Drip 启动失败",
          message: error.message,
          detail: "浏览器保持失败关闭，没有回退到本机直连。"
        });
      }
      app.quit();
    });
  }
}

app.on("before-quit", event => {
  if (IMPORT_CLASH_JAPAN) return;
  if (!managedProxyQuitCleanup && (managedProxyState.active || managedProxyState.starting || managedProxyChild || managedProxySystemProxy)) {
    event.preventDefault();
    managedProxyQuitCleanup = true;
    stopManagedProxy().finally(() => app.quit());
    return;
  }
  quitting = true;
  captureSession();
  saveBrowserData();
  updateManager?.dispose();
  stopBrowserRouteCore();
  tunnel?.stop();
});

app.on("window-all-closed", () => {
  if (!quitting) app.quit();
});
