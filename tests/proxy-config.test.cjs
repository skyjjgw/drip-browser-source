const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { buildProxyConfig } = require("../proxy-config.cjs");

const node = {
  name: "Japan",
  type: "vless",
  network: "tcp",
  server: "jp.example.test",
  port: 443,
  uuid: "123e4567-e89b-12d3-a456-426614174000",
  flow: "xtls-rprx-vision",
  servername: "front.example.test",
  clientFingerprint: "chrome",
  realityPublicKey: "example-public-key",
  realityShortId: "1234abcd"
};

test("builds a rule-mode mixed proxy without activating it", () => {
  const config = buildProxyConfig(node, { mixedPort: 24561, apiPort: 24562, apiSecret: "a".repeat(32) });
  assert.equal(config.inbounds.length, 1);
  assert.equal(config.inbounds[0].type, "mixed");
  assert.equal(config.route.final, "proxy");
  assert.equal(config.dns.servers[0].detour, undefined);
  assert.equal(config.experimental.clash_api.external_controller, "127.0.0.1:24562");
});

test("builds a system TUN configuration for global mode", () => {
  const config = buildProxyConfig(node, { mixedPort: 24563, apiPort: 24564, apiSecret: "b".repeat(32), mode: "global", tun: true });
  assert.equal(config.inbounds[1].type, "tun");
  assert.equal(config.inbounds[1].auto_route, true);
  assert.equal(config.route.final, "proxy");
  assert.deepEqual(config.route.rules, [{ inbound: ["drip-tun"], port: 53, action: "hijack-dns" }]);
});

test("TUN DNS interception precedes private-address routing in rule mode", () => {
  const config = buildProxyConfig(node, { mixedPort: 24563, apiPort: 24564, apiSecret: "b".repeat(32), mode: "rule", tun: true });
  assert.deepEqual(config.route.rules[0], { inbound: ["drip-tun"], port: 53, action: "hijack-dns" });
  assert.equal(config.route.rules[1].ip_is_private, true);
});

test("rejects unsupported modes and incomplete nodes", () => {
  assert.throws(() => buildProxyConfig(node, { mixedPort: 1, apiPort: 2, apiSecret: "x".repeat(32), mode: "bad" }), /代理模式/);
  assert.throws(() => buildProxyConfig({ ...node, realityPublicKey: "" }, { mixedPort: 1, apiPort: 2, apiSecret: "x".repeat(32) }), /节点参数/);
});

test("bundled core accepts TUN configuration without activating the adapter", {
  skip: process.platform !== "win32" || !fs.existsSync(path.join(__dirname, "..", "runtime", "sing-box.exe"))
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drip-tun-check-"));
  const configPath = path.join(directory, "config.json");
  try {
    const publicKey = crypto.generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
    fs.writeFileSync(configPath, JSON.stringify(buildProxyConfig({ ...node, realityPublicKey: publicKey }, {
      mixedPort: 24563, apiPort: 24564, apiSecret: "b".repeat(32), mode: "global", tun: true
    })));
    const result = spawnSync(path.join(__dirname, "..", "runtime", "sing-box.exe"), ["check", "-c", configPath], {
      cwd: directory, windowsHide: true, encoding: "utf8", timeout: 8000
    });
    assert.equal(result.status, 0, `${result.error?.message || ""}\n${result.stderr || ""}`);
  } finally {
    fs.rmSync(configPath, { force: true });
    fs.rmdirSync(directory);
  }
});

test("bundled core starts a local mixed listener without changing system networking", {
  skip: process.platform !== "win32" || !fs.existsSync(path.join(__dirname, "..", "runtime", "sing-box.exe"))
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
    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
  const mixedPort = await freePort();
  const apiPort = await freePort();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drip-proxy-test-"));
  const configPath = path.join(directory, "config.json");
  const executable = path.join(__dirname, "..", "runtime", "sing-box.exe");
  const publicKey = crypto.generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
  fs.writeFileSync(configPath, JSON.stringify(buildProxyConfig({ ...node, realityPublicKey: publicKey }, {
    mixedPort, apiPort, apiSecret: "test-".repeat(8), tun: false
  })));
  const child = spawn(executable, ["run", "-c", configPath], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 8000;
    let started = false;
    while (Date.now() < deadline && child.exitCode === null) {
      if (await canConnect(mixedPort) && await canConnect(apiPort)) {
        started = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(started, true, `Core did not start: ${output.slice(-1000)}`);
    const snapshot = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port: apiPort, path: "/connections", agent: false,
        headers: { Authorization: `Bearer ${"test-".repeat(8)}` } }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
      });
      request.once("error", reject);
    });
    assert.equal(snapshot.status, 200);
    assert.equal(typeof snapshot.body.uploadTotal, "number");
    assert.equal(typeof snapshot.body.downloadTotal, "number");
    assert.ok(Array.isArray(snapshot.body.connections));
    const origin = http.createServer((_request, response) => response.end("local traffic check"));
    try {
      await new Promise(resolve => origin.listen(0, "127.0.0.1", resolve));
      const originPort = origin.address().port;
      const localResponse = await new Promise((resolve, reject) => {
        const request = http.get({ hostname: "127.0.0.1", port: mixedPort,
          path: `http://127.0.0.1:${originPort}/`, headers: { Host: `127.0.0.1:${originPort}` } }, response => {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk));
          response.on("end", () => resolve(Buffer.concat(chunks).toString()));
        });
        request.once("error", reject);
      });
      assert.equal(localResponse, "local traffic check");
      const after = await new Promise((resolve, reject) => {
        const request = http.get({ hostname: "127.0.0.1", port: apiPort, path: "/connections", agent: false,
          headers: { Authorization: `Bearer ${"test-".repeat(8)}` } }, response => {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk));
          response.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch (error) { reject(error); }
          });
        });
        request.once("error", reject);
      });
      assert.ok(after.downloadTotal > snapshot.body.downloadTotal);
      assert.ok(after.uploadTotal > snapshot.body.uploadTotal);
    } finally {
      origin.close();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
