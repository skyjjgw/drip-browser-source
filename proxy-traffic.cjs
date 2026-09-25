"use strict";

const fs = require("node:fs");
const path = require("node:path");

const positive = value => Number.isFinite(value) && value >= 0 ? value : 0;
const dayKey = timestamp => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function normalizeConnections(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 80).map(item => {
    const metadata = item?.metadata || {};
    const text = value => typeof value === "string" ? value.slice(0, 200) : "";
    const processName = typeof metadata.processPath === "string" ? path.win32.basename(metadata.processPath).slice(0, 200) : "";
    return {
      id: text(item?.id),
      target: text(metadata.host || metadata.destinationIP) || "--",
      port: text(metadata.destinationPort),
      process: processName || "--",
      rule: text(item?.rule) || "--",
      chain: Array.isArray(item?.chains) ? item.chains.map(text).filter(Boolean).join(" / ").slice(0, 200) : "--",
      upload: positive(item?.upload),
      download: positive(item?.download)
    };
  });
}

class ProxyTrafficTracker {
  constructor(filePath, now = () => Date.now()) {
    this.filePath = filePath;
    this.now = now;
    this.day = dayKey(now());
    this.todayUpload = 0;
    this.todayDownload = 0;
    this.sessionUpload = 0;
    this.sessionDownload = 0;
    this.uploadSpeed = 0;
    this.downloadSpeed = 0;
    this.memory = 0;
    this.connections = [];
    this.history = [];
    this.previousRaw = { upload: 0, download: 0 };
    this.previousAt = null;
    this.lastSavedAt = 0;
    this.dirty = false;
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (saved.day === this.day) {
        this.todayUpload = positive(saved.upload);
        this.todayDownload = positive(saved.download);
      }
    } catch {}
  }

  ensureDay(timestamp) {
    const current = dayKey(timestamp);
    if (current === this.day) return;
    this.day = current;
    this.todayUpload = 0;
    this.todayDownload = 0;
    this.dirty = true;
  }

  beginRun() {
    this.previousRaw = { upload: 0, download: 0 };
    this.previousAt = this.now();
    this.sessionUpload = 0;
    this.sessionDownload = 0;
    this.uploadSpeed = 0;
    this.downloadSpeed = 0;
    this.memory = 0;
    this.connections = [];
    this.history = [];
  }

  ingest(snapshot, timestamp = this.now()) {
    if (!Number.isFinite(snapshot?.uploadTotal) || !Number.isFinite(snapshot?.downloadTotal)) {
      throw new Error("代理内核返回了无效的流量统计");
    }
    this.ensureDay(timestamp);
    const upload = positive(snapshot.uploadTotal);
    const download = positive(snapshot.downloadTotal);
    const upDelta = upload >= this.previousRaw.upload ? upload - this.previousRaw.upload : upload;
    const downDelta = download >= this.previousRaw.download ? download - this.previousRaw.download : download;
    const seconds = this.previousAt === null ? 0 : (timestamp - this.previousAt) / 1000;
    this.uploadSpeed = seconds > 0 ? upDelta / seconds : 0;
    this.downloadSpeed = seconds > 0 ? downDelta / seconds : 0;
    this.todayUpload += upDelta;
    this.todayDownload += downDelta;
    this.sessionUpload += upDelta;
    this.sessionDownload += downDelta;
    this.previousRaw = { upload, download };
    this.previousAt = timestamp;
    this.memory = positive(snapshot.memory);
    this.connections = normalizeConnections(snapshot.connections);
    this.history.push({ at: timestamp, upload: this.uploadSpeed, download: this.downloadSpeed });
    if (this.history.length > 120) this.history.shift();
    if (upDelta || downDelta) this.dirty = true;
    if (this.dirty && timestamp - this.lastSavedAt >= 10000) this.save(timestamp);
    return this.current(true, timestamp);
  }

  current(active = false, timestamp = this.now()) {
    this.ensureDay(timestamp);
    return {
      active,
      uploadSpeed: active ? this.uploadSpeed : 0,
      downloadSpeed: active ? this.downloadSpeed : 0,
      todayUpload: this.todayUpload,
      todayDownload: this.todayDownload,
      sessionUpload: this.sessionUpload,
      sessionDownload: this.sessionDownload,
      memory: active ? this.memory : 0,
      activeConnections: active ? this.connections.length : 0,
      connections: active ? this.connections : [],
      history: this.history
    };
  }

  save(timestamp = this.now()) {
    this.ensureDay(timestamp);
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({
      day: this.day, upload: this.todayUpload, download: this.todayDownload
    }), "utf8");
    fs.renameSync(temporary, this.filePath);
    this.lastSavedAt = timestamp;
    this.dirty = false;
  }
}

module.exports = { ProxyTrafficTracker, normalizeConnections };
