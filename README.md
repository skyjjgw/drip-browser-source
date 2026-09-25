# Drip browser structure snapshot

This private repository contains a sanitized snapshot of the Windows Electron browser source at version 0.3.12. It is a code reference, not a complete runnable build or release channel.

Included: the browser window/tab architecture, UI HTML/CSS/JavaScript, preload bridges, account/update client structure, proxy-center logic, package manifests, and source tests.

Excluded: Git history from the working project, server addresses and credentials, account/session data, proxy nodes and subscriptions, local runtime configuration, the proxy executable, logs, installers, icons, photos, videos, and vendored third-party code. No production server configuration is present.

The source uses placeholder URLs and optional environment variables `DRIP_SERVER_EGRESS_IP`, `DRIP_ACCOUNT_API_BASE`, and `DRIP_UPDATE_URL`. Do not commit real values. Network and packaging features require privately supplied runtime files and media, which are deliberately absent here.
