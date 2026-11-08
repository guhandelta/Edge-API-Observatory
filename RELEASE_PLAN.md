# Initial release plan

Target: **v0.1.0**, a public portfolio demo of synthetic browser-direct and Worker-upstream API comparisons.

## Release gates

- [x] React dashboard, Worker API, D1 migration, and fixed target allowlist exist.
- [x] Local comparison returned HTTP 200 on both paths and appeared in D1 history.
- [x] Bound request bodies and response reads; reject unexpected request content types.
- [x] Add Cloudflare rate limiting to the probe route and verify its 429 response in a Worker test.
- [x] Add automated Worker tests covering validation, storage, and error paths.
- [x] Run typecheck, tests, build, local migration verification, and browser smoke test with persistence after refresh.
- [ ] Create the production D1 database and replace the placeholder database ID.
- [ ] Apply the remote migration, deploy the Worker, and verify the public URL from a browser.
- [ ] Tag `v0.1.0` and publish release notes after the deployment is verified.

## Operational steps for deployment

1. Authenticate Wrangler with the intended Cloudflare account. The current Wrangler login is expired.
2. Create D1 database `edge-api-observatory`, update `wrangler.jsonc` with its returned ID, and commit that configuration change.
3. Apply remote migrations and deploy. Confirm the Worker, D1 binding, and static assets are present.
4. Run one public comparison, refresh the page, and confirm the result persists. Verify a rejected input and a rate-limited request.
5. Update `ReadMe.md` with the live URL and `RELEASE_LOG.md` with the exact release outcome; commit and push them.
6. Create and push the `v0.1.0` tag, then publish a GitHub release describing the feature set and measurement limits.

Do not describe v0.1.0 as released until the remote smoke test and tag are complete. The GitHub CLI token is currently invalid; Git push still works through the configured Git credential helper.
