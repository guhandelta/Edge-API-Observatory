# Initial release plan

Target: **v0.1.0**, a public portfolio demo of synthetic browser-direct and Worker-upstream API comparisons.

## Release gates

- [x] React dashboard with batch median comparison, latency chart, status breakdown, success rate, and recent runs; Worker API, D1 migrations, individual mode-aware history, and fixed target allowlist exist.
- [x] Local comparison returned HTTP 200 on both paths and appeared in D1 history.
- [x] Bound request bodies and response reads; reject unexpected request content types.
- [x] Add Cloudflare rate limiting to the probe route and verify its 429 response in a Worker test.
- [x] Add automated Worker tests covering validation, storage, and error paths.
- [x] Enforce 100% per-file statements, branches, functions, and lines for production TypeScript in Worker and UI suites; run the gate in CI.
- [x] Add controlled success, delay, and error fixtures; verify all three Worker probe paths and a browser comparison against the error fixture locally.
- [x] Document a controlled-delay investigation with measured batches, an architecture diagram, and screenshots.
- [x] Run typecheck, tests, build, local migration verification, and browser smoke test with persistence after refresh.
- [ ] Create the production D1 database and replace the placeholder database ID.
- [ ] Apply the remote migration, deploy the Worker, and verify the public URL from a browser.
- [ ] Tag `v0.1.0` and publish release notes after the deployment is verified.

## Operational steps for deployment

1. Install locked project dependencies with `npm ci`, then authenticate the **project-local** Wrangler with the intended Cloudflare account. A bare global `wrangler` command is unnecessary. The current Wrangler login is expired; use `npx wrangler login --device` to avoid the localhost callback timeout.
2. Create D1 database `edge-api-observatory`, update `wrangler.jsonc` with its returned ID, run `npm run types`, and commit that configuration change.
3. Apply remote migrations and deploy. Confirm the Worker, D1 binding, rate-limit binding, and static assets are present.
4. Run one public comparison, refresh the page, and confirm the result persists. Verify the controlled success, delay, and HTTP 503 cases through the dashboard and check Worker self-fetch on the deployed URL. Verify a rejected input. The rate-limit test covers the 429 path; the live limit is approximate, so a fixed number of requests is not a reliable assertion.
5. Update `ReadMe.md` with the live URL and `RELEASE_LOG.md` with the exact release outcome; commit and push them.
6. Create and push the `v0.1.0` tag, then publish a GitHub release describing the feature set and measurement limits.

Do not describe v0.1.0 as released until the remote smoke test and tag are complete. The GitHub CLI token is currently invalid; Git push still works through the configured Git credential helper.

### Exact deployment commands

Run these from the repository root after Cloudflare sign-in. Substitute the returned D1 UUID into `wrangler.jsonc` before the migration.

```bash
npm ci
npx wrangler login --device
npx wrangler whoami
npx wrangler d1 create edge-api-observatory
npm run types
npm run typecheck
npm run test
npm run build
npm run db:migrate:remote
npm run deploy
```

Then open the printed `*.workers.dev` URL and run a comparison. Refresh to confirm the history persists. A basic API rejection check is:

```bash
curl -i -X POST "https://YOUR-WORKER.workers.dev/api/probes" \
  -H 'Content-Type: application/json' \
  --data '{"targetId":"unapproved","directDurationMs":null,"directStatus":null,"directError":null}'
```

Expected result: HTTP 400 with an error message and no upstream probe. After recording the live URL and pushing the final documentation commit, create the tag:

```bash
git tag -a v0.1.0 -m "Edge API Observatory v0.1.0"
git push origin main
git push origin v0.1.0
```

Publish the release from GitHub's Releases page if the GitHub CLI is still unauthenticated. Use the release draft in `RELEASE_LOG.md` as the description.
