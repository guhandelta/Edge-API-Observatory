# Commit and release log

Add an entry here **in each commit**. Record user-visible changes, verification, and release impact. This file is separate from the app's usage guide in `ReadMe.md`.

## Release status

**v0.1.0:** planned. The local prototype works; production D1, deployment, public verification, and the GitHub release remain open in `RELEASE_PLAN.md`.

### v0.1.0 release description draft

- Synthetic comparison of browser-direct and Cloudflare Worker requests to approved sample APIs.
- D1-backed history, median durations, status codes, error rate, and a compact latency chart.
- Bounded request/response bodies, an approximate rate limit, and Worker tests.
- Measurement note: these paths have different network routes. Their duration difference does not isolate Worker overhead; direct browser access can be unavailable because of CORS.

This is a draft, not a published release. Add the live deployment URL and verification result before publishing.

## Commits

### 2026-11-07 — `feat: build Edge API Observatory starter` (`4da05da`)

- Added the React + Vite dashboard, TypeScript Worker API, D1 migration, approved sample targets, inline documentation, and setup guide.
- Verified a production build, local D1 migration, and a browser comparison with both paths returning HTTP 200.
- Release impact: establishes the local v0.1.0 prototype; no production deployment.

### 2026-11-07 — `docs: define initial release gates` (`fceaece`)

- Added the release checklist and this commit/release log; future commits must update this log.
- Verified the existing repo state and Cloudflare/GitHub authentication status.
- Release impact: records the remaining work and external account gates without claiming a release.

### 2026-11-07 — `feat: harden probes and add Worker tests` (`a801536`)

- Limited JSON request bodies to 2 KiB and upstream response reads to 64 KiB. Added the Cloudflare rate-limit binding for a shared anonymous budget.
- Added Wrangler-generated binding types and five tests for the allowlist, validation, rate-limit response, D1 persistence, and oversized responses.
- Verified typecheck, tests, build, the local migration state, and a live local probe write.
- Release impact: the local release candidate now has bounded probe inputs and automated Worker coverage. Production deployment remains open.

### 2026-11-07 — `docs: record local release verification` (`0389b64`)

- Recorded the passing typecheck, five Worker tests, production build, local migration state, and browser comparison that persisted after refresh.
- Updated the dashboard screenshot to show the verified local release candidate.
- Release impact: all local v0.1.0 checks are complete; Cloudflare authentication, production D1, remote deployment, and public verification remain open.

### 2026-11-07 — `docs: prepare production release runbook` (`7bcf107`)

- Added exact deployment, remote smoke-test, and tag commands plus a v0.1.0 release description draft.
- Release impact: the production sequence is reviewable while Cloudflare authentication is pending.

### 2026-11-07 — `docs: clarify project-local Wrangler setup` (`76e4b65`)

- Clarified that Wrangler and the other build tools are installed through `npm ci`, so no global Wrangler command is required.
- Added the device authorization flow to the README and release runbook after the localhost callback timed out twice.
- Release impact: Cloudflare sign-in and all production gates remain pending.

### 2026-11-07 — `feat: expose probe request IDs and error categories` (`8f350af`)

- Made the persisted probe UUID an explicit `requestId` in results and an `X-Request-ID` response header, including rejected requests and internal failures.
- Added stable upstream categories for success, HTTP errors, timeouts, network errors, and oversized responses while retaining the existing dashboard fields.
- Verified typecheck, the Worker test suite, production build, and a local HTTP 201 probe containing the new fields.
- Release impact: Step 1's Worker contract is explicit and documented; production D1 and deployment remain pending.

### 2026-11-07 — `feat: store individual D1 probe samples` (this commit)

- Added migration `0002` to convert existing paired records into individual `browser_direct` and `worker_proxy` rows with timestamp, endpoint ID, request mode, timings, status, and error category.
- Made each new comparison write both rows in one D1 batch transaction. Added filtered `GET /api/history` while preserving paired `GET /api/probes` for the dashboard.
- Verified nine Worker tests, typecheck/build, local migration of five existing comparisons into ten samples, and a new live local probe that produced one row per mode.
- Release impact: Step 2 storage and history are complete locally; production D1 migration still awaits Cloudflare authentication.
