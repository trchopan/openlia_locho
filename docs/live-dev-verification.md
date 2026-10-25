# Live `openlia_dev` verification — 2026-10-25

## Deployment initialization

The existing SSH dev profile was present locally, but its configured runtime root
and Compose project did not exist on the target. Initialization used the existing
profile and bundled OpenLia CLI, without resetting passwords or restoring/deleting
workspace data.

The dev profile originally pinned Locho `1.2.0`; its cached binary did not support
`share --ticket`. With explicit user approval, only the Locho component pin was
upgraded to **`1.3.0-beta.3`**. The original config was backed up next to the profile
with mode `0600` before editing. Linux archive checksums were checked against both
the published release asset digests and checksum files; the image build verifies
the downloaded archive before installing its binary.

Preservation checks after initialization confirmed:

- Workspace UI and Open WebUI password verifiers unchanged.
- Hermes image/tag/digest unchanged.
- Secret-source configuration unchanged.
- Relay configuration/secret paths unchanged; existing relay policy retained.
- Operator config remains mode `0600`.

The dev stack was left running. Workspace UI and Open WebUI reported healthy;
Hermes and the Locho host were running. This is not a provider/chat/agent doctor
acceptance claim.

## Live identities and health

- Deployed OpenLia: `0.1.0+release.f0e2b2e4a1dd`.
- Release SHA-256 reported by init and Workspace UI `/health`:
  `1b3825d2d43c928499d3fb4b72cb531ccb9105323e91ddd992e68c64fa216fe1`.
- Deployed host: `locho 1.3.0-beta.3`, clean commit
  `0c8ad57cc91af30144138bd324aeca86604f48dd`.
- Frontend SDK: exact registry `locho_web@0.1.0-beta.3`.
- Workspace UI `/health`: HTTP 200, `service=workspace-ui`, `ok=true`.
- Before login: password authentication required, unauthenticated.

Private target addresses, tickets, passwords, session tokens, document names and
contents are intentionally omitted from this record.

## Browser verification

`scripts/verify-live.mjs` exports a service ticket over SSH into process memory,
then uses the actual WASM gateway and the deployment's own HTML/assets/server
functions. There is no SSH HTTP port forward, fake API, application bundle rewrite,
or public server-side tunnel.

Each browser check:

1. Pairs the gateway with the deployed `workspace-ui` TCP ticket.
2. Signs in through the deployed UI using the supplied password over stdin.
3. Confirms authenticated session, valid live health, and protected tree HTTP 200.
4. Reloads the deployed UI and confirms the session survives.
5. Checks that the proxy's ticket/password/session cookie name did not appear in
   page storage, and that no native browser session cookie was installed.
6. Signs out through the deployed UI; session becomes unauthenticated and the
   protected tree returns HTTP 401.
7. Disconnects the gateway and closes its isolated browser/static-server processes.

No workspace editing or document mutation was attempted. The only deliberate
application writes were creating/revoking authentication sessions. No chat,
provider prompts, screenshots, videos or traces were requested by the verifier.

All three live browser checks passed:

| Browser | Version | Pair/login | Authenticated reload | Logout and protected 401 |
| --- | --- | --- | --- | --- |
| Chromium | 153.0.8010.12 | Passed | Passed | Passed |
| Firefox | 155.0 | Passed | Passed | Passed |
| WebKit | 26.6 | Passed | Passed | Passed |

Each run also passed credential-persistence checks and explicitly disconnected
before closing. The provided password worked without replacing its existing
verifier. Credentials and raw browser exceptions were not printed or written to
test artifacts.

## Boundaries

This live check is password-authenticated, read-only application smoke against a
real dev deployment. It is not native chat/approval, Firebase, actual ingestion,
mobile/browser-background, or production HTTPS-host acceptance. The Workspace UI
and Open WebUI listeners remain loopback-bound on the target.

The live OpenLia release differs from the synthetic fixture artifact recorded in
the [beta.3 integration report](sdk-beta3-integration.md). This adds deployed-version
smoke evidence, but does not replace a full two-version save/chat compatibility
matrix or a controlled SDK-only A/B comparison.
