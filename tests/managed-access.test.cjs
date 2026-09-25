const test = require("node:test");
const assert = require("node:assert/strict");
const { routeUsesManagedAccess, isManagedNodeAuthorized } = require("../managed-access.cjs");

test("managed browser routes are distinct from personal subscriptions", () => {
  for (const route of [{ mode: "default" }, { mode: "managed", nodeId: "managed:jp" },
    { mode: "node", nodeId: "managed:jp" }]) assert.equal(routeUsesManagedAccess(route), true);
  for (const route of [{ mode: "node", nodeId: "subscription:one:0" },
    { mode: "direct" }, { mode: "system" }, { mode: "manual" }]) assert.equal(routeUsesManagedAccess(route), false);
});

test("managed node requires the same signed-in account and current grant", () => {
  const lookup = id => id === "jp" ? { id: "jp" } : null;
  const account = { status: "signed-in", user: { id: 5 }, entitlement: { active: true } };
  assert.equal(isManagedNodeAuthorized(account, 5, "jp", lookup), true);
  assert.equal(isManagedNodeAuthorized(account, 6, "jp", lookup), false);
  assert.equal(isManagedNodeAuthorized({ ...account, status: "signed-out" }, 5, "jp", lookup), false);
  assert.equal(isManagedNodeAuthorized({ ...account, entitlement: { active: false } }, 5, "jp", lookup), false);
  assert.equal(isManagedNodeAuthorized(account, 5, "us1", lookup), false);
});
