const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeElevationIntent, consumeElevationIntent } = require("../proxy-elevation.cjs");

test("elevation handoff is single use and contains no node credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drip-elevation-test-"));
  const filePath = path.join(directory, "intent.json");
  try {
    const now = Date.now();
    const nonce = writeElevationIntent(filePath, { nodeId: "local", groupName: "PROXY", mode: "global", systemProxy: true }, now);
    const disk = fs.readFileSync(filePath, "utf8");
    assert.equal(disk.includes("uuid"), false);
    assert.equal(consumeElevationIntent(filePath, "0".repeat(48), now + 1000), null);
    assert.ok(fs.existsSync(filePath));
    assert.deepEqual(consumeElevationIntent(filePath, nonce, now + 1000), {
      nodeId: "local", groupName: "PROXY", mode: "global", systemProxy: true, tun: true
    });
    assert.equal(consumeElevationIntent(filePath, nonce, now + 1000), null);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmdirSync(directory);
  }
});

test("expired handoff cannot auto-start TUN", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drip-elevation-test-"));
  const filePath = path.join(directory, "intent.json");
  try {
    const nonce = writeElevationIntent(filePath, { nodeId: "local", tun: true }, 1000);
    assert.equal(consumeElevationIntent(filePath, nonce, 121001), null);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmdirSync(directory);
  }
});
