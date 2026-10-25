# Browser SDK beta.3 integration — 2026-10-25

## Scope

Integrate the published `locho_web@0.1.0-beta.3` metadata API into the existing
browser-only gateway, without changing OpenLia, copying its UI, patching native
fetch, weakening backend authentication/CSP, or importing private SDK bindings.

This supersedes the authentication blocker in the [original beta.2 report](feasibility.md).
The browser still filters `Set-Cookie` on a normal `Response`; the new explicit
metadata API exposes the parsed header pairs to the worker before that filtering.

**Decision: authenticated password/document milestone accepted; public release
is not yet qualified.** The deployed UI now logs in, saves/reloads documents and
logs out through the unchanged backend. The gates at the end remain open.

## Implementation

- `package.json` / `package-lock.json`: exact registry beta.3 pin and integrity.
- `src/sw.ts`: use `fetchStreamWithMetadata()` and process its header tuples only
  inside the worker. Forward the normal sanitized response and bounded stream.
- `src/proxy.ts`: narrowly scoped OpenLia session handler, not a generic cookie jar.
  Bind each instance to the ticket host/service/type. Handle replacement, expiry,
  and deletion, and reject unsupported or ambiguous updates atomically.
- Assign an increasing request revision before asynchronous work. A late older
  cookie response cannot replace a newer session or undo logout. Connection
  generation checks discard all results from disconnected/replaced clients.
- Update the connection page to offer the deployed Workspace UI's normal login
  rather than report the old SDK blocker. Keep explicit trust and experimental
  status notices.

### Cookie contract

Only `openlia_workspace_session` is accepted. The current supported contract is a
host-only cookie with `Path=/`, `HttpOnly`, `SameSite=Strict`, explicit `Max-Age`
or `Expires`, and a 43-character base64url token. Separate repeated fields are
processed directly; they are never merged into `Headers` or split on commas.
Multiple session fields in one response are rejected rather than guessed.

`Max-Age` takes precedence over `Expires`; zero/negative or past expiry clears
memory. Local lifetime is capped at 30 days. Unknown/duplicate attributes,
unsupported paths/domains, invalid values and ambiguous updates clear the old
local session and fail closed. Unrelated cookies are ignored.

`Secure` is optional because OpenLia's local HTTP upstream is reached over the
encrypted Locho TCP transport. This is **not** native browser HttpOnly/SameSite
enforcement. The gateway's client-origin checks, navigation-method restrictions,
ticket/path scope and backend authentication remain essential. Credentials are
never attached to the public static control namespace or another ticket.

Raw metadata and sessions remain worker-only. The page receives no cookie jar,
session token, raw header list, or metadata diagnostics. SDK response filtering
and the gateway's sensitive-header stripping remain in place.

## Verification design

The real-browser fixture still uses an unmodified built OpenLia server, a
disposable workspace/password/database, a real Locho host, and public N0 relays.
Test-only transport/session probes live in a loopback fixture wrapper, **not**
the gateway or the OpenLia deployment.

Positive application acceptance:

1. Connect using a TCP ticket and load that deployment's actual UI.
2. Sign in through its native, version-matched TanStack server function.
3. Confirm the backend session is authenticated and protected tree access is 200.
4. Open `probe.md`, edit through the deployed CodeMirror editor, click Save, and
   independently verify the synthetic file contents on disk.
5. Reload and verify the saved document and authenticated UI remain available.
6. Sign out through the native UI; session becomes unauthenticated and protected
   tree access returns 401.

Session regression checks:

- Wrong passwords never create a session.
- Worker cookie expiry removes the outgoing Cookie header and returns the UI to
  login on reload. This is a local-expiry test, not proof of backend idle expiry.
- Repeated ambiguous session fields fail closed.
- A delayed pre-logout cookie response cannot resurrect a logged-out session;
  the fixture checks absence of the outgoing cookie, not just backend rejection
  of an already-revoked token.
- Disconnect/re-pair does not reuse an old session, even with the same ticket.
- Explicit worker termination after successful login requires pairing again
  (Chromium CDP only; Firefox/WebKit equivalents remain unclaimed).
- The browser cookie jar, local/session storage, Cache API and IndexedDB do not
  receive proxy credentials. The fixture privately observes its own issued token
  and checks only a leak boolean; no token is logged or injected into the page.

The existing SSE/multipart/binary/range/large-body, abort, request-limit,
lost-mutation and host-restart tests are retained. These are transport probes,
not native authenticated chat or ingestion acceptance.

## Final verification

- `npm run check`: **28 unit tests passed**, source TypeScript and production
  build passed.
- `npm audit`: **0 vulnerabilities**.
- `npm run test:browser`: **31 passed, 2 intentionally skipped**, no failures,
  no configured retries (9.8 minutes).

| Desktop engine | Passed | Skipped |
| --- | ---: | ---: |
| Chromium 153.0.8010.12 | 11 | 0 |
| Firefox 155.0 | 10 | 1 |
| WebKit 26.6 | 10 | 1 |

The skipped cases are explicit worker termination on Firefox and WebKit, where
equivalent CDP control is unavailable; these are not claimed as passes. All three
engines passed the positive deployed-UI password/document flow, cookie expiry,
ambiguous-update rejection, late-response/logout safety, disconnect/re-pair,
and the retained transport/fault/recovery suite. Chromium additionally passed
worker termination **after authenticated login**, with pairing required again.

The unit suite includes raw repeated headers/Expires commas, expiry precedence,
lifetime cap, deletion, malformed/duplicate attributes, scope mismatch, reserved
control paths, and out-of-order update barriers. Credential-leak checks never
print their token inputs.

## Artifact identities

- npm SDK: `locho_web@0.1.0-beta.3`.
- Verified registry integrity:
  `sha512-D1GzJUBKHwT07/ECa3cqFS3nKxoDss+YHeXYtaYYBV0clpdrM3oDNKzxTjG+TaHv2PlvANDAbYkpg9FrVuOsWg==`.
- Host CLI retained: `1.3.0-beta.2`, clean commit
  `70b2a4e2a41d216a41ad3626942c4c22f32007c3`.
- Node: `24.18.0`.
- OpenLia checkout HEAD observed:
  `f88cf902f512715f434663a037f3f090c128d8d3`.
- Existing server entry SHA-256 observed:
  `045c2b1e6499b03b3170ae4cc22ba9119d0e59daf2994fad4cd1f936162ce1d3`.

The OpenLia artifact differs from the original beta.2 feasibility run. This is
current integration acceptance, **not** a controlled SDK-only A/B comparison or
acceptance of two independently built deployment versions. OpenLia was not
modified or rebuilt by this integration.

## Remaining public-release gates

- Native Hermes chat and approvals: the fixture intentionally disables Hermes.
- Actual OpenLia ingestion/upload/preview acceptance, beyond transport byte probes.
- Firebase/Google login and public-domain authorization.
- A second independently built OpenLia version and a published compatibility matrix.
- Real HTTPS hosting, CSP, worker scope and WASM MIME acceptance.
- Physical/mobile browsers, BFCache, long background suspension, and broader
  network transitions/relay policies.
- Security review of the single-origin trusted-deployment model and all
  application-owned storage. One hostname cannot isolate malicious deployment JS.

No backend token/header extension, SDK source change, public deployment, or host
CLI upgrade is part of this milestone.

A subsequent, separately authorized [live dev verification](live-dev-verification.md)
initialized the existing dev profile, upgraded its Locho host to `1.3.0-beta.3`,
and passed read-only password/login/reload/logout checks in all three browsers.
The original synthetic-fixture identities and boundaries above remain unchanged.
