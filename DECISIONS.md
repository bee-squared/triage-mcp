# Decisions

Notable choices and departures from the PRD, newest first.

## 2026-10-29: Override better-sqlite3 to ^13.0.3

**Context:** evalite 0.19.0 (latest) depends on `better-sqlite3@^11.6.0`. Version 11.x has no prebuilt binaries for Node 26, and its C++ source does not compile against Node 26's V8 (`GetPrototype`, `GetIsolate` and `This` were removed). `pnpm i` fails, which blocks `pnpm eval`.

**Decision:** Force `better-sqlite3@^13.0.3` (supports Node >=22) through `overrides` in `pnpm-workspace.yaml`. Verified that it loads from evalite's resolution path and runs queries.

**Risk:** evalite is not tested against better-sqlite3 13. If evals fail with SQLite errors, look here first.

**Revisit when:** evalite ships a release that depends on better-sqlite3 >=12 with Node 26 support. Then remove the override.
