const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron") return { safeStorage: { isEncryptionAvailable: () => false } };
  return originalLoad.call(this, request, parent, isMain);
};
const { AccountService } = require("../account-service.cjs");
Module._load = originalLoad;

function accountService(fetcher) {
  const service = new AccountService({
    session: { fetch: fetcher },
    userDataPath: path.join(os.tmpdir(), `drip-account-test-${process.pid}-${Math.random()}`)
  });
  service.token = "session-a";
  service.state = { status: "signed-in", user: { id: 5 }, entitlement: { active: true },
    managedNodes: [{ id: "jp" }] };
  service.nodeLinks = [{ id: "jp", url: "vless://not-a-real-key@example.test" }];
  return service;
}

test("logout removes local managed access before server response", async () => {
  let finish;
  const service = accountService(() => new Promise(resolve => { finish = resolve; }));
  const pending = service.logout();
  assert.equal(service.snapshot().status, "signed-out");
  assert.equal(service.snapshot().entitlement, null);
  assert.deepEqual(service.nodeLinks, []);
  finish({ ok: true });
  await pending;
});

test("a late entitlement refresh cannot restore access after logout", async () => {
  let finishEntitlement;
  const service = accountService(url => url.endsWith("/entitlement")
    ? new Promise(resolve => { finishEntitlement = resolve; })
    : Promise.resolve({ ok: true }));
  const refreshing = service.refreshManagedAccess();
  await service.logout();
  finishEntitlement({ ok: true, status: 200, json: async () => ({
    ok: true, entitlement: { active: false, nodeIds: [], usedBytes: 0, quotaBytes: 0 }
  }) });
  await refreshing;
  assert.equal(service.snapshot().status, "signed-out");
  assert.deepEqual(service.nodeLinks, []);
});

test("avatar update replaces account profile without changing authorization", async () => {
  const avatarData = "data:image/jpeg;base64,example";
  const service = accountService(async (_url, options) => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, user: { id: 5, displayName: "Tester", avatarData },
      body: options.body }),
  }));
  const result = await service.updateAvatar(avatarData);
  assert.equal(result.user.avatarData, avatarData);
  assert.equal(result.entitlement.active, true);
  assert.deepEqual(service.nodeLinks.map(node => node.id), ["jp"]);
});
