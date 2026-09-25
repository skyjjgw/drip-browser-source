const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const NODE_NAME = "日本代理";
const CLASH_DIRECTORY = "io.github.clash-verge-rev.clash-verge-rev";
const STORE_FILE = "proxy-node.json";

function validateNode(raw) {
  if (!raw || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80 ||
      raw.type !== "vless" || (raw.network || "tcp") !== "tcp" || raw.tls !== true) {
    throw new Error("节点不是受支持的 VLESS TCP Reality 配置");
  }
  const port = Number(raw.port);
  const server = String(raw.server || "");
  const uuid = String(raw.uuid || "");
  const reality = raw["reality-opts"];
  if (!server || server.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^[0-9a-fA-F-]{36}$/.test(uuid) || !raw.servername ||
      !reality || !reality["public-key"] || reality["short-id"] === undefined) {
    throw new Error("节点缺少必要的连接参数");
  }
  return {
    name: raw.name.trim(),
    type: "vless",
    network: "tcp",
    server,
    port,
    uuid,
    flow: String(raw.flow || ""),
    servername: String(raw.servername),
    clientFingerprint: String(raw["client-fingerprint"] || "chrome"),
    realityPublicKey: String(reality["public-key"]),
    realityShortId: String(reality["short-id"]),
    udp: raw.udp === true
  };
}

class ProxyNodeStore {
  constructor({ safeStorage, userDataPath, appDataPath }) {
    this.safeStorage = safeStorage;
    this.storePath = path.join(userDataPath, STORE_FILE);
    this.sourcePath = path.join(appDataPath, CLASH_DIRECTORY, "clash-verge.yaml");
  }

  status() {
    if (!fs.existsSync(this.storePath)) return { imported: false, active: false };
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { imported: false, active: false, error: "系统安全存储不可用" };
    }
    try {
      const envelope = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
      if (envelope.version !== 1 || typeof envelope.encryptedNode !== "string") throw new Error("Invalid node file");
      const node = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.encryptedNode, "base64")));
      if (node.name !== NODE_NAME || node.type !== "vless") throw new Error("Invalid node");
      return { imported: true, active: false, name: node.name, importedAt: envelope.importedAt };
    } catch {
      return { imported: false, active: false, error: "已导入的节点无法读取" };
    }
  }

  readNode() {
    if (!fs.existsSync(this.storePath)) return null;
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用");
    try {
      const envelope = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
      if (envelope.version !== 1 || typeof envelope.encryptedNode !== "string") throw new Error("Invalid node file");
      const node = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.encryptedNode, "base64")));
      if (node.name !== NODE_NAME || node.type !== "vless") throw new Error("Invalid node");
      return node;
    } catch {
      throw new Error("已导入的节点无法读取");
    }
  }

  importJapan() {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，未导入节点");
    if (!fs.existsSync(this.sourcePath)) throw new Error("未找到 Clash Verge 配置文件");
    const size = fs.statSync(this.sourcePath).size;
    if (size > 2 * 1024 * 1024) throw new Error("Clash 配置文件过大，未导入节点");
    const config = yaml.load(fs.readFileSync(this.sourcePath, "utf8"), { schema: yaml.JSON_SCHEMA });
    const matches = config?.proxies?.filter(item => item?.name === NODE_NAME) || [];
    if (matches.length !== 1) throw new Error("Clash 配置中没有唯一的日本代理节点");
    const node = validateNode(matches[0]);
    const envelope = {
      version: 1,
      importedAt: new Date().toISOString(),
      encryptedNode: this.safeStorage.encryptString(JSON.stringify(node)).toString("base64")
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
    return { imported: true, active: false, name: node.name, importedAt: envelope.importedAt };
  }
}

module.exports = { ProxyNodeStore, validateNode };
