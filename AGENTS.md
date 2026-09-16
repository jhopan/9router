# AGENTS.md

PanRouter — local AI routing gateway (`/v1/*` OpenAI-compatible) + Next.js dashboard. Plain JavaScript (ESM), **no TypeScript**. `@/*` → `src/*`, `open-sse` → `./open-sse` (jsconfig.json).

## Project identity — PanRouter is the primary project

**PanRouter is ours, and it is what we develop, ship, and sell.** Everything in this repo is PanRouter.

- **Upstream `decolua/9router` is a read-only REFERENCE, not a parent to keep parity with.** Read it, borrow ideas and fixes from it, never push to it. Direction of travel is one way: 9router → reference material; PanRouter → development.
- **Version is INDEPENDENT.** PanRouter does NOT track upstream's version number, and is never "behind" or "ahead" in that sense. It versions on its own cadence, driven by our own work (see `CHANGELOG.md`): new providers (FreeBuff, AgentRouter, B.AI), the per-key prepaid token pool, per-provider quota windows, our release pipeline. Bump it when we ship something — that is the whole rule.
- **Syncing from upstream is optional and judged on merit.** Take what helps, skip what doesn't. There is no obligation to stay mergeable and no requirement that any number match theirs.
- **Internal identifiers stay `9router` on purpose** — install paths (`~/.9router`), DB names, salt shapes, package internals. Those are disk/wire compatibility, not branding: existing installs and databases depend on them. Do NOT "fix" them to `panrouter`.
- **What is ours alone** (upstream has none of it): the FreeBuff executor + session pool, the AgentRouter translate layer, per-key prepaid token pools (`apiKeyLimits.js`), per-provider quota windows, router-side parked-quota rows, GitHub-Releases distribution, and the added `tests/unit/` coverage.

Read first:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model, env matrix.
- `open-sse/AGENTS.md` — **required before editing anything under `open-sse/`** (translator/executor/provider conventions).
- `tests/translator/AGENTS.md` — translator test conventions, known bugs (`it.fails` list).

This repo deliberately keeps **one** agent-context file: `AGENTS.md` (+ the two nested ones above). There is no `CLAUDE.md` and no second copy to drift out of sync — extend this file instead.

## Commands

```bash
cp .env.example .env            # env contract (JWT_SECRET, INITIAL_PASSWORD, PORT=20128, …)
npm install
npm run dev            # next dev, port 20127 (scripts hardcode it; deploy uses PORT=20128)
npm run build          # next build --webpack
npm run start          # prod: node custom-server.js (port 20127; deploy sets PORT=20128 HOSTNAME=0.0.0.0)
npx eslint .           # lint (eslint.config.mjs, eslint-config-next)

# Bun variants of the same three: dev:bun / build:bun / start:bun
```

CLI package (`cli/`, published separately as `panrouter`; installs and updates pull the tgz from GitHub Releases — see `UPDATER_CONFIG` in `src/shared/constants/config.js`): `npm run cli:pack` from root.

## Tests — non-obvious

`tests/` is an **independent** ESM package, not wired to root `npm test`:

```bash
npm install                  # root deps FIRST (tests import src/ which needs open, undici, …)
cd tests && npm install      # vitest
npx vitest run               # all; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file, path relative to tests/
```

- Ignore `tests/package.json` `test` script — hardcodes Unix `/tmp` paths, broken on Windows. Use `npx vitest` form.
- **Suite is NOT all-green on plain checkout** (≈2450 pass, ≈48 fail). Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run. Expected red: `tests/__baseline__/known-fails.txt`, `unit/embeddings.cloud.test.js` (imports `cloud/` dir not in this repo), `unit/xai-oauth-service.test.js` (network timeout), `real/*.real.test.js` (live provider calls, need creds).
- After touching provider registry / alias logic: run `tests/__baseline__/verify-*.mjs` (snapshots committed).
- Translator tests calling `translateRequest`/`translateResponse` MUST `import "./registerAll.js"` — `translator/index.js` uses `require()` which silently no-ops under vitest/ESM → empty registry → false pass.

## Request flow (understand this first)

```
src/app/api/v1/*            (next.config.mjs rewrites /v1/* → /api/v1/*)
  → src/sse/handlers/chat.js        parse, combo expansion, account-selection loop
    → open-sse/handlers/chatCore.js  detect source format, translate request,
                                       dispatch to executor, retry/refresh, stream setup
      → open-sse/executors/*         per-provider upstream call (default.js = any OpenAI-compatible)
      → open-sse/translator/*        client format ↔ provider format
        → SSE back to client
```

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

## Translators, registry, persistence

- **Translator engine** pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop — prefer one for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- **Provider registry**: one file per provider; `providers/registry/index.js` is auto-generated (see Gotchas). Add a provider by copying `providers/REGISTRY_TEMPLATE.js` + adding models to `config/providerModels.js`; only non-OpenAI-compatible upstreams need an executor.
- **Persistence is SQLite, not `db.json`** (ARCHITECTURE.md is stale on this). `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep, deliberately, so install never needs build tools) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS, always works); `src/lib/localDb.js` is a backward-compat shim re-exporting `@/lib/db/index.js` — new code imports the latter, per-entity logic lives in `src/lib/db/repos/*`. DB path resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`). Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.
- **RTK token saver** (`open-sse/rtk/`) compresses `tool_result` content in place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of a hook. It skips `is_error` / `status:"error"` results to preserve traces.

## Gotchas

- New translator file MUST be imported in `open-sse/translator/index.js` (self-registration via import side effect) or it never runs.
- `open-sse/providers/registry/index.js` is **auto-generated** — regenerate with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, never hand-edit.
- `custom-server.js` derives client IP from TCP socket and strips untrusted `X-Forwarded-For` (trusts forwarding headers only from loopback proxy). Preserve when touching request/IP/rate-limit code.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) are handled inside their executors, not the translator.
- Security env: `JWT_SECRET`, `INITIAL_PASSWORD` (default `123456`, must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Contract in `.env.example`.

## Conventions

- Conventional Commits (`fix(translator): …`). Root and `cli/` are versioned independently of each other **and of upstream** (see Project identity); log changes in `CHANGELOG.md`.
- Config-driven: never hardcode provider/model/role/block strings — use `open-sse/config/` + `open-sse/translator/schema/` constants.

### Git workflow (mandatory)

- **Commit + push every change** immediately (`git add -A && git commit -m "…" && git push`) so any error can be reverted (git reset/revert) and other machines can `git pull`.
- Before a risky change: make sure working tree is clean so a broken edit can be rolled back with `git checkout .`.
- Push to **our** repo `jhopan/PanRouter` — the primary project. Never push to upstream `decolua/9router`; it is a read-only reference (see Project identity above).

### Remote servers (mandatory)

- **NEVER modify anything on remote servers (VPS neva, Render dashboard config, etc.) — local edits only.** No crontab changes, no config edits, no file writes, no service restarts on remotes unless the user explicitly asks for THAT exact change first. Investigation/read-only SSH is fine; mutation is not.

### AgentRouter (provider + translate layer)

- Provider: `agentrouter` — Anthropic-compatible relay, baseUrl `https://agentrouter.org/v1/messages`, auth `x-api-key`, aliases `AR`/`ar`. Model prefix `AR/<model>`.
- Translate-in (`open-sse/translator/concerns/agentrouterTranslate.js`) runs in `chatCore.js` before dispatch — translates user turns ID→EN. Translate-out (`agentrouterResponseTranslate.js`) runs in `chatCore/streamingHandler.js` — translates response EN→ID, strips preamble, pass-through tool_use/tool_result.
- **Both are fail-open** — a translate error must never break the request. Only for `provider === "agentrouter"`; guard keeps other providers untouched.
- Translate uses the local `translate` combo (self-invoke `/v1/chat/completions` with a key from `getApiKeys`). AgentRouter only accepts Mandarin/English/French/German/Russian.
- **AgentRouter rejects synthetic `type:"custom"` tool objects** — `chatCore.js` skips `defaultClaudeToolType` for this provider; `default.js` also strips first-party Claude-CLI beta headers for it (see skill 9router-development for the full story).
- Streaming gate: body MUST carry `stream:true` or the upstream answers `text/plain` non-SSE and PanRouter blocks it (`upstream non-SSE: 200`).

### FreeBuff (native provider — Codebuff free-tier models)

- Provider: `freebuff` — aliases `fb`/`FB`/`freebuff`. baseUrl `https://www.codebuff.com/api/v1/chat/completions` (OpenAI shape). Models: `deepseek/deepseek-v4-flash`, `z-ai/glm-5.3-flash`, `mimo/mimo-v2.5`, `openai/gpt-5.6-luna`, `minimax/minimax-m3` (+ passthrough). Full detail: `docs/plans/2026-09-04-freebuff-provider.md` and skill `9router-development`.
- **Dual auth**: browser login (OAuth device-polling — `src/lib/oauth/providers/freebuff.js`, `flowType: "device_code"`, no callback URL; fingerprint `enhanced-<43b64url>` binds the poll so login can happen on ANY device) OR paste token (CLI `authToken` from `~/.config/manicode/credentials.json`; grab with `scripts/kiro-token-grab.mjs` style — actually FreeBuff: read that file's `default.authToken`).
- **Executor** (`open-sse/executors/freebuff.js`) — ported from OmniRoute + upgraded with freebuff-proxy techniques. Non-obvious:
  - **Session pool is per `token::model`** — upstream binds one session to one model; switching models on the same session = `409 session is bound to X`.
  - `409` handling: first 409 → honest rotate (FINISH) + re-handshake + retry once; second 409 = account-level conflict ("another instance taken over" — a stale server-side instance, e.g. from the standalone freebuff-proxy era, still holds the account).
  - `429` → in-memory token cooldown + structured error → PanRouter account-fallback switches to the next FreeBuff connection automatically (drain, **never round-robin** — farm-detection).
  - Honest run lifecycle: START once per session, FINISH only on rotate/403; stable 13-char base36 client_id from machine hash; per-endpoint UA (`Bun/1.3.14` session, `ai-sdk/.../codebuff` chat); handshake jitter ±200ms.
- **Region reality**: Indonesian egress = `accessTier: limited` — `glm-5.3-flash`/`luna` are coerced/blocked (`country_not_allowed`), but **`deepseek-v4-flash` + `mimo-v2.5` serve 200** with 6 quota sessions/day each (reset Pacific midnight = 07:00 WIB). 1 quota session = a 1-hour admission block (all chats inside it share the claim) — session pooling is what keeps usage inside one claim.
- Old chat payload from a previous model can poison the session — if a request 409s twice in a row, wait for the server-side instance to expire (~1h) or re-login.

### Kiro (token import + suspension triage)

- Token sources: Kiro IDE → `~/.aws/sso/cache/kiro-auth-token.json` (auto-imported by `KiroAuthModal`); Kiro CLI → `%LOCALAPPDATA%/Kiro-Cli/data.sqlite3` → `auth_kv["kirocli:social:token"]` (snake_case fields). Grabber: `scripts/kiro-token-grab.mjs` (`--print` pipes the refresh token; CLI first via builtin `node:sqlite`, better-sqlite3 fallback, IDE last).
- Suspension triage: `invalid_grant` refresh spam = dead refresh token (re-login fixes). `403 "User ID temporarily suspended"` with a SUCCESSFUL refresh = account-level API lock (re-login does NOT fix — swap account or wait).
- `KiroAuthModal` also has "From Kiro CLI"/"From Kiro IDE" buttons that reveal OS-aware one-line grab commands for remote servers (PowerShell `curl.exe`+`;`, bash `&&`).

### B.AI (provider)

- `bai`/`BAI` alias, OpenAI-compatible `https://api.b.ai/v1/chat/completions`, Bearer key. Catalog auto-arrives once a connection exists (`BAI/glm-5.3-flash` etc.). Credit-based — `insufficient_user_quota` means top-up. Caps (vision/reasoning) resolve via the standard 4-layer capabilities lookup.


