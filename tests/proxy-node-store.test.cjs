const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { ProxyNodeStore } = require("../proxy-node-store.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drip-node-test-"));
  t.after(() => {
    if (!path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Unsafe cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const appDataPath = path.join(root, "roaming");
  const userDataPath = path.join(root, "drip");
  const configPath = path.join(appDataPath, "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const node = {
    name: "日本代理", type: "vless", network: "tcp", tls: true,
    server: "jp.example.test", port: 443, uuid: "123e4567-e89b-12d3-a456-426614174000",
    flow: "xtls-rprx-vision", servername: "front.example.test", "client-fingerprint": "chrome",
    "reality-opts": { "public-key": "example-public-key", "short-id": "1234abcd" }
  };
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
    decryptString: value => Buffer.from(String(value).slice(7), "base64").toString()
  };
  const store = new ProxyNodeStore({ safeStorage: storage, userDataPath, appDataPath });
  return { node, configPath, store, userDataPath, storage };
}

test("imports only the Japan node as encrypted, inactive data", t => {
  const { node, configPath, store, userDataPath } = fixture(t);
  const source = yaml.dump({ proxies: [
    { ...node, name: "other", server: "other.example.test" }, node
  ] });
  fs.writeFileSync(configPath, source);
  assert.deepEqual(store.status(), { imported: false, active: false });
  const imported = store.importJapan();
  assert.equal(imported.imported, true);
  assert.equal(imported.active, false);
  assert.equal(imported.name, "日本代理");
  assert.equal(store.status().imported, true);
  const saved = fs.readFileSync(path.join(userDataPath, "proxy-node.json"), "utf8");
  assert.equal(saved.includes(node.server), false);
  assert.equal(saved.includes(node.uuid), false);
  assert.equal(fs.readFileSync(configPath, "utf8"), source);
});

test("refuses unsupported nodes and unavailable encryption", t => {
  const { node, configPath, store, storage, userDataPath } = fixture(t);
  fs.writeFileSync(configPath, yaml.dump({ proxies: [{ ...node, tls: false }] }));
  assert.throws(() => store.importJapan(), /受支持/);
  assert.equal(fs.existsSync(path.join(userDataPath, "proxy-node.json")), false);
  storage.isEncryptionAvailable = () => false;
  assert.throws(() => store.importJapan(), /安全存储不可用/);
});
