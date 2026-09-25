const { app, BaseWindow, WebContentsView, protocol, net } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const output = process.argv[2] || path.join(os.tmpdir(), "drip-proxy-visual.png");
protocol.registerSchemesAsPrivileged([{ scheme: "liquid", privileges: { standard: true, secure: true } }]);
app.setPath("userData", path.join(os.tmpdir(), "drip-proxy-visual-profile"));

app.whenReady().then(async () => {
  protocol.handle("liquid", request => {
    const url = new URL(request.url);
    const base = { ui: "ui", home: "home", assets: "assets" }[url.host];
    if (!base) return new Response("Not found", { status: 404 });
    const target = path.resolve(root, base, url.pathname.slice(1));
    if (!target.startsWith(`${path.resolve(root, base)}${path.sep}`) || !fs.existsSync(target)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
  const window = new BaseWindow({ width: 1280, height: 800, show: false, frame: false, backgroundColor: "#12253d" });
  window.setOpacity(0);
  window.showInactive();
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  await view.webContents.loadURL("liquid://ui/proxy/index.html");
  await new Promise(resolve => setTimeout(resolve, 700));
  const checks = await view.webContents.executeJavaScript(`(() => ({
    title: document.title,
    pages: document.querySelectorAll('.side-nav button').length,
    background: getComputedStyle(document.querySelector('.wallpaper')).backgroundImage,
    iconLoaded: document.querySelector('.sidebar-brand img').complete && document.querySelector('.sidebar-brand img').naturalWidth > 0,
    iconsLoaded: document.querySelectorAll('.side-nav svg').length,
    headerRegion: getComputedStyle(document.querySelector('.main-top')).getPropertyValue('-webkit-app-region')
  }))()`);
  const topButton = await view.webContents.executeJavaScript(`(() => {
    const bounds = document.querySelector('#runtime-toggle').getBoundingClientRect();
    window.__hitCounts = { top: 0, bottom: 0 };
    document.querySelector('#runtime-toggle').addEventListener('click', event => {
      const middle = bounds.top + bounds.height / 2;
      window.__hitCounts[event.clientY < middle ? 'top' : 'bottom']++;
    });
    return { x: Math.round(bounds.x + bounds.width / 2), top: Math.round(bounds.top + 4), bottom: Math.round(bounds.bottom - 4),
      topElement: document.elementFromPoint(bounds.x + bounds.width / 2, bounds.top + 4)?.closest('button')?.id,
      bottomElement: document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 4)?.closest('button')?.id };
  })()`);
  for (const y of [topButton.top, topButton.bottom]) {
    view.webContents.sendInputEvent({ type: "mouseMove", x: topButton.x, y });
    view.webContents.sendInputEvent({ type: "mouseDown", x: topButton.x, y, button: "left", clickCount: 1 });
    view.webContents.sendInputEvent({ type: "mouseUp", x: topButton.x, y, button: "left", clickCount: 1 });
  }
  await new Promise(resolve => setTimeout(resolve, 80));
  const hitCounts = await view.webContents.executeJavaScript(`window.__hitCounts`);
  if (checks.headerRegion !== "no-drag" || hitCounts.top !== 1 || hitCounts.bottom !== 1) {
    throw new Error(`Top button hit test failed: ${JSON.stringify({ checks, topButton, hitCounts })}`);
  }
  fs.writeFileSync(output, (await view.webContents.capturePage()).toPNG());
  const closeChecks = await view.webContents.executeJavaScript(`(() => {
    renderRuntime({ active: true, starting: false, error: null, mode: 'rule', nodeId: 'local' });
    showCloseDialog();
    const active = {
      title: document.querySelector('#dialog-title').textContent,
      action: document.querySelector('#confirm-close').textContent,
      enabled: !document.querySelector('#confirm-close').disabled
    };
    hideCloseDialog();
    renderRuntime({ active: false, starting: true, error: null, mode: 'rule' });
    showCloseDialog();
    const starting = { enabled: !document.querySelector('#confirm-close').disabled };
    hideCloseDialog();
    renderRuntime({ active: false, starting: false, error: null, mode: 'rule' });
    return { active, starting };
  })()`);
  if (!closeChecks.active.enabled || closeChecks.active.action !== "停止并返回" ||
      closeChecks.starting.enabled) {
    throw new Error(`Close dialog state failed: ${JSON.stringify(closeChecks)}`);
  }
  const trafficChecks = await view.webContents.executeJavaScript(`(() => {
    renderTraffic({ active: true, uploadSpeed: 1024, downloadSpeed: 2048,
      todayUpload: 4096, todayDownload: 8192, memory: 65536, activeConnections: 1,
      history: [{ at: Date.now(), upload: 1024, download: 2048 }],
      connections: [{ target: 'example.test', port: '443', process: 'drip.exe', rule: 'final', chain: 'proxy', upload: 1024, download: 2048 }] });
    return { download: document.querySelector('#traffic-down-speed').textContent,
      today: document.querySelector('#traffic-today-down').textContent,
      chart: document.querySelector('#download-line').getAttribute('points')?.length,
      rows: document.querySelectorAll('#connections-body tr').length };
  })()`);
  if (trafficChecks.download !== "2.0 KB/s" || trafficChecks.today !== "8.0 KB" ||
      !trafficChecks.chart || trafficChecks.rows !== 1) {
    throw new Error(`Traffic rendering failed: ${JSON.stringify(trafficChecks)}`);
  }
  const target = await view.webContents.executeJavaScript(`(() => {
    const bounds = document.querySelector('[data-page="profiles"]').getBoundingClientRect();
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height / 2);
    return { x, y, hit: document.elementFromPoint(x, y)?.closest('button')?.dataset.page };
  })()`);
  view.webContents.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
  view.webContents.sendInputEvent({ type: "mouseDown", x: target.x, y: target.y, button: "left", clickCount: 1 });
  view.webContents.sendInputEvent({ type: "mouseUp", x: target.x, y: target.y, button: "left", clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 100));
  const profileChecks = await view.webContents.executeJavaScript(`(() => ({
    activePage: document.querySelector('.page.active').id,
    subscriptionInput: !!document.querySelector('#subscription-url')
  }))()`);
  if (target.hit !== "profiles" || profileChecks.activePage !== "page-profiles") {
    throw new Error(`Sidebar click failed: ${JSON.stringify({ target, profileChecks })}`);
  }
  const profilesOutput = output.replace(/\.png$/i, "-profiles.png");
  fs.writeFileSync(profilesOutput, (await view.webContents.capturePage()).toPNG());
  const delayEnabled = await view.webContents.executeJavaScript(`(() => {
    nodes = [{ id: 'local', name: 'Test node', source: 'local' }];
    renderNodes();
    return [...document.querySelectorAll('.delay-button')].every(button => !button.disabled);
  })()`);
  if (!delayEnabled) throw new Error("Delay button stayed disabled with a selected node");
  const pickerChecks = await view.webContents.executeJavaScript(`(() => {
    nodes = [
      { id: 'local', name: '日本代理', source: '本机配置' },
      { id: 'subscription:demo:0', name: '美国代理2', source: '我的订阅' }
    ];
    selectedNodeId = 'local';
    runtime = { active: false, starting: false, restarting: false, error: null };
    renderNodes();
    document.querySelector('#home-node-trigger').click();
    const opened = !document.querySelector('#home-node-menu').hidden;
    const options = [...document.querySelectorAll('.node-picker-option')].map(option => ({
      name: option.querySelector('strong').textContent,
      selected: option.classList.contains('selected')
    }));
    document.querySelectorAll('.node-picker-option')[1].click();
    return {
      opened,
      options,
      selectedNodeId,
      selectedName: document.querySelector('#home-node-name').textContent,
      closed: document.querySelector('#home-node-menu').hidden
    };
  })()`);
  if (!pickerChecks.opened || pickerChecks.options.length !== 2 ||
      !pickerChecks.options[0].selected || pickerChecks.options[1].selected ||
      pickerChecks.selectedNodeId !== 'subscription:demo:0' ||
      pickerChecks.selectedName !== '美国代理2' || !pickerChecks.closed) {
    throw new Error(`Node picker failed: ${JSON.stringify(pickerChecks)}`);
  }
  const groupChecks = await view.webContents.executeJavaScript(`(() => {
    proxyGroups = ['PROXY', 'GLOBAL'];
    selectedGroupName = 'PROXY';
    renderGroupPicker();
    document.querySelector('#home-group-trigger').click();
    const opened = !document.querySelector('#home-group-menu').hidden;
    const options = [...document.querySelectorAll('#home-group-menu .node-picker-option')].map(option => option.querySelector('strong').textContent);
    document.querySelectorAll('#home-group-menu .node-picker-option')[1].click();
    return { opened, options, selectedGroupName, choice: document.querySelector('#home-group-choice').textContent, closed: document.querySelector('#home-group-menu').hidden };
  })()`);
  if (!groupChecks.opened || groupChecks.options.join(',') !== 'PROXY,GLOBAL' ||
      groupChecks.selectedGroupName !== 'GLOBAL' || groupChecks.choice !== 'GLOBAL' || !groupChecks.closed) {
    throw new Error(`Group picker failed: ${JSON.stringify(groupChecks)}`);
  }
  const optimisticSelection = await view.webContents.executeJavaScript(`(() => {
    selectedNodeId = 'subscription:demo:0';
    selectedGroupName = 'PROXY';
    runtime = { active: false, starting: false, restarting: false, error: null, nodeId: 'local' };
    renderRuntime({ ...runtime, starting: true, nodeId: selectedNodeId, nodeName: '美国代理2', groupName: selectedGroupName });
    return { selectedNodeId, selectedName: document.querySelector('#home-node-name').textContent, group: selectedGroupName };
  })()`);
  if (optimisticSelection.selectedNodeId !== 'subscription:demo:0' || optimisticSelection.selectedName !== '美国代理2') {
    throw new Error(`Optimistic selection was overwritten: ${JSON.stringify(optimisticSelection)}`);
  }
  process.stdout.write(`${JSON.stringify({ ...checks, topButton, hitCounts, closeChecks, delayEnabled, pickerChecks, groupChecks, optimisticSelection, ...target, ...profileChecks, trafficChecks, screenshot: output, profilesScreenshot: profilesOutput })}\n`);
  window.close();
  app.quit();
}).catch(error => {
  process.stderr.write(`${error.message}\n`);
  app.exit(1);
});
