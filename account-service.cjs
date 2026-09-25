const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { safeStorage } = require("electron");

const DEFAULT_API_BASE = process.env.DRIP_ACCOUNT_API_BASE || "https://example.invalid/api/account";
const REQUEST_TIMEOUT_MS = 15000;

class AccountService {
  constructor({ session, userDataPath, onChange, apiBase = DEFAULT_API_BASE }) {
    this.session = session;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.sessionPath = path.join(userDataPath, "account-session.json");
    this.token = "";
    this.refreshToken = "";
    this.authEpoch = 0;
    this.deviceId = crypto.randomUUID();
    this.state = {
      status: "signed-out",
      busy: false,
      user: null,
      error: null,
      entitlement: null,
      managedNodes: []
    };
    this.loadCredentials();
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  emit(next) {
    this.state = { ...this.state, ...next };
    this.onChange(this.snapshot());
    return this.snapshot();
  }

  loadCredentials() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      const stored = JSON.parse(fs.readFileSync(this.sessionPath, "utf8"));
      if (typeof stored.deviceId === "string" && stored.deviceId) this.deviceId = stored.deviceId;
      if (stored?.encryptedToken) {
        this.token = safeStorage.decryptString(Buffer.from(stored.encryptedToken, "base64"));
      }
      if (stored?.encryptedRefreshToken) {
        this.refreshToken = safeStorage.decryptString(Buffer.from(stored.encryptedRefreshToken, "base64"));
      }
      if (this.token || this.refreshToken) this.state.status = "restoring";
    } catch {
      this.token = "";
      this.refreshToken = "";
    }
  }

  saveCredentials(token, refreshToken) {
    this.token = String(token || "");
    this.refreshToken = String(refreshToken || "");
    if ((!this.token && !this.refreshToken) || !safeStorage.isEncryptionAvailable()) {
      try { fs.rmSync(this.sessionPath, { force: true }); } catch {}
      return;
    }
    const payload = JSON.stringify({
      version: 2,
      deviceId: this.deviceId,
      encryptedToken: this.token ? safeStorage.encryptString(this.token).toString("base64") : "",
      encryptedRefreshToken: this.refreshToken ? safeStorage.encryptString(this.refreshToken).toString("base64") : ""
    });
    const temporaryPath = `${this.sessionPath}.tmp`;
    fs.writeFileSync(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.sessionPath);
  }

  async request(pathname, { method = "GET", body, authenticated = true } = {}, _retried = false) {
    const headers = {
      Accept: "application/json",
      "User-Agent": "Drip-Desktop"
    };
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    if (authenticated && this.token) headers.Authorization = `Bearer ${this.token}`;
    let response;
    try {
      response = await this.session.fetch(`${this.apiBase}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error(error?.name === "TimeoutError" ? "账号服务器响应超时" : "无法连接账号服务器");
    }
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (response.status === 401 && authenticated && this.refreshToken && !_retried) {
      if (await this._refresh()) {
        return this.request(pathname, { method, body, authenticated }, true);
      }
    }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(String(payload?.error || `账号服务器返回 ${response.status}`));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async _refresh() {
    if (!this.refreshToken || !this.deviceId) return false;
    try {
      const response = await this.session.fetch(`${this.apiBase}/refresh`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "Drip-Desktop"
        },
        body: JSON.stringify({ refreshToken: this.refreshToken, deviceId: this.deviceId }),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const data = await response.json();
      if (!response.ok || data?.ok === false) {
        this.saveCredentials("", "");
        return false;
      }
      this.saveCredentials(data.token, data.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  async restore() {
    this.authEpoch += 1;
    if (!this.token) {
      this.nodeLinks = [];
      return this.emit({ status: "signed-out", busy: false, user: null, entitlement: null, managedNodes: [], error: null });
    }
    this.emit({ status: "restoring", busy: true, error: null });
    try {
      const payload = await this.request("/me");
      this.emit({ status: "signed-in", busy: false, user: payload.user, error: null });
      await this.refreshManagedAccess();
      return this.snapshot();
    } catch (error) {
      if (error.status === 401) this.saveCredentials("", "");
      this.nodeLinks = [];
      return this.emit({ status: "signed-out", busy: false, user: null, entitlement: null, managedNodes: [], error: error.message });
    }
  }

  async login(username, password) {
    this.authEpoch += 1;
    this.saveCredentials("", "");
    this.nodeLinks = [];
    this.emit({ status: "signed-out", user: null, entitlement: null, managedNodes: [] });
    this.emit({ busy: true, error: null });
    try {
      const payload = await this.request("/login", {
        method: "POST",
        authenticated: false,
        body: { username, password, deviceId: this.deviceId }
      });
      this.saveCredentials(payload.token, payload.refreshToken);
      this.emit({ status: "signed-in", busy: false, user: payload.user, error: null });
      await this.refreshManagedAccess();
      return this.snapshot();
    } catch (error) {
      return this.emit({ status: "signed-out", busy: false, user: null, error: error.message });
    }
  }

  async register(username, displayName, password) {
    this.authEpoch += 1;
    this.saveCredentials("", "");
    this.nodeLinks = [];
    this.emit({ status: "signed-out", user: null, entitlement: null, managedNodes: [] });
    this.emit({ busy: true, error: null });
    try {
      const payload = await this.request("/register", {
        method: "POST",
        authenticated: false,
        body: { username, displayName, password, deviceId: this.deviceId }
      });
      this.saveCredentials(payload.token, payload.refreshToken);
      this.emit({ status: "signed-in", busy: false, user: payload.user, error: null });
      await this.refreshManagedAccess();
      return this.snapshot();
    } catch (error) {
      return this.emit({ status: "signed-out", busy: false, user: null, error: error.message });
    }
  }

  async updateProfile(displayName) {
    if (!this.token) return this.emit({ error: "请先登录" });
    this.emit({ busy: true, error: null });
    try {
      const payload = await this.request("/profile", { method: "POST", body: { displayName } });
      return this.emit({ status: "signed-in", busy: false, user: payload.user, error: null });
    } catch (error) {
      return this.emit({ busy: false, error: error.message });
    }
  }

  async updateAvatar(avatarData) {
    if (!this.token) return this.emit({ error: "请先登录" });
    this.emit({ busy: true, error: null, notice: null });
    try {
      const payload = await this.request("/avatar", { method: "POST", body: { avatarData } });
      return this.emit({ status: "signed-in", busy: false, user: payload.user,
        error: null, notice: avatarData ? "头像已更新" : "头像已移除" });
    } catch (error) {
      return this.emit({ busy: false, error: error.message, notice: null });
    }
  }

  async changePassword(currentPassword, newPassword) {
    if (!this.token) return this.emit({ error: "请先登录" });
    this.emit({ busy: true, error: null });
    try {
      await this.request("/password", { method: "POST", body: { currentPassword, newPassword } });
      return this.emit({ busy: false, error: null, notice: "密码已更新" });
    } catch (error) {
      return this.emit({ busy: false, error: error.message, notice: null });
    }
  }

  async logout() {
    this.authEpoch += 1;
    const token = this.token;
    this.saveCredentials("", "");
    this.nodeLinks = [];
    const state = this.emit({ status: "signed-out", busy: false, user: null, entitlement: null, managedNodes: [], error: null, notice: null });
    if (token) {
      try {
        await this.session.fetch(`${this.apiBase}/logout`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch {}
    }
    return state;
  }

  async refreshManagedAccess() {
    if (!this.token || this.state.status !== "signed-in") return this.snapshot();
    const epoch = this.authEpoch;
    const userId = this.state.user?.id;
    try {
      const grant = (await this.request("/entitlement")).entitlement;
      const nodes = grant?.active ? (await this.request("/managed-nodes")).nodes || [] : [];
      if (this.authEpoch !== epoch || this.state.status !== "signed-in" || this.state.user?.id !== userId) return this.snapshot();
      this.nodeLinks = nodes;
      return this.emit({ entitlement: grant, managedNodes: nodes.map(({ id, name }) => ({ id, name })), error: null });
    } catch (error) {
      if (this.authEpoch !== epoch || this.state.status !== "signed-in" || this.state.user?.id !== userId) return this.snapshot();
      this.nodeLinks = [];
      return this.emit({ entitlement: null, managedNodes: [], error: error.message });
    }
  }

  async redeem(code) {
    if (!this.token) throw new Error("请先登录");
    await this.request("/redeem", { method: "POST", body: { code } });
    const state = await this.refreshManagedAccess();
    return state.error ? state : this.emit({ notice: "兑换成功，节点、流量和有效期已更新" });
  }

  managedNode(id) {
    return this.nodeLinks?.find(node => node.id === id) || null;
  }

  async listDevices() {
    const payload = await this.request("/devices");
    return payload.devices || [];
  }

  async revokeDevice(deviceId, all = false) {
    return this.request("/revoke", { method: "POST", body: { deviceId: deviceId || "", all: Boolean(all) } });
  }

  async revokeAllDevices() {
    return this.revokeDevice("", true);
  }

  async syncSet(key, value) {
    return this.request("/sync", { method: "POST", body: { key, value } });
  }

  async syncGet(key) {
    return this.request(`/sync?key=${encodeURIComponent(key)}`);
  }

  async syncList() {
    return this.request("/sync");
  }
}

module.exports = { AccountService, DEFAULT_API_BASE };
