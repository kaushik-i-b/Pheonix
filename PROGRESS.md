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
| `packages/agent-runtime` — agent loop, structured final answers with schema repair retries, host-side read-before-answer enforcement, quote anchoring against real file bytes, transcript/tool-log/result artifacts | `[x]` 50 tests |
| `prompts/` — versioned prompt packs per role, persisted with content hash | `[x]` |
| Archaeologist run over `examples/legacy-bank` with the mock provider | `[x]` (legacy-bank-discovery.test.ts) |
| Archaeologist run live (Qwen via Ollama) producing schema-valid findings | `[x]` run `run_bf33e2433f0b4c5b94398dac87ba578b`, acceptance 9/9 |
| Second live Archaeologist lineage, used as the SPECIFY predecessor | `[x]` run `run_1ad5681e13294219959c3908022799c5`, task `task_47614a38d04a415692c7566beb09815a`, acceptance 9/9, 3 findings, 0 verify problems |

Commits `79e23ea` and `0b35a4d` cover deterministic discovery analysis and the pipeline spine. The
runtime and citation-gate fixes described below are uncommitted pending the slice.

## Phase 5-6 — Rules, invariants, evidence, characterization `[~]`

| Item | Status |
|---|---|
| SPECIFY: business-rule + invariant derivation from discovery findings, every rule citing legacy evidence | `[x]` implemented, 10 tests |
| SPECIFY: live run | `[x]` lineage `run_1ad5681e13294219959c3908022799c5`, task `task_d326ab378f4940e89d81420f1dc9ae2b`, acceptance 10/10. Earlier failures on this lineage are preserved |
| CHARACTERIZE: scenario proposal (LLM) + capture against the live legacy system; recorded outputs become baselines | `[x]` implemented, `packages/characterization` 78 tests + 13 orchestrator tests |
| CHARACTERIZE: live baselines from the running legacy-bank | `[x]` task `task_378ff718bd1741d0ac6b5360a3da01c5`, 10/10 passing-against-legacy, 662 assertions. An earlier suite on this lineage captured HTTP 500s and is preserved, not used |
| Evidence graph package | `[ ]` deferred — evidence edges exist inside artifacts; the dedicated graph is post-slice |

The 2026-10-04 diagnosis below is historical. The 2026-10-05 run on this same lineage
succeeded; see "Live slice (2026-10-05)". `requireSuccessfulPredecessor` follows the latest
successful result and the latest artifact of each kind, so later attempt-suffixed artifacts
unblocked CHARACTERIZE without deleting these failures.

The 2026-10-04 SPECIFY attempt was bounded in advance at 8 model calls (`--max-steps 8`), a
1500 s stage deadline (`STAGE_TIMEOUT_MS`, inside the configured 2700 s) and exactly one attempt.
It used 6 model calls, 12 tool calls (all `read_file`), 0 denied, 637.6 s and 117 279 tokens
(100 304 prompt + 16 975 completion). Per the stop-and-diagnose rule no second attempt was made.
An earlier SPECIFICATION task on the same lineage, `task_3a29885d37414bd49ea83e5b2dd780d8`, is
preserved as FAILED at 0/10 — it emitted no specification artifacts at all. Both results are kept
for diagnosis; neither can satisfy the successful-predecessor gate.

Artifacts from the bounded attempt:
`artifacts/run_1ad5681e13294219959c3908022799c5/specification/business-rules.json`
(`art_fee26ce919b0ae37d4683a36ecae1399911aa11279c96c3a3d6d95af13603f11`, 7271 bytes, 1 rule + 9
unknowns) and `.../specification/invariants.json`
(`art_1db07f6fa840ae19bdfef33642349e3c6644dca1f00b7d15280a85b046d42b80`, 1752 bytes, 0 invariants).
Event stream: `.../run/events.jsonl`.

Diagnosis: the model invented `svc/AccountSvc.java` and `svc/ReconciliationSvc.java` for the real
`AcctSvc.java` and `ReconSvc.java`, which killed 4 of 5 invariants and 3 rules. The rejection for a
missing path was the only non-actionable one the checker emits — `elsewhereHint` and `lineWindow`
both need a readable file, so the branch `continue`d after five words. The model then resubmitted a
byte-identical 12 794-character answer four times (agent steps 30, 39, 44, 49), each rejected the
same way. Its whole tool budget was 12 `read_file` calls and nothing else: it never used the
`list_files` or `search_repository` tools it is granted and told about, which is how it stayed wrong
about the file names. Exhaustion degraded honestly: citations were dropped rather than accepted,
three rules were demoted to unknowns, and the stage reported PARTIAL with 2 unsatisfied criteria
instead of claiming success.

## Phase 7-8 — Modernizer, differential engine `[x]`

| Item | Status |
|---|---|
| MODERNIZE: minimal modern implementation generated into a clean workspace, persisted verbatim with a host-owned launcher | `[x]` 6 repair-loop tests |
| Differential comparator: normalization only for explicitly configured nondeterministic fields; mismatch records carry scenario / legacy / modern / rule / invariant / evidence | `[x]` `packages/differential-testing` 31 tests |
| Live run | `[x]` final verdict EQUIVALENT after one repair (`task_041af08b84be4b89839494f2a12d53fb`) |

## Phase 9 — Adversary + repair loop `[~]`

| Item | Status |
|---|---|
| Repair loop: DIAGNOSE → repair brief → MODERNIZE (patch only the modern side) → RE-VERIFY, bounded by `MAX_REPAIR_ITERATIONS`, progress monotonic | `[x]` implemented; repair-loop test drives a real half-even→half-up divergence to EQUIVALENT with a real-Node probe over the written bytes |
| CLI: `phoenix discover|specify|characterize|modernize`, exit code 0 iff final verdict EQUIVALENT | `[x]` |
| The genuine-mismatch live loop (required by the slice) | `[x]` numeric-scale repair reached EQUIVALENT; a separate controlled fee defect was detected and, after restore, reverified |
| Adversarial testing package | `[ ]` deferred (post-slice) |

## Phase 10 — Verification + Release Guardian `[ ]`

Deferred until the vertical slice passes. Verdicts are already computed deterministically by
the differential verifier; the Release Guardian and release decisions come after.

## Phase 11-12 — API, worker, dashboard, docs `[ ]`

Deferred by strategy: no dashboard, UI, worker infrastructure, elaborate APIs, distributed
execution, production deployment, advanced observability or sophisticated persistence until
the slice runs end to end.

---

## Verification (2026-10-05, current tree)

`pnpm verify` (`typecheck`, `lint`, `test`) exited 0. 480 tests passed. `pnpm format:check` is still outside that gate.

## Verification (2026-10-04)

* `pnpm build`, `pnpm typecheck` and `pnpm lint` (whole-repo ESLint) all exit 0.
* Full suite **459 tests green**, 0 failures, across 12 packages: shared 47, config 10,
  artifact-store 18, legacy-analysis 34, execution-sandbox 13, llm 57, characterization 78,
  repository-tools 48, differential-testing 31, agent-runtime 50, orchestrator 69, apps/cli 4.
* `pnpm format:check` still reports ~120 pre-existing repo-wide failures, including both files this
  milestone touched at `HEAD`. Not part of `verify`; reformatting them is an unrelated refactor.
* Citation-gate hardening this milestone: the fallback that accepted an oversized quote by matching
  only its first eight nonblank lines is **removed** — a matching prefix is not proof of the whole
  claim. Both the rule and invariant loops now thread per-citation feedback, and the regression that
  expected prefix-only acceptance was replaced by one proving an invented 60-line tail cannot gain
  acceptance (`specification.test.ts`, "refuses a citation whose invented tail outnumbers the real
  lines it begins with"): the claim is demoted to an unknown, the invented bytes appear nowhere in
  the artifacts, and unrelated valid claims survive.
* Rejection feedback is now actionable in both directions. A misattributed quote names the files that
  really contain the text (`elsewhereHint`); an out-of-range line prints the bytes actually there
  (`lineWindow`); and a path that does not exist lists the real contents of the nearest directory
  (`missingPathHint`, directories suffixed with `/`, capped at 12 entries). Verified against the real
  `examples/legacy-bank` tree: citing `svc/AccountSvc.java` now returns `AcctSvc.java`, and citing
  the wrong package `service/TransferService.java` returns `domain/, repo/, svc/, web/`. Neither hint
  relaxes the gate — the citation still has to resolve to real bytes.
* Orchestrator integration tests run the real thing: hermetic temp workspaces, live HTTP
  stubs for both legacy and modern sides, scripted model answers through the real agent
  loop/persister, and an independent reimplementation of the fee contract as the oracle.
* Earlier live SPECIFY attempts on lineage `run_bf33e2433f0b4c5b94398dac87ba578b` are all preserved:
  six SPECIFICATION tasks, none SUCCEEDED. Three reached PARTIAL at 8/10
  (`task_30db406647bb445787820cf036803700`, `task_4cda938b3588415e90e8f8d2ffac357f`,
  `task_ee7227e750724b36a391af4f84b3e79f`); `task_219df0ffc98b42a49735b43e46fefc3c` FAILED at 7/10
  with `ARTIFACT_WRITE_FAILED`, because SPECIFY passes no slug and its artifact paths are fixed;
  `task_84d861fc64f54db7873c142990ee023a` and `task_aa67be0413604affbb9ade785e77101f` FAILED at 0/10
  having emitted no artifacts. Its DISCOVERY task `task_2eed5946e8cb4c10850552c26e5a92f3` is
  SUCCEEDED 9/9, but a lineage whose latest SPECIFICATION result is not SUCCEEDED can never satisfy
  `requireSuccessfulPredecessor` — which is why the 2026-10-04 attempt ran on the clean lineage
  `run_1ad5681e13294219959c3908022799c5` instead. Nothing was deleted.

## Environment notes (measured 2026-09-30, updated 2026-10-04)

* Node v23.11.0, pnpm 12.4.2, TypeScript 5.7.x
* PostgreSQL 16.15 running locally (`:5432`) — Docker is **not** installed, so the demo runs
  natively; compose files are still provided (ADR-1).
* Maven 3.9.16 + Zulu JDK 17 installed for the legacy bank (ADR-2).
* Real model: dedicated `ollama serve` on `http://localhost:11435/v1` with
  `OLLAMA_CONTEXT_LENGTH=32768`, model `qwen2.5-coder:7b-instruct`, reached through the same
  OpenAI-compatible provider that hosted Qwen uses (ADR-7).
* `examples/legacy-bank` runs on `:8080` against local PostgreSQL (`/health` → UP). Its jar is
  prebuilt at `target/corebank-legacy-0.9.3.jar`, so `run.sh` skips Maven.
* `package.json` scripts `db:setup`, `legacy:up` and `legacy:down` point at `scripts/*.mjs` files
  that were never committed — `scripts/` is empty and appears in no commit. The working legacy start
  path is `examples/legacy-bank/run.sh`.
* No `timeout`/`gtimeout` binary on this macOS host, so stage deadlines are imposed via
  `STAGE_TIMEOUT_MS` in the shell environment, which overrides `.env`.

## Live slice (2026-10-05)

Pinned lineage `run_1ad5681e13294219959c3908022799c5`. One completed run. Not a production-readiness claim.

| Stage | Result |
|---|---|
| DISCOVER | SUCCEEDED, task `task_47614a38d04a415692c7566beb09815a` |
| SPECIFY | SUCCEEDED, task `task_d326ab378f4940e89d81420f1dc9ae2b`, 5 rules, 2 invariants, 6 model calls. Artifacts `specification/business-rules-attempt-task_d326ab378f4940e89d81420f1dc9ae2b.json` (`art_9a80e7ed0b04afbcd581643947e5d6e9ff086613aec67b9c77f74e2a7772e9fb`) and `specification/invariants-attempt-task_d326ab378f4940e89d81420f1dc9ae2b.json` (`art_003bc587947ba34a339ca9e35e73827bdd6e6d06355cdca8e70b70add3af015f`). Needed `LLM_MAX_TOKENS=16384`; 8192 ended `finish_reason=length` |
| CHARACTERIZE | SUCCEEDED, task `task_378ff718bd1741d0ac6b5360a3da01c5`, 10 cases, 662 assertions, 0 unexplained volatility. Artifact `characterization/suite-attempt-task_378ff718bd1741d0ac6b5360a3da01c5.json` (`art_89ed99511fce353265465fcd51f2d68d05f4e9547a2b18f3ba5535ff4a51b782`). Captured against `legacy_bank_slice` after a schema reset |
| MODERNIZE / VERIFY | First attempt `task_7301755382be45e9acbe4ca65a3becda` was NOT_EQUIVALENT (JSON numbers versus `"60.0000"` strings). Repair `task_41881c4228ed48198af80641f1a510a1` reverified EQUIVALENT, 10/10, 0 mismatches, task `task_041af08b84be4b89839494f2a12d53fb`. Verdict `verification/verdict-r1-attempt-task_041af08b84be4b89839494f2a12d53fb.json` (`art_0c3de5b7f7b3244f28a61228b7478cea025870dd90033d57d535190b085e6582`) |
| Controlled defect | Online fee multiplier in the generated server changed from `0.005` to `0.01`. Verification `verification/verdict-r4.json` (`art_5c03fb71370980c8b3adabd7e5c4e61975fd770ec9b370ffe3e30707cfc2f702`) is NOT_EQUIVALENT, 7 mismatches, including `xfer-100-young-account` fee legacy `0.5` versus modern `1`. Restoring the multiplier produced `verification/verdict-r5.json` (`art_d8e81923fbd7d5414519082adf5aa0fd2e5f32adad7ee811dd30f1192756f6d4`), EQUIVALENT, 0 mismatches |

Failed SPECIFY, the mime-500 characterization (`task_17c0ea488a6c432f9ffcffda8e4002e2`), and the earlier NOT_EQUIVALENT modernize loop remain on this lineage. Nothing was deleted.

Accepted invariants were checked against the legacy source before characterization. `INV-SETTLED-LEDGER-ROW-IMMUTABLE` follows the `BEFORE UPDATE OR DELETE` trigger in `V3__batch_and_triggers.sql`: a `SETTLED` row raises unless `app.correction_channel` is `CORRECTION_JOB`; an unset channel becomes `''` and still raises; INSERT is unguarded. `INV-TRANSFER-IDEMPOTENCY-KEY-UNIQUE` follows `transfers.idempotency_key VARCHAR(64) UNIQUE` and the early return in `TransferSvc.createTransfer`. A matching quote was not treated as sufficient on its own.

## Known limitations

*(updated at every phase boundary)*

* One successful live lineage. Dashboards, workers, a provider chain, and cloud deployment are not implemented. Gemini is not a fallback.
* Clock-suffix fields are excluded from differential equivalence even when both legacy executions agree. Amounts, statuses, `valueDate`, and fees are not. That exclusion is what let seed `createdAt` instants differ without failing the verdict.
* Characterization isolation is a `pg_dump` snapshot of the eight business tables, restored before each execution. It is not a general sandbox. The demo role cannot create the database; a superuser has to.
* `examples/legacy-bank/run.sh` starts Java and exits. The process that must stay up is `java -jar`, with `SPRING_DATASOURCE_URL` pointed at the same database as `LEGACY_BANK_DB_URL`.
* `pnpm format:check` still reports pre-existing repo-wide failures and is not part of `pnpm verify`.
