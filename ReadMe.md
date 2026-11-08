# Edge API Observatory

A small synthetic diagnostics dashboard for learning Cloudflare Workers and D1. It measures the same approved sample API from two places: directly in the visitor's browser and through a Cloudflare Worker. The Worker records comparisons in D1, and the React dashboard shows recent latency, status, and error results.

![Dashboard preview](docs/dashboard-preview.png)

## What works now

- React + TypeScript + Vite dashboard, served with the Cloudflare Vite plugin.
- TypeScript Worker with `GET /api/targets`, `GET /api/probes`, and `POST /api/probes`.
- Two fixed JSONPlaceholder sample endpoints. The Worker never accepts an arbitrary destination URL.
- Browser-direct fetch and Worker-upstream fetch measured sequentially against the selected endpoint.
- D1 migration and recent-history table; median durations and Worker error rate for the selected endpoint.
- A simple history chart without a charting dependency.

The initial local comparison was verified in a browser: both paths returned HTTP 200 and the result appeared in the D1-backed history.

This is **synthetic testing**, not passive monitoring of an existing API's real traffic. Browser timings are client-reported. Direct browser tests can fail because of CORS, and a difference between browser-direct and Worker-proxied durations does not isolate Worker overhead. The Worker fetch timing includes reading the response body. Worker handler timing is measured internally but is not shown as a precise CPU measurement.

## Requirements

- Node.js 22 or newer
- npm
- A Cloudflare account only when deploying or creating the remote D1 database

## Run locally

```bash
npm install
npm run db:migrate:local
npm run dev
```

Open the URL printed by Vite. Local development uses a simulated D1 database. If the database is empty or the app reports a database error, apply the local migration again.

## Deploy

1. Create a D1 database named `edge-api-observatory` with Wrangler.
2. Replace `local-edge-api-observatory` in `wrangler.jsonc` with the database ID returned by Cloudflare.
3. Apply remote migrations with `npm run db:migrate:remote`.
4. Run `npm run deploy`.

The placeholder database ID is only for local development; a remote deployment needs a real ID. This project has not been deployed yet. Before making a public demo broadly available, add request rate limiting to the probe route to prevent excessive traffic or D1 writes.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Vite and Worker runtime |
| `npm run typecheck` | Check the React, Worker, and config TypeScript |
| `npm run build` | Typecheck and build the frontend/Worker |
| `npm run db:migrate:local` | Apply the D1 schema locally |
| `npm run db:migrate:remote` | Apply the D1 schema remotely |
| `npm run deploy` | Build and deploy to Cloudflare |

## Layout

```text
src/                 React dashboard and styles
worker/index.ts      Worker API and D1 access
shared/contracts.ts  Shared target list and data types
migrations/          Versioned D1 schema
vite.config.ts       React and Cloudflare Vite plugins
wrangler.jsonc       Worker, assets, and D1 binding
```

## Next improvements

Add a controlled test endpoint with configurable delay/error responses, request rate limiting, focused Worker tests, and optional Cloudflare traces. Keep this README in sync as those features are implemented.
