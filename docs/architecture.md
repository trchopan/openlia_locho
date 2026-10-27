# Architecture and limitations

## Browser-only gateway

The static host serves the connection page, service worker, and SDK/WASM assets.
A root-scoped module service worker owns the public `locho_web` client and one
active TCP ticket. It proxies the connected deployment's own Workspace UI,
including HTML, scripts, routing, editor, and server functions. There is no copied
UI, iframe, application-bundle rewriting, or server-side tunnel.

`/__locho/` is reserved for the static gateway. Other same-origin paths go through
the worker to the deployment; foreign origins are not tunneled. The worker checks
`/health` and `/api/auth/session` when connecting. Peer connectivity alone is not
treated as application readiness.

Tickets and application sessions stay in worker memory. There is no gateway
credential persistence or automatic restoration. Worker termination requires
pairing again. Disconnect clears local state but does not revoke a capability or
backend session; exposed capabilities must be rotated on the host.

## Request and response boundaries

- The logical upstream is `http://workspace-ui`. Browser cookies, hop headers,
  spoofable forwarded headers, and the public website's Origin are not blindly
  forwarded.
- Subresource/API requests are checked against the browser client's origin and
  current connection generation. Their origin is translated to the logical
  upstream so existing backend origin checks continue to apply. Explicit foreign
  Origin or cross-site provenance is rejected; backend CSRF is not disabled.
- Non-GET/HEAD document navigations are rejected. Workspace UI mutations use
  same-origin fetch instead.
- Request bodies are bounded to 4 MiB. Responses stream with backpressure and
  cancellation. Writes are never transparently replayed after a failure.
- Private responses use `Cache-Control: no-store`. Upstream CSP is preserved,
  including nonces and frame restrictions. External redirects and redirects into
  the reserved gateway namespace are rejected.
- Browser-internal request buffering is outside the adapter's allocation bound.

## Application sessions

The SDK is pinned to `locho_web@0.1.0-beta.3`. The worker uses its public
`fetchStreamWithMetadata()` API because a normal browser `Response` filters out
`Set-Cookie`. Raw header tuples are processed only in the worker, before returning
a sanitized response to the page. No backend authentication extension or private
SDK binding is required.

Only `openlia_workspace_session` is accepted, with this contract:

- Host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`.
- An explicit `Max-Age` or `Expires`, and a 43-character base64url session token.
- `Max-Age` takes precedence; zero/negative or past expiry clears memory. Local
  lifetime is capped at 30 days.
- Repeated header fields are processed separately, never merged or split on
  commas. Multiple session fields, unsupported or duplicate attributes, domain
  cookies, unsupported paths, and invalid values fail closed and clear the local
  session. Unrelated cookies are ignored.

`Secure` is optional because the private HTTP upstream is inside the encrypted
Locho tunnel. These checks do **not** provide native browser HttpOnly/SameSite
enforcement. Client-origin checks, ticket/path scope, and backend authentication
remain essential.

Sessions are bound to the full ticket host/service/type identity. Increasing
request revisions prevent late responses from replacing newer sessions or undoing
logout. Connection-generation checks discard results from disconnected or replaced
clients. Raw metadata and session tokens are never exposed through page messages,
diagnostics, or browser storage, or attached to the static control namespace.

## Trust model

Connect only to deployments you trust. A deployment's JavaScript shares the
gateway's origin and can access origin storage or interfere with service-worker
registration. Existing workspace tabs block connection replacement, but these
checks are safeguards against accidental mixing, **not isolation from malicious
same-origin code**. Use a dedicated hostname with no unrelated applications.

The gateway does not persist credentials, but the upstream UI may independently
persist application data such as drafts or scroll state. That storage is not
silently deleted or isolated by the gateway.

## Test coverage and compatibility

Unit tests cover request/header boundaries, cookie parsing and expiry, ticket and
path scope, and out-of-order session updates.

The browser suite uses an unmodified built OpenLia Workspace UI with disposable
workspace/authentication state, a real Locho host, and public N0 infrastructure.
Its loopback test-only wrapper adds transport/session probes; it is not part of
the gateway or deployed backend. The fixture requires Locho `1.3.0-beta.2`.

Browser checks cover native password login, protected tree access, document editing
and save/reload, logout, wrong passwords, local cookie expiry, ambiguous updates,
late responses, disconnect/re-pair, and credential-persistence checks. Transport
probes cover SSE, multipart/binary/range/large responses, cancellation, request
limits, lost mutations, and host restart. Explicit worker termination is tested
only in Chromium via CDP; Firefox/WebKit skip that case.

`scripts/verify-live.mjs` separately checks login, protected tree access, reload,
logout, and credential persistence against an existing deployment without editing
documents. It requires a Locho `1.3.0-beta.3` host. Neither the fixture pin nor the
live verifier establishes arbitrary-version compatibility.

The following remain unverified or unsupported:

- Native Hermes chat/approvals and actual ingestion/upload/preview workflows;
  synthetic transport probes do not establish application support.
- Firebase/Google login and public-domain authorization.
- A full compatibility matrix across independently built OpenLia versions.
- Production HTTPS hosting, CSP, worker scope headers, and WASM MIME behavior.
- Physical/mobile browsers, BFCache, long background suspension, broader network
  transitions, and custom authenticated relay policies.
- Security review of the single-origin trust model and application-owned storage.
- WebSockets, upload streaming, and guaranteed background availability.
