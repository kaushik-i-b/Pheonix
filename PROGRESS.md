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

## Phase 3-4 — Runtime + Archaeologist `[~]`

| Item | Status |
|---|---|
| `packages/legacy-analysis` — deterministic walk, language detection, endpoints, SQL, crons, dependency edges, suspicious-code scan | `[x]` 34 tests |
| `packages/agent-runtime` — agent loop, structured final answers with schema repair retries, host-side read-before-answer enforcement, quote anchoring against real file bytes, transcript/tool-log/result artifacts | `[x]` 49 tests |
| `prompts/` — versioned prompt packs per role, persisted with content hash | `[x]` |
| Archaeologist run over `examples/legacy-bank` with the mock provider | `[x]` (legacy-bank-discovery.test.ts) |
| Archaeologist run live (Qwen via Ollama) producing schema-valid findings | `[x]` run `run_bf33e2433f0b4c5b94398dac87ba578b`, acceptance 9/9 |

Commit `79e23ea` covers deterministic discovery analysis. The runtime and the live-run fixes
are uncommitted pending the slice.

## Phase 5-6 — Rules, invariants, evidence, characterization `[~]`

| Item | Status |
|---|---|
| SPECIFY: business-rule + invariant derivation from discovery findings, every rule citing legacy evidence | `[x]` implemented, 10 tests |
| SPECIFY: live run | `[~]` blocked — bounded retry task `task_30db406647bb445787820cf036803700` ended PARTIAL at 8/10: two rules validated, but the sole proposed invariant was demoted after its citation could not be anchored; partial artifacts exist but are not a successful predecessor |
| CHARACTERIZE: scenario proposal (LLM) + capture against the live legacy system; recorded outputs become baselines | `[x]` implemented, `packages/characterization` 78 tests + 13 orchestrator tests |
| CHARACTERIZE: live baselines from the running legacy-bank | `[ ]` blocked by non-successful SPECIFY; not started on this lineage |
| Evidence graph package | `[ ]` deferred — evidence edges exist inside artifacts; the dedicated graph is post-slice |

## Phase 7-8 — Modernizer, differential engine `[~]`

| Item | Status |
|---|---|
| MODERNIZE: minimal modern implementation generated into a clean workspace, persisted verbatim with a host-owned launcher | `[x]` 6 repair-loop tests |
| Differential comparator: normalization only for explicitly configured nondeterministic fields; mismatch records carry scenario / legacy / modern / rule / invariant / evidence | `[x]` `packages/differential-testing` 31 tests |
| Live run | `[ ]` blocked by failed SPECIFY; not started on this lineage |

## Phase 9 — Adversary + repair loop `[~]`

| Item | Status |
|---|---|
| Repair loop: DIAGNOSE → repair brief → MODERNIZE (patch only the modern side) → RE-VERIFY, bounded by `MAX_REPAIR_ITERATIONS`, progress monotonic | `[x]` implemented; repair-loop test drives a real half-even→half-up divergence to EQUIVALENT with a real-Node probe over the written bytes |
| CLI: `phoenix discover|specify|characterize|modernize`, exit code 0 iff final verdict EQUIVALENT | `[x]` |
| The genuine-mismatch live loop (required by the slice) | `[ ]` blocked by failed SPECIFY; not started on this lineage |
| Adversarial testing package | `[ ]` deferred (post-slice) |

## Phase 10 — Verification + Release Guardian `[ ]`

Deferred until the vertical slice passes. Verdicts are already computed deterministically by
the differential verifier; the Release Guardian and release decisions come after.

## Phase 11-12 — API, worker, dashboard, docs `[ ]`

Deferred by strategy: no dashboard, UI, worker infrastructure, elaborate APIs, distributed
execution, production deployment, advanced observability or sophisticated persistence until
the slice runs end to end.

---

## Verification (2026-10-03, current tree)

* `pnpm build`, `pnpm typecheck`, focused ESLint, Prettier check and `git diff --check` exit 0.
* Focused output-contract regressions: 67 tests pass across `llm`, `agent-runtime` and
  `orchestrator`, including malformed invariant-confidence rejection and corrected acceptance.
* The previously recorded full suite remains **447 tests green** across 11 packages: shared 47,
  config 10, artifact-store 18, legacy-analysis 34, execution-sandbox 13, llm 56,
  characterization 78, repository-tools 48, differential-testing 31, agent-runtime 49,
  orchestrator 63.
* Orchestrator integration tests run the real thing: hermetic temp workspaces, live HTTP
  stubs for both legacy and modern sides, scripted model answers through the real agent
  loop/persister, and an independent reimplementation of the fee contract as the oracle.
* The earlier live SPECIFY retry task `task_84d861fc64f54db7873c142990ee023a` exited 1 because a
  fabricated `deposit` method citation failed byte-level resolution and emitted no specification artifacts.
* After citation-repair hardening, bounded retry task `task_30db406647bb445787820cf036803700`
  also exited 1 after 524.7 seconds and four model calls. It validated two rules and their citations,
  but the sole invariant citation remained unanchored through the repair budget and was demoted.
  Acceptance was 8/10; its partial artifacts are preserved but cannot satisfy the successful-predecessor gate.

## Environment notes (measured 2026-09-30, updated 2026-10-03)

* Node v23.11.0, pnpm 12.4.2, TypeScript 5.7.x
* PostgreSQL 16.15 running locally (`:5432`) — Docker is **not** installed, so the demo runs
  natively; compose files are still provided (ADR-1).
* Maven 3.9.16 + Zulu JDK 17 installed for the legacy bank (ADR-2).
* Real model: dedicated `ollama serve` on `http://localhost:11435/v1` with
  `OLLAMA_CONTEXT_LENGTH=32768`, model `qwen2.5-coder:7b-instruct`, reached through the same
  OpenAI-compatible provider that hosted Qwen uses (ADR-7).
* `examples/legacy-bank` runs on `:8080` against local PostgreSQL (`/health` → UP).

## Known limitations

*(updated at every phase boundary)*

* The vertical slice has not completed a fully live run. DISCOVER succeeded, but the latest SPECIFY
  task is PARTIAL: two evidence-backed rules survived while its only proposed invariant was demoted
  after bounded citation repair could not anchor the model's oversized source quote. No successful
  specification predecessor exists, so CHARACTERIZE and all later live stages remain unstarted.
* `LLM_OUTPUT_TRUNCATED` handling has no dedicated tests yet.
