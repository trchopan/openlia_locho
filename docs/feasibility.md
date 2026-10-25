# Feasibility record

> Historical beta.2 result from 2026-10-24. The SDK blocker below is addressed by
> the beta.3 integration; see [current acceptance](sdk-beta3-integration.md).
> The original observations and test results are retained unchanged below.

## Decision

**No-go for the complete authenticated experience with the current published SDK
and unchanged OpenLia. The browser transport/proxy approach itself is viable.**

The blocking issue is browser filtering of `Set-Cookie` inside the SDK’s synthetic
`Response`. No working authentication, document-save, or native chat acceptance is
claimed. See [auth follow-up](auth-follow-up.md) for the next review decision.

## Architecture exercised

- The public host serves only a control page, service-worker JavaScript, and WASM.
- A root-scoped **module service worker owns the published SDK client** and a
  single active ticket. It serves upstream root paths directly, without an iframe,
  cloned frontend, injected bootstrap, or application-bundle rewriting.
- `/__locho/` is reserved for trusted static gateway assets. Other same-origin
  requests are handled by the browser proxy; foreign origins are not tunneled.
- The worker checks `/health` identity and `/api/auth/session` before offering the
  diagnostic UI. Peer connectivity alone is not treated as readiness.
- Native fetch bodies become bounded byte arrays. Streamed responses retain fetch
  event ownership and backpressure until completion/cancellation.
- Normal application paths, its deployed scripts, native routing, SSR HTML, and
  TanStack server-function requests travel to the deployment unchanged in content.
- Upstream CSP is preserved, including nonces and `frame-ancestors 'none'`.
- Gateway private responses are `no-store`. No Cache API/IndexedDB/ticket
  persistence or automatic write replay is implemented.

Service-worker lifetime is not guaranteed. Explicit termination loses the
connection and credentials; navigation returns to pairing rather than pretending
the deployment is still available. This is intentional for the milestone.

## Request security translation

The SDK generates HTTP framing and logical `Host: workspace-ui`. Browser cookies,
hop headers, spoofable forwarded headers, and the public website’s Origin are not
blindly forwarded.

Browsers may not expose `Origin` or Fetch Metadata headers to a service worker
before network dispatch. For a subresource/API request the proxy independently
checks the browser `Client` origin and its current connection-generation binding,
then translates its origin to `http://workspace-ui`. Explicit foreign Origin or
cross-site provenance is rejected. This allows the existing backend origin checks
to continue operating on the logical upstream; backend CSRF is not disabled.
Non-GET/HEAD document navigations (including native form POST navigations) are
rejected; current Workspace UI mutations use verified same-origin fetch instead.

One hostname cannot isolate malicious deployment JavaScript from the gateway or
previous origin storage. Existing app tabs block a new connection. These are
accidental-mixing safeguards, **not a hostile-code security boundary**.

## Fixture and provenance

Recorded environment:

- Node `24.18.0`; SDK `locho_web@0.1.0-beta.2`, pinned npm lockfile.
- CLI `locho 1.3.0-beta.2`, clean commit
  `70b2a4e2a41d216a41ad3626942c4c22f32007c3`.
- OpenLia checkout HEAD observed as
  `2fc00e8c67da3e78ec9d0433dbe9d9bbc0716d32`.
- Existing built server entry SHA-256 observed as
  `ffc369dfc7e2c7b9410125ca922b5d2f9975322530838c00b1d66b1465986be8`.
  This records the actual existing artifact, not a claim it was freshly rebuilt
  from that HEAD. OpenLia was not modified or rebuilt for this milestone.
- Real browser engines: Chromium `153.0.8010.12`, Firefox `155.0`, WebKit `26.6`.

Tests launch an unmodified built Workspace UI in Bun with an isolated temporary
workspace, password verifier, session database, and Locho identity. A loopback
**test-only** HTTP wrapper adds byte/stream/fault probes and otherwise forwards
to that server. A real Locho TCP host tunnels to this fixture using public N0
infrastructure. The production gateway has no equivalent wrapper or upstream
network server.

## Evidence boundaries

The automated suite exercises these checks; passing expectations for the auth
blocker are explicitly negative acceptance, not functional authentication:

| Check | What it establishes |
| --- | --- |
| WASM/service-worker connect | Registry SDK can run in the chosen worker runtime and reach the real service |
| HTML, assets, hydration, deep link, refresh | The deployment’s own frontend can load without cloning or weakening CSP |
| Native server-function login | Its route reaches OpenLia; successful auth response cannot establish the browser proxy session |
| Direct fixture login vs tunneled session | Backend issues the cookie, SDK loses it, protected REST stays 401 |
| Incremental SSE | A synthetic event reaches the reader before stream completion; not native authenticated chat |
| Multipart byte echo | Filename, boundary, and binary bytes survive; not OpenLia ingestion acceptance |
| Range/binary/9 MiB response | Byte integrity and streaming beyond buffered SDK limits |
| Relative redirect / external rejection | Same-service navigation works; external redirects fail closed |
| Abort/oversized upload/lost mutation | Stream cleanup, 4 MiB request bound, and no transparent mutation replay |
| Explicit worker termination | Chromium-only CDP test proves safe pairing recovery and no proxy credential persistence |
| Host stop/restart | A failed mutation is not replayed when transport recovers |

Initial runs found a Firefox request-body incompatibility: `FetchEvent.request.body` can be
null while `request.blob()` still contains POST bytes. The adapter now checks the
Blob size before allocating its byte buffer in that case. Browser-internal request
buffering is outside the adapter’s allocation bound.

The reserved control page also explicitly reclaims service-worker control before
allowing private fetches; this resolves a Firefox navigation/control difference
without allowing private requests to fall back to the static host.

## Final verification — 2026-10-24

`npm run check`: **9 unit tests passed**, TypeScript passed, production build passed.
`npm audit`: **0 vulnerabilities**. The installed SDK’s SHA-512 integrity matches
the published beta.2 integrity record.

`npm run test:browser`: **16 passed, 2 intentionally skipped**, no failures (3.7 min).

| Desktop engine | Passed | Skipped | Notes |
| --- | ---: | ---: | --- |
| Chromium 153.0.8010.12 | 6 | 0 | Includes explicit worker termination and host restart |
| Firefox 155.0 | 5 | 1 | Explicit worker termination is not implemented without CDP |
| WebKit 26.6 | 5 | 1 | Explicit worker termination is not implemented without CDP |

All three engines passed deployed HTML/assets, deep-link/reload navigation,
negative auth acceptance, incremental SSE, multipart/binary/range/large-body
transport, stream cancellation, request limits, lost-response no-replay, and
host-restart recovery. The skipped cases are disclosed limitations, not passes.

**These results do not establish authenticated Workspace UI functionality.**
The auth tests intentionally assert that the SDK loses the backend cookie and
protected endpoints remain unauthorized.

## Still required before public acceptance

1. Review and implement an SDK metadata API or explicit OpenLia auth protocol.
2. Prove password and Firebase session lifecycle, logout, expiry/revocation, and
   native authenticated documents/chat/ingestion through the **deployed UI**.
3. Run against a second independently built OpenLia version. One artifact is not
   an arbitrary-version compatibility claim.
4. Deploy and verify real HTTPS, CSP, worker scope headers, and WASM MIME behavior.
5. Test physical/mobile browsers, BFCache, background suspension, real network
   changes, long-lived streams, and relay availability.
6. Review single-origin trusted-deployment security and all application-owned
   storage. The upstream UI may persist its own scroll state/drafts independently
   of this proxy; it is not silently deleted or claimed to be isolated.

No server-side gateway fallback, backend auth relaxation, SDK private API access,
or public infrastructure provisioning was performed.
