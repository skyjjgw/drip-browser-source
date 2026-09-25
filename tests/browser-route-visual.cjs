const { app, BaseWindow, WebContentsView, protocol, net } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const output = process.argv[2] || path.join(os.tmpdir(), "drip-browser-route.png");
protocol.registerSchemesAsPrivileged([{ scheme: "liquid", privileges: { standard: true, secure: true, stream: true } }]);
app.setPath("userData", path.join(os.tmpdir(), "drip-browser-route-test"));

app.whenReady().then(async () => {
  protocol.handle("liquid", request => {
    const url = new URL(request.url);
    const base = { ui: "ui", home: "home", assets: "assets" }[url.host];
    if (!base) return new Response("Not found", { status: 404 });
    const target = path.resolve(root, base, url.pathname.slice(1));
    if (!target.startsWith(`${path.resolve(root, base)}${path.sep}`) || !fs.existsSync(target)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
  const window = new BaseWindow({ width: 1200, height: 750, show: false, frame: false, backgroundColor: "#12253d" });
  window.showInactive();
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "browser-route-preload.cjs"), contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1200, height: 750 });
  await view.webContents.loadURL("liquid://ui/chrome.html");
  await new Promise(resolve => setTimeout(resolve, 300));
  const result = await view.webContents.executeJavaScript(`(() => {
    document.getElementById('browserRouteButton').click();
    const panel = document.querySelector('.browser-route-panel').getBoundingClientRect();
    const option = document.querySelector('[data-route*="direct"]').getBoundingClientRect();
    return {
      open: !document.getElementById('browserRouteOverlay').hidden,
      options: document.querySelectorAll('.browser-route-option').length,
      button: document.getElementById('browserRouteButton').getAttribute('aria-expanded'),
      panel: { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
      optionHit: document.elementFromPoint(option.x + option.width / 2, option.y + option.height / 2)?.closest('.browser-route-option')?.dataset.route
    };
  })()`);
  if (!result.open || result.options !== 3 || result.button !== "true" || !result.optionHit?.includes("direct") || result.panel.y < 94) {
    throw new Error(`Browser route popup failed: ${JSON.stringify(result)}`);
  }
  const accountChecks = await view.webContents.executeJavaScript(`(() => {
    document.getElementById('browserRouteButton').click();
    liquidBrowser.mockAccount({ status: 'signed-in', user: { id: 5, username: 'test', displayName: '测试', createdAt: 0 },
      entitlement: { active: false, usedBytes: 0, quotaBytes: 0, endsAt: null } });
    document.getElementById('profileButton').click();
    const redeemVisible = Boolean(document.querySelector('#inviteCode'));
    const statusVisible = document.querySelector('#moduleContent')?.textContent.includes('未授权或已失效');
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const avatarData = canvas.toDataURL('image/jpeg');
    liquidBrowser.mockAccount({ status: 'signed-in', user: { id: 5, username: 'test', displayName: '测试', createdAt: 0, avatarData },
      entitlement: { active: true, usedBytes: 0, quotaBytes: 1073741824, endsAt: 1800000000 } });
    const redeemVisibleAfterGrant = Boolean(document.querySelector('#inviteCode'));
    const avatarButton = document.querySelector('.profile-avatar-edit');
    const avatarVisible = Boolean(avatarButton?.querySelector('img') && document.querySelector('#profileInitial img') && document.querySelector('.avatar-remove'));
    const avatarBounds = avatarButton.getBoundingClientRect();
    const avatarHit = document.elementFromPoint(avatarBounds.x + avatarBounds.width / 2, avatarBounds.y + avatarBounds.height / 2)?.closest('.profile-avatar-edit') === avatarButton;
    document.getElementById('closeModule').click();
    liquidBrowser.mockNodes([{ id: 'managed:jp', name: '日本代理', source: 'Drip 授权线路' }]);
    document.getElementById('browserRouteButton').click();
    const authorizedVisible = Boolean(document.querySelector('[data-route*="managed:jp"]'));
    const legacyHidden = !document.querySelector('[data-route*="local"]');
    return { redeemVisible, statusVisible, redeemVisibleAfterGrant, avatarVisible, avatarHit, authorizedVisible, legacyHidden };
  })()`);
  if (Object.values(accountChecks).some(value => !value)) throw new Error(`Account entitlement UI failed: ${JSON.stringify(accountChecks)}`);
  const compressedAvatar = await view.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 300;
    canvas.getContext('2d').fillRect(0, 0, 400, 300);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const data = await prepareAccountAvatar(new File([blob], 'avatar.png', { type: 'image/png' }));
    return { jpeg: data.startsWith('data:image/jpeg;base64,'), length: data.length };
  })()`);
  if (!compressedAvatar.jpeg || compressedAvatar.length > 90000) throw new Error(`Avatar processing failed: ${JSON.stringify(compressedAvatar)}`);
  await view.webContents.executeJavaScript(`(() => {
    document.getElementById('browserRouteButton').click();
    document.getElementById('profileButton').click();
  })()`);
  await new Promise(resolve => setTimeout(resolve, 220));
  fs.writeFileSync(output, (await view.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ ...result, ...accountChecks, screenshot: output }));
  window.close();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
