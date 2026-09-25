const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_DETAILS_URL = process.env.DRIP_UPDATE_URL || "https://example.invalid/releases";

class UpdateManager {
  constructor({ getWindow, onChange, logDirectory }) {
    this.getWindow = getWindow;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.interval = null;
    this.initialTimer = null;
    this.prompting = false;
    this.state = {
      status: app.isPackaged ? "idle" : "development",
      currentVersion: app.getVersion(),
      latestVersion: null,
      detailsUrl: UPDATE_DETAILS_URL,
      progress: 0,
      transferred: 0,
      total: 0,
      error: null
    };

    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, "updates.log");
    autoUpdater.logger = {
      info: (...values) => this.writeLog(logPath, "INFO", values),
      warn: (...values) => this.writeLog(logPath, "WARN", values),
      error: (...values) => this.writeLog(logPath, "ERROR", values),
      debug: (...values) => this.writeLog(logPath, "DEBUG", values)
    };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on("checking-for-update", () => {
      this.emit({ status: "checking", progress: 0, error: null });
    });
    autoUpdater.on("update-not-available", info => {
      this.emit({
        status: "up-to-date",
        latestVersion: info?.version || app.getVersion(),
        progress: 0,
        error: null
      });
    });
    autoUpdater.on("update-available", info => {
      this.emit({ status: "available", latestVersion: info?.version || null, error: null });
    });
    autoUpdater.on("download-progress", progress => {
      this.emit({
        status: "downloading",
        progress: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
        error: null
      });
    });
    autoUpdater.on("update-downloaded", info => {
      this.emit({
        status: "downloaded",
        latestVersion: info?.version || this.state.latestVersion,
        progress: 100,
        error: null
      });
    });
    autoUpdater.on("error", error => {
      this.emit({ status: "error", error: this.cleanError(error), progress: 0 });
    });
  }

  writeLog(filePath, level, values) {
    try {
      const line = values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
      fs.appendFileSync(filePath, `${new Date().toISOString()} [${level}] ${line}\n`, "utf8");
    } catch {}
  }

  cleanError(error) {
    const text = String(error?.message || error || "更新服务暂时不可用");
    return text.replace(/https?:\/\/\S+/g, "更新服务器").slice(0, 180);
  }

  snapshot() {
    return { ...this.state };
  }

  emit(next) {
    this.state = { ...this.state, ...next };
    this.onChange(this.snapshot());
    return this.snapshot();
  }

  async useTunnel(port) {
    if (!app.isPackaged || !port) return;
    await autoUpdater.netSession.setProxy({
      mode: "fixed_servers",
      proxyRules: `http://127.0.0.1:${port}`
    });
    await autoUpdater.netSession.closeAllConnections();
  }

  schedule() {
    if (!app.isPackaged || this.initialTimer || this.interval) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.check(false).catch(() => {});
    }, 12000);
    this.interval = setInterval(() => this.check(false).catch(() => {}), CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  async check(manual = true) {
    if (!app.isPackaged) {
      return this.emit({ status: "development", error: manual ? "开发预览版不连接更新源，请安装正式版后检查" : null });
    }
    if (["checking", "downloading"].includes(this.state.status)) return this.snapshot();
    this.emit({ status: "checking", error: null });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.emit({ status: "error", error: this.cleanError(error) });
    }
    return this.snapshot();
  }

  async download() {
    if (!app.isPackaged) return this.check(true);
    if (this.state.status === "downloaded") return this.snapshot();
    this.emit({ status: "downloading", progress: 0, error: null });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.emit({ status: "error", error: this.cleanError(error), progress: 0 });
    }
    return this.snapshot();
  }

  install() {
    if (this.state.status !== "downloaded") return false;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }

  dispose() {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.interval) clearInterval(this.interval);
    this.initialTimer = null;
    this.interval = null;
  }
}

module.exports = { UpdateManager };
