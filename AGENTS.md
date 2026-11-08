# Project maintenance notes

- Keep `ReadMe.md` accurate whenever behavior, setup, routes, configuration, or deployment steps change.
- Add concise inline documentation to all new or changed TypeScript modules, exported types, functions, and non-obvious timing or security logic. Explain purpose and measurement limits rather than narrating obvious syntax.
- Keep the target allowlist fixed unless a safe destination-validation and abuse-control design is implemented.
- Verify `npm run typecheck`, `npm run build`, and affected local API routes after changes.
