# Commit and release log

Add an entry here **in each commit**. Record user-visible changes, verification, and release impact. This file is separate from the app's usage guide in `ReadMe.md`.

## Release status

**v0.1.0:** planned. The local prototype works; production D1, deployment, public verification, and the GitHub release remain open in `RELEASE_PLAN.md`.

## Commits

### 2026-11-07 — `feat: build Edge API Observatory starter` (`4da05da`)

- Added the React + Vite dashboard, TypeScript Worker API, D1 migration, approved sample targets, inline documentation, and setup guide.
- Verified a production build, local D1 migration, and a browser comparison with both paths returning HTTP 200.
- Release impact: establishes the local v0.1.0 prototype; no production deployment.

### 2026-11-07 — `docs: define initial release gates` (this commit)

- Added the release checklist and this commit/release log; future commits must update this log.
- Verified the existing repo state and Cloudflare/GitHub authentication status.
- Release impact: records the remaining work and external account gates without claiming a release.
