const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const yaml = require("js-yaml");
const { buildProxyConfig } = require("../proxy-config.cjs");

const node = {
  name: "Japan",
  type: "vless",
  network: "tcp",
  server: "jp.example.test",
  port: 443,
  uuid: "123e4567-e89b-12d3-a456-426614174000",
  flow: "xtls-rprx-vision",
  tls: true,
  servername: "front.example.test",
  "client-fingerprint": "chrome",
  "reality-opts": { "public-key": Buffer.alloc(32).toString("base64url"), "short-id": "1234abcd" }
};

function build(options = {}) {
  return buildProxyConfig({ node, profile: options.profile }, {
    mixedPort: options.mixedPort || 24561,
    apiPort: options.apiPort || 24562,
    apiSecret: options.apiSecret || "a".repeat(32),
    mode: options.mode || "rule",
    tun: options.tun === true
  });
}

test("builds a Clash-compatible config and keeps a selectable node", () => {
  const config = build();
  assert.equal(config["mixed-port"], 24561);
  assert.equal(config["external-controller"], "127.0.0.1:24562");
  assert.equal(config.mode, "rule");
  assert.equal(config.proxies[0].type, "vless");
  assert.equal(config["proxy-groups"][0].name, "DRIP");
  assert.deepEqual(config.rules[0], "MATCH,DRIP");
});

test("converts the legacy Drip VLESS shape to Mihomo Reality options", () => {
  const legacyNode = {
    name: "Legacy Japan",
    type: "vless",
    server: "jp.example.test",
    port: 443,
    uuid: node.uuid,
    servername: "front.example.test",
    realityPublicKey: Buffer.alloc(32).toString("base64url"),
    realityShortId: "1234abcd",
    clientFingerprint: "chrome"
  };
  const config = buildProxyConfig({ node: legacyNode }, {
    mixedPort: 24561,
    apiPort: 24562,
    apiSecret: "a".repeat(32)
  });
  assert.equal(config.proxies[0]["reality-opts"]["public-key"], legacyNode.realityPublicKey);
  assert.equal(config.proxies[0]["client-fingerprint"], "chrome");
  assert.equal("realityPublicKey" in config.proxies[0], false);
});

test("preserves a downloaded Clash profile and its multi-protocol nodes", () => {
  const profile = {
    proxies: [node, { name: "Trojan", type: "trojan", server: "t.example.test", port: 443, password: "secret" }],
    "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["Japan", "Trojan", "DIRECT"] }],
    rules: ["DOMAIN-SUFFIX,example.com,PROXY", "MATCH,DIRECT"]
  };
  const config = build({ profile });
  assert.equal(config.proxies.length, 2);
  assert.equal(config["proxy-groups"][0].name, "PROXY");
  assert.deepEqual(config.rules, profile.rules);
  assert.equal(config["mixed-port"], 24561);
});

test("builds a system TUN configuration", () => {
  const config = build({ mode: "global", tun: true });
  assert.equal(config.mode, "global");
  assert.equal(config.tun.enable, true);
  assert.equal(config.tun["auto-route"], true);
  assert.equal(config.tun["strict-route"], true);
});

test("rejects unsupported modes and incomplete nodes", () => {
  assert.throws(() => buildProxyConfig({ node }, { mixedPort: 1, apiPort: 2, apiSecret: "x".repeat(32), mode: "bad" }), /代理模式/);
  assert.throws(() => buildProxyConfig({ node: { ...node, server: "" } }, { mixedPort: 1, apiPort: 2, apiSecret: "x".repeat(32) }), /节点参数/);
});

test("Mihomo validates the generated YAML without activating TUN", {
  skip: process.platform !== "win32" || !fs.existsSync(path.join(__dirname, "..", "runtime", "mihomo.exe"))
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drip-mihomo-check-"));
  const configPath = path.join(directory, "config.yaml");
  try {
    const config = build({ mixedPort: 24563, apiPort: 24564, tun: true });
    fs.writeFileSync(configPath, yaml.dump(config, { noRefs: true, lineWidth: -1 }));
    const result = spawnSync(path.join(__dirname, "..", "runtime", "mihomo.exe"), ["-t", "-d", directory, "-f", configPath], {
      cwd: directory, windowsHide: true, encoding: "utf8", timeout: 10000
    });
    assert.equal(result.status, 0, `${result.error?.message || ""}\n${result.stdout || ""}\n${result.stderr || ""}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Mihomo starts a local mixed listener and API", {
  skip: process.platform !== "win32" || !fs.existsSync(path.join(__dirname, "..", "runtime", "mihomo.exe"))
}, async () => {
  const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
  const canConnect = port => new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = success => { socket.destroy(); resolve(success); };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
  const mixedPort = await freePort();
  const apiPort = await freePort();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drip-mihomo-run-"));
  const configPath = path.join(directory, "config.yaml");
  const secret = "test-".repeat(8);
  fs.writeFileSync(configPath, yaml.dump(build({ mixedPort, apiPort, apiSecret: secret }), { noRefs: true, lineWidth: -1 }));
  const executable = path.join(__dirname, "..", "runtime", "mihomo.exe");
  const child = spawn(executable, ["-d", directory, "-f", configPath], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 10000;
    let started = false;
    while (Date.now() < deadline && child.exitCode === null) {
      if (await canConnect(mixedPort) && await canConnect(apiPort)) { started = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(started, true, `Mihomo did not start: ${output.slice(-1500)}`);
    const apiResponse = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port: apiPort, path: "/proxies", agent: false,
        headers: { Authorization: `Bearer ${secret}` } }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch (error) { reject(error); }
        });
      });
      request.once("error", reject);
    });
    assert.equal(apiResponse.status, 200);
    assert.ok(apiResponse.body.proxies?.DRIP?.all?.includes("Japan"));
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
