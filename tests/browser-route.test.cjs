const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeBrowserRoute, proxyRulesForManual } = require("../browser-route.cjs");

test("browser routes keep the default route explicit", () => {
  for (const mode of ["default", "direct", "system"]) {
    assert.deepEqual(normalizeBrowserRoute({ mode, ignored: true }), { mode });
  }
  assert.deepEqual(normalizeBrowserRoute({ mode: "node", nodeId: "subscription:one:0" }),
    { mode: "node", nodeId: "subscription:one:0" });
  assert.deepEqual(normalizeBrowserRoute({ mode: "managed", nodeId: "managed:jp" }),
    { mode: "managed", nodeId: "managed:jp" });
});

test("manual browser proxies validate protocol, host and port", () => {
  const route = normalizeBrowserRoute({ mode: "manual", protocol: "socks5", host: "example.test", port: 1080 });
  assert.equal(proxyRulesForManual(route), "socks5://example.test:1080");
  assert.equal(proxyRulesForManual(normalizeBrowserRoute({ mode: "manual", protocol: "http", host: "::1", port: 8080 })),
    "http://[::1]:8080");
  for (const value of [
    { mode: "manual", protocol: "file", host: "example.test", port: 8080 },
    { mode: "manual", protocol: "http", host: "example.test/evil", port: 8080 },
    { mode: "manual", protocol: "http", host: "example.test", port: 0 },
    { mode: "node", nodeId: "" },
    { mode: "managed", nodeId: "" }
  ]) assert.throws(() => normalizeBrowserRoute(value));
});
