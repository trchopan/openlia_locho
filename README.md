# OpenLia over browser Locho

An independent static browser proxy for the **connected deployment’s own Workspace UI**.
No copied UI, public backend proxy, private SDK imports, or Locho server component
is bundled here. The Locho connection runs in the browser’s service worker.

The gateway pins **`locho_web@0.1.0-beta.3`** and uses its public
`fetchStreamWithMetadata()` API to manage OpenLia's session in worker memory.
The deployed UI keeps its own login, routing, server functions, and editor;
no OpenLia backend authentication changes are required for this integration.

This is an experimental, trusted-deployment-only gateway, not a
production-qualified public frontend. See [architecture and limitations](docs/architecture.md)
for the session model, test coverage, and compatibility boundaries.

## Run locally

Use Node 24 (tested with 24.18.0) and npm. SDK/WASM files install from npm; Rust
is not required to build this frontend.

```sh
cd ~/Code/active/openlia_locho
npm ci --ignore-scripts
npm run check
npm run serve
```

Open <http://127.0.0.1:4173/__locho/>. Loopback is a secure context for service
workers; a remote deployment requires HTTPS.

On a **disposable OpenLia host** with Locho hosting enabled, export the complete
`workspace-ui` TCP `locho1:…` ticket using Locho’s ordinary `share --ticket`
command against that host’s configuration/state. The current `openlia locho-host
share` command emits attachment configuration, not this ticket format. For a
generated Compose deployment, run the equivalent of:

```sh
docker compose -f <generated-compose-file> exec -T locho-host \
  locho share workspace-ui \
  --config /var/lib/openlia-locho-host/locho.toml --ticket
```

Use the deployment’s real Compose invocation/project options. Do not paste tickets
into command arguments on this public frontend, URLs, issue reports, or logs.
The gateway uses normal N0 discovery/relays; compatibility with custom
authenticated relays is unverified. A private deployment can remain private;
the static host never receives the ticket or opens the tunnel.

Paste the ticket into the connection screen, confirm that you trust the deployment,
then open its Workspace UI and sign in normally. Return to `/__locho/` to disconnect.
Close every old workspace tab before attempting a different connection. Worker termination loses
the ticket and returns navigation to pairing; there is no automatic restoration.
Disconnect is local cleanup, not capability/session revocation. Rotate an exposed
capability on the host; clearing browser memory does not revoke it.

## Verification

The real-browser suite needs Bun, Locho **1.3.0-beta.2**, public N0 connectivity,
and an existing built OpenLia Workspace UI. It starts only disposable loopback
processes and temporary synthetic workspace/state, then cleans them up.

```sh
npx playwright install chromium firefox webkit
OPENLIA_SOURCE=../open_lia npm run test:browser
```

Overrides:

- `LOCHO_BINARY`: exact path to the installed Locho beta CLI.
- `OPENLIA_SOURCE`: OpenLia repository path (default `../open_lia`).
- `OPENLIA_SERVER_ENTRY`: built Workspace UI server entry (default
  `<OPENLIA_SOURCE>/packages/workspace-ui/dist/server.js`). Use an independently
  built entry to test another deployment version.
- `PORT`: loopback static preview port; browser test configuration uses 4173.

`npm test` checks request/header boundaries, cookie policy, scope, expiry, and
out-of-order updates. `npm run build` typechecks and emits static assets. Browser
tests cover the deployed UI's login, protected access, document save/reload,
logout, and session failure/recovery. Native Hermes chat, Firebase login, and real
ingestion workflows remain unverified; synthetic transport probes are not
substitutes for testing those features.

No screenshots, videos, or traces are requested. Ignored failure artifacts may
still contain synthetic test data; never publish them without inspection.

### Read-only check against an existing dev deployment

`scripts/verify-live.mjs` uses the SSH target/project in
`~/.config/openlia/dev/config.toml`, exports a ticket into process memory, and
starts an isolated local static gateway/browser session. It checks login,
protected tree access, reload and logout, without editing workspace documents.
It requires the deployed host to run Locho `1.3.0-beta.3`.
It supports Chromium, Firefox and WebKit.

Pass the password over stdin, not in arguments or saved files. For an interactive
terminal, this prompts without echoing it:

```sh
python3 - <<'PY'
import getpass, subprocess
raise SystemExit(subprocess.run(
    ["node", "scripts/verify-live.mjs"],
    input=getpass.getpass("Workspace password: "), text=True,
).returncode)
PY
```

Overrides: `OPENLIA_LIVE_CONFIG` for the profile path and
`OPENLIA_LIVE_BROWSERS` for a comma-separated subset of
`chromium,firefox,webkit` (default: all three). The report contains only safe
status/count fields, never credentials, document names/content or browser error
call logs. No screenshots, videos or traces are recorded. Login/logout changes
only authentication sessions; this script does not initialize or deploy servers.

## Static hosting layout

Mount the contents of `dist/` under `/__locho/` on a **dedicated hostname**:

```text
/__locho/                 -> dist/index.html
/__locho/sw.js            -> dist/sw.js
/__locho/assets/*         -> dist/assets/*
all other paths          -> redirect navigation to /__locho/; otherwise 404
```

Required response configuration:

- `/__locho/sw.js`: JavaScript MIME type and `Service-Worker-Allowed: /`.
- `.wasm`: `application/wasm`.
- HTTPS, no caching of the control page/worker, and `Referrer-Policy: no-referrer`.
- Gateway CSP permits its own scripts/workers, WASM compilation, and the required
  N0 HTTPS/WSS discovery/relay destinations. See `scripts/serve.mjs`.
- Never add a catch-all proxy to an OpenLia server or turn missing private paths
  into public static requests. The controlled service worker handles these paths.

The local Node preview server only serves static files; it is not a tunnel server.
Production HTTPS/static hosting remains unverified. `deploy/Caddyfile` is
a configuration example, not a deployed service.

## Trust boundary

Application-managed sessions do **not** inherit native browser HttpOnly/SameSite
enforcement. The worker accepts only the known OpenLia host-only cookie, with
`Path=/`, `HttpOnly`, `SameSite=Strict`, a supported expiry, and a 43-character
base64url token. Domain cookies, duplicate/ambiguous updates, and unsupported
attributes fail closed. Maximum local lifetime is 30 days. The `Secure` flag is
optional because the private HTTP upstream runs inside the encrypted Locho tunnel;
it is not used as a reason to send credentials to a different connection.

Raw SDK metadata stays inside the worker. It is never returned to the deployed
page, persisted, or included in diagnostics. Browser-origin cookies are never
forwarded upstream. Each session is bound to the full host/service/type identity;
request-generation and update-order checks reject stale changes after logout or
connection replacement.

Use only deployments you trust. On one hostname their JavaScript shares an origin
with this gateway and any previous deployment. It can access origin storage and
potentially interfere with worker registration. One-connection checks, no proxy
persistence, and session-generation guards **are not an isolation boundary against
malicious same-origin code**. Do not host unrelated applications on this origin.

The gateway leaves upstream CSP intact, rejects foreign origins and external
redirects, limits request bodies to 4 MiB, streams response bodies with backpressure,
and never replays writes. It has no WebSocket support, upload streaming, background
availability guarantee, credential persistence, or arbitrary-version guarantee.
