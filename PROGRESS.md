# Phoenix — Progress

Status legend: `[ ]` not started · `[~]` in progress · `[x]` complete & verified

Verification gate for every phase: `pnpm typecheck && pnpm lint && pnpm test` all green,
then a commit, then an entry in this file.

---

## Phase 1 — Monorepo + core schemas `[x]`

| Item | Status |
|---|---|
| git repo, pnpm workspace, strict tsconfig, eslint, prettier | `[x]` |
| `PLAN.md` with measured environment + ADRs | `[x]` |
| `packages/shared` — Zod contracts (tasks, results, artifacts, events, evidence) | `[x]` |
| `packages/config` — env parsing, limits, DB URLs | `[x]` |
| `packages/llm` — provider interface, OpenAI-compatible client, structured completion, mock | `[x]` |
| `packages/artifact-store` — content-addressed store + index | `[x]` |
| `packages/execution-sandbox` — controlled command execution + logging | `[x]` |
| `packages/repository-tools` — tool layer + per-role permissions | `[x]` |
| Tests: schema round-trips, permission enforcement, sandbox logging, mock provider | `[x]` 172 tests |

Verified 2026-09-30: `pnpm typecheck` clean, `pnpm lint` clean, 172 tests pass across
`shared` (47), `llm` (47), `repository-tools` (47), `artifact-store` (18), `execution-sandbox` (13).
Commit `2f59034`.

Security properties that are enforced in code, not in prompts: role→tool allowlists, per-task
tool-call budgets, zod argument contracts, canonicalised path scoping (symlink escape refused),
argv-only command execution against an anchored pattern allowlist, env scrubbing, HTTP target
allowlist, read-only SQL (`BEGIN TRANSACTION READ ONLY` + statement guard). Every invocation,
denial and failure is recorded as a `ToolInvocation`.

## Phase 2 — Legacy bank `[x]`

| Item | Status |
|---|---|
| `examples/legacy-bank` builds and runs (Maven, JDK 17, Java 8 language level) | `[x]` |
| PostgreSQL schema with DB-side behavior (triggers/functions) | `[x]` |
| Endpoints: accounts, ledger, transfers, fees, settlement, reconciliation, history | `[x]` |
| Real legacy quirks, undocumented in-repo | `[x]` |
| `benchmarks/legacy-bank/ground-truth.json` (outside the repo Phoenix receives) | `[x]` |
| Discovery-quality scoring script | `[x]` |

Independently verified 2026-09-30 (clean rebuild, not the builder's own report):
`mvn -DskipTests package` from a wiped `target/` → `corebank-legacy-0.9.3.jar`; `db/reset.sh`
drops the schema; `run.sh` replays V1..V3 and reaches `/health`; `benchmarks/legacy-bank/probe.sh`
→ **86 passed, 0 failed** against all 16 ground-truth behaviors (LB-001..LB-016).
Grep of the example sources for `phoenix|secret rule|ground truth|hidden behavior` → no matches,
so no hint leaks into the repository Phoenix is given. `target/` and `logs/` are gitignored.

## Phase 3-4 — Runtime + Archaeologist `[ ]`

## Phase 5-6 — Rules, invariants, evidence, characterization `[ ]`

## Phase 7-8 — Architect, Modernizer, differential engine `[ ]`

## Phase 9 — Adversary + repair loop `[ ]`

## Phase 10 — Verification + Release Guardian `[ ]`

## Phase 11-12 — API, worker, dashboard, CLI, docs, hardening `[ ]`

---

## Environment notes (measured 2026-09-30)

* Node v23.11.0, pnpm 12.4.2, TypeScript 5.7.x
* PostgreSQL 16.15 running locally (`:5432`) — Docker is **not** installed, so the demo runs
  natively; compose files are still provided (ADR-1).
* Maven 3.9.16 + Zulu JDK 17 installed for the legacy bank (ADR-2).
* No Qwen credentials in the environment. A local Ollama OpenAI-compatible endpoint
  (`http://localhost:11434/v1`, models `llama3.2`, `mistral`, `deepseek-r1`) is used to
  validate the generic provider path end-to-end (ADR-7). Swapping to Qwen is env-only.

## Known limitations

*(updated at every phase boundary)*
