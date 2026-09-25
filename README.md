# Drip Browser

Drip is a Windows desktop browser built with Electron. This repository publishes a sanitized, development-oriented source snapshot of version 0.3.24. It is not the production distribution or a hosted proxy service.

## Features

- Browser tabs, address/search bar, bookmarks, history, downloads, appearance settings, and private windows.
- Account and update client interfaces, including invitation-based access state.
- Proxy-center UI, subscription parsing, node selection, browser routing, system proxy/TUN integration code, and traffic display.
- Automated tests for proxy configuration, subscriptions, browser routing, and access decisions.

## Development

Requirements: Windows, Node.js and npm.

```powershell
npm ci
npm test
npm start
```

The UI can start without a production server. Network-backed features remain unavailable until configured; missing media assets fall back to the UI background. Packaging is intentionally not configured in this public snapshot because the private runtime and artwork are not distributed here.

| Environment variable | Purpose |
| --- | --- |
| `DRIP_ACCOUNT_API_BASE` | Account API base URL (default: `https://example.invalid/api/account`) |
| `DRIP_UPDATE_URL` | Release information URL (default: `https://example.invalid/releases`) |
| `DRIP_SERVER_EGRESS_IP` | Expected egress IP for the connectivity check; leave unset if unavailable |

## Repository map

| Path | Role |
| --- | --- |
| `main.cjs` | Electron main process, windows, tabs, IPC, and routing |
| `preload.cjs`, `*-preload.cjs` | Renderer bridges |
| `home/`, `ui/` | Browser home, chrome, settings, and proxy UI |
| `account-service.cjs`, `managed-access.cjs` | Account client and access decisions |
| `proxy-*.cjs`, `browser-route.cjs` | Proxy configuration, subscriptions, traffic, and browser routing |
| `update-manager.cjs` | Update client |
| `tests/` | Automated checks |

## Scope and security

Production API endpoints, backend/database, account data, invitation codes, subscription URLs, proxy credentials, local runtime configuration, Mihomo executable, installer binaries, and private image/video assets are intentionally excluded. Cloning this repository does not grant access to any Drip-managed nodes. To produce a working distribution, provide your own backend, trusted release channel, appropriately licensed artwork, and separately obtained proxy runtime.

Do not commit real endpoint values, credentials, subscriptions, session files, or node configurations. A subscription URL may itself contain a credential. Use test accounts when developing and remove secrets from issues and pull requests.

The Drip source code in this repository is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses. Private artwork and runtime binaries are not included in this grant.
