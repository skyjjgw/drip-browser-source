const { app, BaseWindow, WebContentsView, protocol, net } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const output = process.argv[2] || path.join(os.tmpdir(), "drip-home-shortcuts.png");
protocol.registerSchemesAsPrivileged([{ scheme: "liquid", privileges: { standard: true, secure: true } }]);
app.setPath("userData", path.join(os.tmpdir(), `drip-home-shortcuts-test-${process.pid}`));

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
  const window = new BaseWindow({ width: 1280, height: 800, show: false, frame: false });
  window.showInactive();
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  const errors = [];
  view.webContents.on("console-message", (_, level, message) => {
    if (level >= 3) errors.push(message);
  });
  await view.webContents.loadURL("liquid://home/index.html");
  await new Promise(resolve => setTimeout(resolve, 450));
  const initial = await view.webContents.executeJavaScript(`(() => ({
    count: document.querySelectorAll('#linksGrid .site').length,
    animation: getComputedStyle(document.querySelector('#heroVinyl'), '::before').animationName,
    iconLoaded: document.querySelector('#heroVinyl img').naturalWidth > 0,
    manageIcon: !!document.querySelector('#manageSitesButton svg'),
    hit: document.elementFromPoint(...(() => { const r = document.querySelector('#manageSitesButton').getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]; })())?.closest('button')?.id
  }))()`);
  assert.equal(initial.count, 8);
  assert.equal(initial.animation, "hero-glow-breathe");
  assert.equal(initial.iconLoaded, true);
  assert.equal(initial.manageIcon, true);
  assert.equal(initial.hit, "manageSitesButton");
  fs.writeFileSync(output, (await view.webContents.capturePage()).toPNG());
  await view.webContents.executeJavaScript(`document.querySelector('#manageSitesButton').click()`);
  const dialogOpen = await view.webContents.executeJavaScript(`document.querySelector('#sitesDialog').open`);
  assert.equal(dialogOpen, true);
  const dialogGeometry = await view.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#sitesDialog');
    const rect = dialog.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      display: getComputedStyle(dialog).display,
      hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('dialog')?.id };
  })()`);
  assert.equal(dialogGeometry.hit, "sitesDialog", JSON.stringify(dialogGeometry));
  await new Promise(resolve => setTimeout(resolve, 120));
  const dialogOutput = output.replace(/\.png$/i, "-dialog.png");
  view.webContents.debugger.attach("1.3");
  const dialogCapture = await view.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(dialogOutput, Buffer.from(dialogCapture.data, "base64"));
  await view.webContents.executeJavaScript(`document.querySelector('#addSiteButton').click()`);
  await new Promise(resolve => setTimeout(resolve, 80));
  const formOutput = output.replace(/\.png$/i, "-form.png");
  const formCapture = await view.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(formOutput, Buffer.from(formCapture.data, "base64"));
  view.webContents.debugger.detach();
  await view.webContents.executeJavaScript(`document.querySelector('#closeSitesButton').click()`);

  const edited = await view.webContents.executeJavaScript(`(() => {
    document.querySelector('#manageSitesButton').click();
    document.querySelector('#addSiteButton').click();
    document.querySelector('#siteName').value = '<b>测试</b>';
    document.querySelector('#siteUrl').value = 'example.com/path';
    document.querySelector('#siteDescription').value = '我的站点';
    document.querySelector('#sitesForm').requestSubmit();
    const added = {
      count: document.querySelectorAll('#linksGrid .site').length,
      href: document.querySelector('#linksGrid .site:last-child').href,
      inert: !document.querySelector('#linksGrid .site:last-child img')
    };
    document.querySelector('#sitesList .sites-dialog__row:last-child button').click();
    document.querySelector('#siteName').value = '自定义站点';
    document.querySelector('#sitesForm').requestSubmit();
    return { added, editedName: document.querySelector('#linksGrid .site:last-child .site__name').textContent,
      stored: localStorage.getItem('drip-quick-sites-v1') !== null };
  })()`);
  assert.equal(edited.added.count, 9);
  assert.equal(edited.added.href, "https://example.com/path");
  assert.equal(edited.added.inert, true);
  assert.equal(edited.editedName, "自定义站点");
  assert.equal(edited.stored, true);
  const rejection = await view.webContents.executeJavaScript(`(() => {
    document.querySelector('#addSiteButton').click();
    document.querySelector('#siteName').value = 'Invalid';
    document.querySelector('#siteUrl').value = 'javascript:alert(1)';
    document.querySelector('#sitesForm').requestSubmit();
    return { count: document.querySelectorAll('#linksGrid .site').length,
      error: document.querySelector('#sitesFormError').textContent };
  })()`);
  assert.equal(rejection.count, 9);
  assert.match(rejection.error, /http\/https/);
  await view.webContents.reload();
  const persisted = await view.webContents.executeJavaScript(`(() => ({
    count: document.querySelectorAll('#linksGrid .site').length,
    name: document.querySelector('#linksGrid .site:last-child .site__name').textContent
  }))()`);
  assert.deepEqual(persisted, { count: 9, name: "自定义站点" });
  const removed = await view.webContents.executeJavaScript(`(() => {
    window.confirm = () => true;
    document.querySelector('#manageSitesButton').click();
    document.querySelector('#sitesList .sites-dialog__row:last-child button:last-child').click();
    return { count: document.querySelectorAll('#linksGrid .site').length,
      stored: JSON.parse(localStorage.getItem('drip-quick-sites-v1')).length };
  })()`);
  assert.deepEqual(removed, { count: 8, stored: 8 });
  window.setBounds({ x: 0, y: 0, width: 920, height: 640 });
  view.setBounds({ x: 0, y: 0, width: 920, height: 640 });
  await new Promise(resolve => setTimeout(resolve, 80));
  const compact = await view.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('#sitesDialog').getBoundingClientRect();
    const button = document.querySelector('#manageSitesButton').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, right: rect.right,
      buttonVisible: button.top >= 94 && button.bottom <= innerHeight };
  })()`);
  assert.ok(compact.top >= 94 && compact.bottom <= 640 && compact.right <= 920, JSON.stringify(compact));
  assert.equal(compact.buttonVisible, true);
  assert.equal(errors.length, 0, errors.join("\n"));
  process.stdout.write(`${JSON.stringify({ initial, dialogGeometry, edited, rejection, persisted, removed, compact, screenshot: output, dialogScreenshot: dialogOutput, formScreenshot: formOutput })}\n`);
  window.close();
  app.quit();
}).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  app.exit(1);
});
