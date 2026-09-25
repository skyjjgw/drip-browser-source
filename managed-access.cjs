function routeUsesManagedAccess(route) {
  return ["default", "managed"].includes(route?.mode) ||
    (route?.mode === "node" && route.nodeId?.startsWith("managed:"));
}

function isManagedNodeAuthorized(account, ownerUserId, nodeId, lookupNode) {
  return account?.status === "signed-in" && account.entitlement?.active === true &&
    ownerUserId != null && account.user?.id === ownerUserId &&
    typeof nodeId === "string" && Boolean(lookupNode(nodeId));
}

module.exports = { routeUsesManagedAccess, isManagedNodeAuthorized };
