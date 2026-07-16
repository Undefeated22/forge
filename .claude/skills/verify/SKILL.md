---
name: verify
description: How to launch and drive the Forge API locally to verify changes end-to-end.
---

# Verifying Forge changes

Fastify API, cookie-based auth, Postgres via DATABASE_URL in `.env` (dev = Neon).

## Launch

```bash
PORT=5177 node --env-file=.env src/index.js   # in background; ready when /auth/login answers
```

## Drive

- Auth is **cookie-based**: capture `Set-Cookie` from `POST /auth/login` and replay as a `cookie` header. There is no Bearer token in responses.
- Route prefixes (src/app.js): `/auth`, `/org`, `/incidents`, `/reports`.
- Signup requires email verification before login. With no `RESEND_API_KEY`, the dev mailer prints every action link to stdout as `📧 <subject> → <email>\n<link>`; the token is the **last path segment** of the link (e.g. `/verify-email/<token>`). Same for invite and reset links.
- Fastify rejects requests with `content-type: application/json` and an empty body (400 FST_ERR_CTP_EMPTY_JSON_BODY) — omit the header on body-less DELETEs.
- Use `@test.local` emails with a timestamp; clean them (and their orgs/memberships/invitations/tokens) from the dev DB afterwards.

## Schema changes

drizzle migration snapshots are out of sync with the live schema, so `drizzle-kit generate`/`push` prompt interactively and can't be trusted. Write plain SQL in `drizzle/NNNN_*.sql` (with `--> statement-breakpoint` separators) and apply with:

```bash
node scripts/apply-sql.mjs drizzle/NNNN_name.sql   # uses DATABASE_URL, runs in a transaction
```

Remember prod (Railway internal Postgres) needs the same SQL applied separately, BEFORE deploying code that depends on it.
