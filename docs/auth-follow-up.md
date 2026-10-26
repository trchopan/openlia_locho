# Historical auth blocker and proposed follow-up

> Update 2026-10-25: Locho shipped the requested public metadata APIs in
> `locho_web@0.1.0-beta.3` ([PR #121](https://github.com/trchopan/locho/pull/121),
> closing [issue #120](https://github.com/trchopan/locho/issues/120)). The gateway
> now uses the SDK-side option. No proposed OpenLia response-header protocol was
> implemented. See [the integration record](sdk-beta3-integration.md).
> The proposal below describes the pre-beta.3 decision, not a current blocker.

## Observed failure

The published `locho_web@0.1.0-beta.2` creates a standard browser `Response` for
both buffered and streamed upstream responses. Browsers filter the forbidden
response header `Set-Cookie` at construction time:

```js
new Headers({ 'Set-Cookie': 'synthetic=value' }).has('Set-Cookie'); // true
new Response('', {
  headers: { 'Set-Cookie': 'synthetic=value' },
}).headers.has('Set-Cookie'); // false in the tested browser
```

The SDK’s response does not update the browser cookie jar either. In the disposable
OpenLia fixture, direct HTTP login issues `Set-Cookie`; native Workspace UI login
through the tunnel returns success, but `/api/auth/session` remains unauthenticated
and protected REST endpoints return 401. A prospective scoped cookie adapter cannot
recover a header that has already been removed.

Do not work around this by disabling Workspace UI auth, relying on Locho tickets
alone, rewriting bundled application functions, or accessing SDK-generated private
WASM bindings.

## Preferred SDK-side option

Ask upstream to provide a public raw response-metadata API (including repeated
headers) before constructing `Response`, while retaining bounded streaming and
cancellation semantics. A reviewed, opt-in, worker-memory session-cookie adapter
could then preserve existing deployed UIs without backend changes.

This requires a new SDK release, not simply changing the CLI. Compatibility and
credential exposure must be explicitly documented and tested.

## OpenLia-side option for review

If upstream SDK work is not appropriate, add an **explicit, disabled-by-default
browser-Locho auth mode** in OpenLia. Preserve normal cookie/HttpOnly behavior for
ordinary deployments.

The narrowest compatibility change is a documented session response header,
for example `X-OpenLia-Locho-Session`, only when both server policy and a recognized
transport request opt in. The gateway captures that header, removes it from every
response delivered to the deployed UI, and sends the session only over the same
ticket-scoped connection. Native UI login and server functions remain unchanged;
logout needs an explicit clearing signal. Existing session expiry/revocation and
login validation remain authoritative.

The header name and protocol above are a proposal, **not an existing endpoint or
supported feature**. A token-in-body protocol with explicit bearer verification
is another option, but must still integrate with the remote UI’s own login flow.

Required review points:

- Normal deployments must never expose session values through script-readable
  headers merely because a request adds a transport marker.
- A marker is feature negotiation, not client authentication or proof of Locho.
- Explicit opt-in changes the HttpOnly threat model; it must be disclosed.
- Password and Firebase flows, server-function propagation, logout, rotation,
  expiry, and reconnection must use the same session authority.
- No permissive CORS, blanket origin bypass, or implicit trust of forwarded headers.
- Advertise support via a versioned capability; fail clearly on older backends.

No OpenLia or SDK files were changed for this milestone. Approve the protocol
before implementing either option, then rerun authenticated UI acceptance and
the second-version matrix.
