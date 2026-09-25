"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function writeElevationIntent(filePath, options, now = Date.now()) {
  const nonce = crypto.randomBytes(24).toString("hex");
  const intent = {
    nonce,
    createdAt: now,
    options: {
      nodeId: String(options.nodeId || "").slice(0, 120),
      mode: ["rule", "global", "direct"].includes(options.mode) ? options.mode : "rule",
      systemProxy: options.systemProxy !== false,
      tun: true
    }
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(intent), { encoding: "utf8", mode: 0o600 });
  return nonce;
}

function consumeElevationIntent(filePath, nonce, now = Date.now()) {
  if (!/^[0-9a-f]{48}$/.test(nonce || "")) return null;
  let intent;
  try { intent = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
  if (intent?.nonce !== nonce || !Number.isFinite(intent.createdAt) ||
      now < intent.createdAt || now - intent.createdAt > 2 * 60 * 1000) return null;
  fs.rmSync(filePath, { force: true });
  const options = intent.options;
  if (typeof options?.nodeId !== "string" || options.nodeId.length > 120 ||
      !["rule", "global", "direct"].includes(options.mode) || options.tun !== true) return null;
  return {
    nodeId: options.nodeId,
    mode: options.mode,
    systemProxy: options.systemProxy !== false,
    tun: true
  };
}

module.exports = { writeElevationIntent, consumeElevationIntent };
