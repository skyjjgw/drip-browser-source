const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { ProxySubscriptionStore, parseSubscription, normalizeUrl } = require("../proxy-subscription-store.cjs");

const node = {
  name: "Japan", type: "vless", network: "tcp", tls: true,
  server: "jp.example.test", port: 443, uuid: "123e4567-e89b-12d3-a456-426614174000",
  flow: "xtls-rprx-vision", servername: "front.example.test",
  "reality-opts": { "public-key": "example-public-key", "short-id": "1234abcd" }
};

function fixture(t, fetcher) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drip-sub-test-"));
  t.after(() => {
    if (!path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Unsafe cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
    decryptString: value => Buffer.from(String(value).slice(7), "base64").toString()
  };
  const store = new ProxySubscriptionStore({ safeStorage: storage, userDataPath: root, fetcher });
  return { store, root, storage };
}

test("parses Clash YAML and Base64 VLESS lists without activating nodes", () => {
  const result = parseSubscription(yaml.dump({ proxies: [node, { ...node, name: "unsupported", type: "trojan" }] }));
  assert.equal(result.nodes.length, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.nodes[0].name, "Japan");
  assert.equal(result.nodes[1].type, "trojan");
  assert.equal(result.profile.proxies.length, 2);
  const uri = "vless://123e4567-e89b-12d3-a456-426614174000@jp.example.test:443?type=tcp&security=reality&sni=front.example.test&pbk=example-public-key&sid=1234abcd#Japan";
  assert.equal(parseSubscription(Buffer.from(uri).toString("base64")).nodes[0].name, "Japan");
  assert.throws(() => normalizeUrl("file:///secret"), /HTTP/);
});

test("adds, refreshes and removes an encrypted subscription", async t => {
  let downloadCount = 0;
  const body = yaml.dump({ proxies: [node] });
  const { store, root } = fixture(t, async (url, options) => {
    assert.equal(url, "https://sub.example.test/key?token=secret");
    assert.equal(options.method, "GET");
    downloadCount += 1;
    const response = new Response(body, { status: 200 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  });
  const added = await store.add("https://sub.example.test/key?token=secret", "我的订阅");
  assert.equal(added.length, 1);
  assert.equal(added[0].nodeCount, 1);
  assert.deepEqual(added[0].nodeNames, ["Japan"]);
  assert.equal(added[0].name, "我的订阅");
  assert.equal(added[0].url, undefined);
  const saved = fs.readFileSync(path.join(root, "proxy-subscriptions.json"), "utf8");
  assert.equal(saved.includes("token=secret"), false);
  assert.equal(saved.includes(node.server), false);
  assert.equal((await store.refresh(added[0].id)).length, 1);
  assert.equal(downloadCount, 2);
  assert.deepEqual(await store.remove(added[0].id), []);
});

test("accepts Electron net.fetch responses without a response URL", async t => {
  const body = yaml.dump({ proxies: [node] });
  const { store } = fixture(t, async () => new Response(body, { status: 200 }));
  const result = await store.add("https://example.invalid/clash/example", "Electron 订阅");
  assert.equal(result[0].nodeCount, 1);
});

test("invalid downloads leave saved subscriptions untouched", async t => {
  let fail = false;
  const { store, root } = fixture(t, async url => {
    if (fail) throw new Error(`secret URL: ${url}`);
    const response = new Response(yaml.dump({ proxies: [node] }), { status: 200 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  });
  const [item] = await store.add("http://sub.example.test/key?token=private", "Example");
  const before = fs.readFileSync(path.join(root, "proxy-subscriptions.json"), "utf8");
  fail = true;
  await assert.rejects(store.refresh(item.id), /订阅下载失败/);
  assert.equal(fs.readFileSync(path.join(root, "proxy-subscriptions.json"), "utf8"), before);
  assert.equal(store.status()[0].insecure, true);
});
