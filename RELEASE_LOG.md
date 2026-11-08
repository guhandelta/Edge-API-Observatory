# Commit and release log

Add an entry here **in each commit**. Record user-visible changes, verification, and release impact. This file is separate from the app's usage guide in `ReadMe.md`.

## Release status

**v0.1.0:** planned. The local prototype works; production D1, deployment, public verification, and the GitHub release remain open in `RELEASE_PLAN.md`.

### v0.1.0 release description draft

- Synthetic comparison of browser-direct and Cloudflare Worker requests to approved sample APIs.
- Controlled same-origin success, 750 ms delay, and HTTP 503 fixtures for repeatable demonstrations.
- A documented local delay investigation with architecture and screenshots.
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

### 2026-11-07 — `feat: store individual D1 probe samples` (`42fcde6`)

- Added migration `0002` to convert existing paired records into individual `browser_direct` and `worker_proxy` rows with timestamp, endpoint ID, request mode, timings, status, and error category.
- Made each new comparison write both rows in one D1 batch transaction. Added filtered `GET /api/history` while preserving paired `GET /api/probes` for the dashboard.
- Verified nine Worker tests, typecheck/build, local migration of five existing comparisons into ten samples, and a new live local probe that produced one row per mode.
- Release impact: Step 2 storage and history are complete locally; production D1 migration still awaits Cloudflare authentication.

### 2026-11-07 — `feat: add batch diagnostics dashboard` (this commit)

- Added three- or five-pair runs against one selected endpoint, last-batch median comparison with measured counts, a small-sample label, Worker success rate, and a status breakdown alongside the existing latency chart and recent runs table.
- Added focused metric tests and refreshed the full-page dashboard preview.
- Verified 11 tests, production build, and a three-pair browser run. In that local run, the browser-direct median was 147 ms and the Worker-upstream median was 33 ms, each from three measured samples; the UI labels this as a small sample and does not treat the difference as Worker overhead.
- Release impact: Step 3 is complete locally; production deployment remains pending.

### 2026-11-07 — `feat: add controlled demo probe endpoints` (this commit)

- Added fixed Worker-hosted success, 750 ms delay, and HTTP 503 routes and included them in the approved probe targets.
- Enabled public self-fetch for the Worker so both request paths reach the same fixture URL; labeled this controlled same-origin comparison in the dashboard and README.
- Verified 13 tests, production build, and local HTTP probes: success 200, delayed 200 with about 818 ms Worker fetch duration, and error 503 categorized as `http_error`.
- Release impact: Step 4 is complete locally; public self-fetch verification and production deployment remain pending.

### 2026-11-07 — `feat: add persistent dashboard theme toggle` (this commit)

- Added an accessible sun/light and crescent-moon/dark toggle. The initial palette follows the operating system, and an explicit choice persists in local browser storage.
- Tuned the light palette to soft neutrals and added a dark blue-violet-brown background with coordinated cards, charts, controls, and status colors.
- Made chart bars scale to their container so the dashboard does not overflow a narrow viewport.
- Verified typecheck, production build, both palettes in the browser, persistence after reload, and a 375 px viewport without horizontal page overflow.
- Release impact: improves the local portfolio dashboard; production deployment remains pending.

### 2026-11-07 — `docs: record controlled delay investigation` (this commit)

- Added a three-batch local investigation showing immediate success, programmed 750 ms delay, and return to immediate success.
- Recorded latest-batch browser-direct and Worker fetch medians, HTTP statuses, a Mermaid architecture diagram, and full-page screenshots of the delayed and recovery batches.
- Explained the small sample and that browser-to-Worker round-trip time is not measured, so it cannot be claimed stable.
- Verified the browser results, screenshot contents and links, typecheck, production build, and the local D1 history route returning both request modes.
- Release impact: Step 5 portfolio evidence is complete locally; public deployment and verification remain pending.

### 2026-11-08 — `test: enforce full Worker and dashboard coverage` (this commit)

- Added Worker validation, error, history, and D1 integration cases plus React DOM tests for batches, status display, failures, theme preference, and bootstrap.
- Added Istanbul coverage gates for all six production TypeScript runtime files and a GitHub Actions workflow that runs typecheck, coverage, and build.
- Verified 22 Worker tests and 14 UI tests with 100% statements, branches, functions, and lines per included file; typecheck and production build pass.
- Release impact: adds a repeatable local and CI quality gate. Production deployment and public verification remain pending.

### 2026-11-08 — `feat: complete probe timing model` (this commit)

- Measured the browser's `POST /api/probes` round trip through response parsing and displayed its current-session value and median alongside the browser-direct, Worker-upstream, and Worker-handler timings.
- Extended Worker handler wall time from request entry through rate limiting, validation, upstream fetch, and the primary D1 batch commit. Persisted that measurement in the Worker sample; the timing-metadata update itself is outside the recorded interval.
- Added a delayed-D1 integration assertion and UI/metric tests. Verified 24 Worker tests and 14 UI tests with 100% per-file statements, branches, functions, and lines; typecheck and production build pass. A local demo-success probe returned 42 ms upstream fetch and 108 ms handler time, with 108 ms confirmed in D1 history. A three-pair browser run displayed all four medians, including 38 ms Worker handler and 88 ms browser POST round trip.
- Release impact: the timing model is complete for the local release candidate. Browser POST timing remains session-only; production deployment and public verification remain pending.

### 2026-11-08 — `feat: correlate probes with Cloudflare traces` (this commit)

- Enabled Workers tracing, attached each probe request ID to an `api.probe` custom span, and stored its trace ID in a new nullable D1 column and the paired API response.
- Added a run-level investigation view and a bounded Worker lookup for Cloudflare fetch and D1 span durations. It distinguishes unavailable IDs, missing lookup configuration, and no stored trace, which can result from sampling, ingestion delay, or expiry.
- Added Worker integration and React DOM cases for correlation, platform spans, missing traces, lookup errors, and limits. Verified typecheck, 100% per-file statements/branches/functions/lines in both suites, build, and local migration and route smoke tests. A local probe stored a nonzero trace ID; the local trace explorer showed the matching `api.probe` span and its child fetch/D1 spans.
- Release impact: trace comparison is implemented locally; live Cloudflare telemetry retrieval remains a production release gate and requires account-scoped secrets.
