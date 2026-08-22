# AGENTS.md

Local AI routing gateway (`/v1/*` OpenAI-compatible) + Next.js dashboard. Plain JavaScript (ESM), **no TypeScript**. `@/*` → `src/*`, `open-sse` → `./open-sse` (jsconfig.json).

Read first:
- `CLAUDE.md` — full commands, architecture, request flow, persistence notes.
- `open-sse/AGENTS.md` — **required before editing anything under `open-sse/`** (translator/executor/provider conventions).
- `tests/translator/AGENTS.md` — translator test conventions, known bugs (`it.fails` list).

## Commands

```bash
npm install
npm run dev            # next dev, port 20127 (scripts hardcode it; deploy uses PORT=20128)
npm run build          # next build --webpack
npx eslint .           # lint (eslint.config.mjs, eslint-config-next)
```

CLI package (`cli/`, published separately as `9router`): `npm run cli:pack` from root.

## Tests — non-obvious

`tests/` is an **independent** ESM package, not wired to root `npm test`:

```bash
npm install                  # root deps FIRST (tests import src/ which needs open, undici, …)
cd tests && npm install      # vitest
npx vitest run               # all; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file, path relative to tests/
```

- Ignore `tests/package.json` `test` script — hardcodes Unix `/tmp` paths, broken on Windows. Use `npx vitest` form.
- **Suite is NOT all-green on plain checkout** (~938 pass, ~64 fail). Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run. Expected red: `tests/__baseline__/known-fails.txt`, `unit/embeddings.cloud.test.js` (imports `cloud/` dir not in this repo), `unit/xai-oauth-service.test.js` (network timeout), `real/*.real.test.js` (live provider calls, need creds).
- After touching provider registry / alias logic: run `tests/__baseline__/verify-*.mjs` (snapshots committed).
- Translator tests calling `translateRequest`/`translateResponse` MUST `import "./registerAll.js"` — `translator/index.js` uses `require()` which silently no-ops under vitest/ESM → empty registry → false pass.

## Gotchas

- New translator file MUST be imported in `open-sse/translator/index.js` (self-registration via import side effect) or it never runs.
- `open-sse/providers/registry/index.js` is **auto-generated** — regenerate with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, never hand-edit.
- Persistence is SQLite (`src/lib/db/`), NOT `db.json`. Import from `@/lib/db/index.js`; `src/lib/localDb.js` is a compat shim. Adapter chain: `bun:sqlite` → `better-sqlite3` (optional dep, deliberately) → `node:sqlite` → `sql.js`.
- `custom-server.js` derives client IP from TCP socket and strips untrusted `X-Forwarded-For` (trusts forwarding headers only from loopback proxy). Preserve when touching request/IP/rate-limit code.
- `open-sse/rtk/` hooks mutate request body in-place and are **fail-open** — never throw out of them.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) are handled inside their executors, not the translator.
- Security env: `JWT_SECRET`, `INITIAL_PASSWORD` (default `123456`, must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Contract in `.env.example`.

## Conventions

- Conventional Commits (`fix(translator): …`). Root and `cli/` versioned independently; log changes in `CHANGELOG.md`.
- Config-driven: never hardcode provider/model/role/block strings — use `open-sse/config/` + `open-sse/translator/schema/` constants.
