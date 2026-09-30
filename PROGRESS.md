# Phoenix — Progress

Status legend: `[ ]` not started · `[~]` in progress · `[x]` complete & verified

Verification gate for every phase: `pnpm typecheck && pnpm lint && pnpm test` all green,
then a commit, then an entry in this file.

---

## Phase 1 — Monorepo + core schemas `[~]`

| Item | Status |
|---|---|
| git repo, pnpm workspace, strict tsconfig, eslint, prettier | `[x]` |
| `PLAN.md` with measured environment + ADRs | `[x]` |
| `packages/shared` — Zod contracts (tasks, results, artifacts, events, evidence) | `[ ]` |
| `packages/config` — env parsing, limits, DB URLs | `[ ]` |
| `packages/llm` — provider interface, OpenAI-compatible client, structured completion, mock | `[ ]` |
| `packages/artifact-store` — content-addressed store + index | `[ ]` |
| `packages/execution-sandbox` — controlled command execution + logging | `[ ]` |
| `packages/repository-tools` — tool layer + per-role permissions | `[ ]` |
| Tests: schema round-trips, permission enforcement, sandbox logging, mock provider | `[ ]` |

## Phase 2 — Legacy bank `[~]`

| Item | Status |
|---|---|
| `examples/legacy-bank` builds and runs (Maven, JDK 17, Java 8 language level) | `[ ]` |
| PostgreSQL schema with DB-side behavior (triggers/functions) | `[ ]` |
| Endpoints: accounts, ledger, transfers, fees, settlement, reconciliation, history | `[ ]` |
| Real legacy quirks, undocumented in-repo | `[ ]` |
| `benchmarks/legacy-bank/ground-truth.json` (outside the repo Phoenix receives) | `[ ]` |
| Discovery-quality scoring script | `[ ]` |

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
