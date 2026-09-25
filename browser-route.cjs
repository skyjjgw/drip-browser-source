const MODES = new Set(["default", "direct", "system", "node", "managed", "manual"]);

function normalizeManualProxy(value) {
  const protocol = value?.protocol;
  const host = String(value?.host || "").trim();
  const port = Number(value?.port);
  if (!["http", "socks5"].includes(protocol) || !host || host.length > 253 ||
      !/^[a-zA-Z0-9.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("请输入有效的 HTTP/SOCKS5 地址和端口");
  }
  return { protocol, host, port };
}

function normalizeBrowserRoute(value) {
  const mode = value?.mode;
  if (!MODES.has(mode)) throw new Error("不支持的浏览器线路");
  if (mode === "node" || mode === "managed") {
    const nodeId = String(value.nodeId || "").trim();
    if (!nodeId || nodeId.length > 200) throw new Error("请选择有效的订阅节点");
    return { mode, nodeId };
  }
  if (mode === "manual") return { mode, ...normalizeManualProxy(value) };
  return { mode };
}

function proxyRulesForManual(route) {
  const host = route.host.includes(":") ? `[${route.host.replace(/^\[|\]$/g, "")}]` : route.host;
  return `${route.protocol}://${host}:${route.port}`;
}

module.exports = { normalizeBrowserRoute, normalizeManualProxy, proxyRulesForManual };
