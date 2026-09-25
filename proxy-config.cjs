const MODES = new Set(["rule", "global", "direct"]);

function buildProxyConfig(node, { mixedPort, apiPort, apiSecret, mode = "rule", tun = false }) {
  if (!node || node.type !== "vless" || node.network !== "tcp" || !node.server ||
      !Number.isInteger(node.port) || !node.uuid || !node.servername || !node.realityPublicKey) {
    throw new Error("节点参数不完整");
  }
  if (!MODES.has(mode)) throw new Error("不支持的代理模式");
  for (const port of [mixedPort, apiPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("本地端口无效");
  }
  if (typeof apiSecret !== "string" || apiSecret.length < 24) throw new Error("控制接口密钥无效");

  const rules = [];
  if (tun) {
    rules.push({ inbound: ["drip-tun"], port: 53, action: "hijack-dns" });
  }
  if (mode === "rule") {
    rules.push(
      { ip_is_private: true, outbound: "direct" },
      { domain_suffix: [".cn", ".baidu.com", ".qq.com", ".taobao.com", ".bilibili.com"], outbound: "direct" }
    );
  }
  const config = {
    log: { level: "info", timestamp: true },
    dns: {
      servers: [
        { tag: "dns-direct", type: "udp", server: "223.5.5.5" },
        { tag: "dns-proxy", type: "udp", server: "1.1.1.1", detour: "proxy" }
      ],
      final: mode === "direct" ? "dns-direct" : "dns-proxy"
    },
    inbounds: [{ type: "mixed", tag: "drip-mixed", listen: "127.0.0.1", listen_port: mixedPort }],
    outbounds: [
      {
        type: "vless", tag: "proxy", server: node.server, server_port: node.port,
        uuid: node.uuid, flow: node.flow || "",
        tls: {
          enabled: true, server_name: node.servername,
          utls: { enabled: true, fingerprint: node.clientFingerprint || "chrome" },
          reality: { enabled: true, public_key: node.realityPublicKey, short_id: node.realityShortId || "" }
        }
      },
      { type: "direct", tag: "direct" }
    ],
    route: {
      rules,
      final: mode === "direct" ? "direct" : "proxy",
      default_domain_resolver: "dns-direct",
      auto_detect_interface: Boolean(tun)
    },
    experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}`, secret: apiSecret } }
  };
  if (tun) {
    config.inbounds.push({
      type: "tun", tag: "drip-tun", interface_name: "DripTun",
      address: ["172.19.73.1/30"], auto_route: true, strict_route: true
    });
  }
  return config;
}

module.exports = { buildProxyConfig };
