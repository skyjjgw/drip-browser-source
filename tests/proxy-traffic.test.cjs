const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProxyTrafficTracker, normalizeConnections } = require("../proxy-traffic.cjs");

test("tracks core deltas, rates, active connections, and today's persisted total", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drip-traffic-test-"));
  const filePath = path.join(directory, "traffic.json");
  let now = new Date(2026, 8, 25, 12, 0, 0).getTime();
  try {
    const tracker = new ProxyTrafficTracker(filePath, () => now);
    tracker.beginRun();
    now += 1000;
    const first = tracker.ingest({ uploadTotal: 1024, downloadTotal: 2048, memory: 4096, connections: [{
      id: "one", metadata: { host: "example.test", processPath: "C:\\Browser\\drip.exe", destinationPort: "443" },
      rule: "final", chains: ["proxy"], upload: 1024, download: 2048
    }] });
    assert.equal(first.uploadSpeed, 1024);
    assert.equal(first.downloadSpeed, 2048);
    assert.equal(first.activeConnections, 1);
    assert.equal(first.connections[0].process, "drip.exe");
    assert.equal(first.memory, 4096);
    now += 2000;
    const second = tracker.ingest({ uploadTotal: 2048, downloadTotal: 6144, memory: 4000, connections: [] });
    assert.equal(second.uploadSpeed, 512);
    assert.equal(second.downloadSpeed, 2048);
    assert.equal(second.todayUpload, 2048);
    assert.equal(second.todayDownload, 6144);
    tracker.save();
    const restarted = new ProxyTrafficTracker(filePath, () => now);
    assert.equal(restarted.current().todayDownload, 6144);
    restarted.beginRun();
    now += 1000;
    assert.equal(restarted.ingest({ uploadTotal: 100, downloadTotal: 200, connections: [] }).todayDownload, 6344);
    assert.equal(restarted.current(false).downloadSpeed, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("counter reset and local midnight do not produce negative or previous-day usage", () => {
  let now = new Date(2026, 8, 25, 23, 59, 59).getTime();
  const tracker = new ProxyTrafficTracker(path.join(os.tmpdir(), `drip-traffic-no-save-${process.pid}.json`), () => now);
  tracker.beginRun();
  tracker.lastSavedAt = now;
  tracker.ingest({ uploadTotal: 100, downloadTotal: 500, connections: [] });
  now = new Date(2026, 8, 26, 0, 0, 1).getTime();
  const result = tracker.ingest({ uploadTotal: 20, downloadTotal: 30, connections: [] });
  assert.equal(result.todayUpload, 20);
  assert.equal(result.todayDownload, 30);
  assert.equal(result.downloadSpeed, 15);
});

test("connection fields are bounded and malformed input is ignored", () => {
  assert.deepEqual(normalizeConnections(null), []);
  const result = normalizeConnections([{ metadata: { host: "<script>alert(1)</script>" }, upload: -1, chains: null }]);
  assert.equal(result[0].target, "<script>alert(1)</script>");
  assert.equal(result[0].upload, 0);
  assert.equal(result[0].chain, "--");
});
