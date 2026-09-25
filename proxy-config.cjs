const MODES = new Set(["rule", "global", "direct"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function localNodeToClash(node) {
  if (!node || typeof node !== "object") throw new Error("节点参数不完整");
  if (node.realityPublicKey) {
    if (node.type !== "vless" || !node.server || !node.uuid || !node.servername) {
      throw new Error("节点参数不完整");
    }
    return {
      name: node.name || "Drip 节点",
      type: "vless",
      server: node.server,
      port: node.port,
      uuid: node.uuid,
      network: "tcp",
      tls: true,
      flow: node.flow || "",
      servername: node.servername,
      "client-fingerprint": node.clientFingerprint || "chrome",
      "reality-opts": {
        "public-key": node.realityPublicKey,
        "short-id": node.realityShortId || ""
      },
      udp: node.udp !== false
    };
  }
  if (node.type && node.server && node.port) return clone(node);
  throw new Error("节点参数不完整");
}

function ensureSelectionGroup(config, selectedName) {
  const groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  config["proxy-groups"] = groups;
  const alreadyGrouped = groups.some(group => Array.isArray(group?.proxies) && group.proxies.includes(selectedName));
  if (alreadyGrouped) return;
  const groupName = "DRIP";
  if (!groups.some(group => group?.name === groupName)) {
    groups.unshift({ name: groupName, type: "select", proxies: [selectedName, "DIRECT"] });
  }
  const rules = Array.isArray(config.rules) ? config.rules.filter(rule => !String(rule).startsWith("MATCH,")) : [];
  config.rules = [`MATCH,${groupName}`, ...rules];
}

function buildProxyConfig(entry, { mixedPort, apiPort, apiSecret, mode = "rule", tun = false }) {
  if (!MODES.has(mode)) throw new Error("不支持的代理模式");
  for (const port of [mixedPort, apiPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("本地端口无效");
  }
  if (typeof apiSecret !== "string" || apiSecret.length < 24) throw new Error("控制接口密钥无效");

  const profile = entry?.profile && typeof entry.profile === "object" ? clone(entry.profile) : null;
  const node = localNodeToClash(entry?.node || entry);
  const config = profile && Array.isArray(profile.proxies) ? profile : { proxies: [node] };
  config.proxies = Array.isArray(config.proxies) ? config.proxies : [node];
  if (!config.proxies.some(candidate => candidate?.name === node.name)) config.proxies.push(node);
  ensureSelectionGroup(config, node.name);

  config["mixed-port"] = mixedPort;
  config["allow-lan"] = false;
  config["bind-address"] = "127.0.0.1";
  config["external-controller"] = `127.0.0.1:${apiPort}`;
  config.secret = apiSecret;
  config.mode = mode;
  config.ipv6 = false;
  config["log-level"] = "info";
  config.tun = tun
    ? {
        ...(config.tun && typeof config.tun === "object" ? config.tun : {}),
        enable: true,
        stack: config.tun?.stack || "mixed",
        "auto-route": true,
        "auto-detect-interface": true,
        "strict-route": true,
        "dns-hijack": ["any:53", "tcp://any:53"]
      }
    : { ...(config.tun && typeof config.tun === "object" ? config.tun : {}), enable: false };

  return config;
}

module.exports = { buildProxyConfig, localNodeToClash };
