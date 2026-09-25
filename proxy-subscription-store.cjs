const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { validateNode } = require("./proxy-node-store.cjs");

const MAX_SUBSCRIPTIONS = 10;
const MAX_NODES = 200;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function parseVlessUri(line) {
  const uri = new URL(line.trim());
  if (uri.protocol !== "vless:") throw new Error("Unsupported URI");
  const query = uri.searchParams;
  return {
    name: decodeURIComponent(uri.hash.slice(1)) || uri.hostname,
    type: "vless",
    network: query.get("type") || "tcp",
    tls: query.get("security") === "reality",
    server: uri.hostname,
    port: Number(uri.port),
    uuid: decodeURIComponent(uri.username),
    flow: query.get("flow") || "",
    servername: query.get("sni") || query.get("serverName") || "",
    "client-fingerprint": query.get("fp") || "chrome",
    "reality-opts": { "public-key": query.get("pbk"), "short-id": query.get("sid") || "" },
    udp: true
  };
}

function parseSubscription(text) {
  let candidates = [];
  try {
    const document = yaml.load(text, { schema: yaml.JSON_SCHEMA });
    if (Array.isArray(document?.proxies)) candidates = document.proxies;
  } catch {}
  if (!candidates.length) {
    let input = text.trim();
    if (!input.includes("vless://") && /^[A-Za-z0-9+/=\s]+$/.test(input)) {
      const decoded = Buffer.from(input.replace(/\s/g, ""), "base64").toString("utf8");
      if (decoded.includes("vless://")) input = decoded;
    }
    candidates = input.split(/\r?\n/).filter(line => line.trim().startsWith("vless://"));
    candidates = candidates.map(line => {
      try { return parseVlessUri(line); } catch { return null; }
    });
  }
  const nodes = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (nodes.length >= MAX_NODES) { skipped += 1; continue; }
    try { nodes.push(validateNode(candidate)); } catch { skipped += 1; }
  }
  if (!nodes.length) throw new Error("订阅中没有可导入的 VLESS TCP Reality 节点");
  return { nodes, skipped };
}

function normalizeUrl(input) {
  if (typeof input !== "string" || input.length > 2048) throw new Error("订阅地址无效");
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error("订阅地址无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("订阅地址须以 HTTP 或 HTTPS 开头");
  url.hash = "";
  return url.toString();
}

async function readLimitedResponse(response) {
  if (!response.ok) throw new Error(`订阅服务器返回 ${response.status}`);
  const advertisedSize = Number(response.headers.get("content-length"));
  if (advertisedSize > MAX_RESPONSE_BYTES) throw new Error("订阅文件超过 2 MB");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("订阅服务器没有返回内容");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("订阅文件超过 2 MB");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

class ProxySubscriptionStore {
  constructor({ safeStorage, userDataPath, fetcher }) {
    this.safeStorage = safeStorage;
    this.storePath = path.join(userDataPath, "proxy-subscriptions.json");
    this.fetcher = fetcher;
    this.busy = false;
  }

  read() {
    if (!fs.existsSync(this.storePath)) return [];
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用");
    try {
      const envelope = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
      if (envelope.version !== 1 || typeof envelope.encryptedData !== "string") throw new Error("Invalid file");
      const data = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.encryptedData, "base64")));
      if (!Array.isArray(data)) throw new Error("Invalid subscriptions");
      return data;
    } catch {
      throw new Error("已保存的订阅无法读取");
    }
  }

  write(data) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，未保存订阅");
    const envelope = {
      version: 1,
      encryptedData: this.safeStorage.encryptString(JSON.stringify(data)).toString("base64")
    };
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.storePath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  status() {
    return this.read().map(item => ({
      id: item.id,
      name: item.name,
      host: new URL(item.url).host,
      nodeCount: item.nodes.length,
      nodeNames: item.nodes.map(node => node.name),
      skipped: item.skipped,
      updatedAt: item.updatedAt,
      insecure: item.url.startsWith("http:")
    }));
  }

  listNodes() {
    return this.read().flatMap(item => item.nodes.map((node, index) => ({
      id: `subscription:${item.id}:${index}`,
      name: node.name,
      source: item.name,
      node
    })));
  }

  async download(url) {
    let response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(20000),
        headers: { Accept: "application/yaml, text/yaml, text/plain, */*" }
      });
    } catch {
      throw new Error("订阅下载失败，请检查地址和浏览器网络连接");
    }
    if (!response.url || !["http:", "https:"].includes(new URL(response.url).protocol)) {
      throw new Error("订阅跳转到不受支持的地址");
    }
    const body = await readLimitedResponse(response);
    return parseSubscription(body);
  }

  async runExclusive(operation) {
    if (this.busy) throw new Error("另一个订阅操作正在进行");
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  async add(inputUrl, inputName) {
    return this.runExclusive(async () => {
      const url = normalizeUrl(inputUrl);
      const current = this.read();
      const existing = current.find(item => item.url === url);
      if (!existing && current.length >= MAX_SUBSCRIPTIONS) throw new Error("最多添加 10 个订阅");
      const name = String(inputName || "").trim().slice(0, 40) || new URL(url).hostname;
      const { nodes, skipped } = await this.download(url);
      const item = { id: existing?.id || crypto.randomUUID(), name, url, nodes, skipped, updatedAt: new Date().toISOString() };
      if (existing) current.splice(current.indexOf(existing), 1, item);
      else current.push(item);
      this.write(current);
      return this.status();
    });
  }

  async refresh(id) {
    return this.runExclusive(async () => {
      const current = this.read();
      const item = current.find(entry => entry.id === id);
      if (!item) throw new Error("订阅不存在");
      const { nodes, skipped } = await this.download(item.url);
      item.nodes = nodes;
      item.skipped = skipped;
      item.updatedAt = new Date().toISOString();
      this.write(current);
      return this.status();
    });
  }

  async remove(id) {
    return this.runExclusive(async () => {
      const current = this.read();
      const next = current.filter(item => item.id !== id);
      if (next.length === current.length) throw new Error("订阅不存在");
      this.write(next);
      return this.status();
    });
  }
}

module.exports = { ProxySubscriptionStore, parseSubscription, normalizeUrl };
