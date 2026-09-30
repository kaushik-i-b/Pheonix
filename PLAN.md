# Phoenix — Build Plan

**Autonomous Legacy Modernization Factory**
> Modernize systems nobody is brave enough to touch.

This document is the engineering plan. `PROGRESS.md` tracks phase status. Architecture
deviations from the original brief are recorded in §9 and must be kept up to date.

---

## 1. Product definition

Phoenix accepts an unfamiliar legacy repository and autonomously produces either

* a modern replacement **plus machine-checkable evidence** that externally observable
  behavior is preserved, or
* a **credible rejection** with preserved evidence explaining why the migration is unsafe.

Phoenix is an engineering system, not a demo. The following are hard rules:

1. Discovery precedes rewriting. Legacy code is treated as the only reliable specification.
2. Agents communicate through **persistent, schema-validated artifacts**, not shared prose.
3. The Modernizer may never validate its own work. Verification and release decisions are
   computed by **deterministic code** over evidence.
4. Failure is a first-class result. Nothing is silently downgraded, faked, or hardcoded.
5. Every decision is traceable: `source → rule → invariant → test → implementation →
   verification → release decision`.

---

## 2. Target environment (measured, not assumed)

| Capability | Status | Consequence |
|---|---|---|
| Node | v23.11.0 | OK (brief asks 22+) |
| pnpm | 12.4.2 | workspace root |
| TypeScript | installed as devDependency | strict mode everywhere |
| PostgreSQL | 16.15 running locally on `:5432` | Phoenix metadata DB + legacy DB (separate databases) |
| Docker | **not installed** | compose files are shipped for portability, but the demo runs natively |
| Maven | 3.9.16 (installed during setup) | builds `examples/legacy-bank` |
| JDK | Zulu 17.0.15 at `/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home` | legacy app targets Java 8 language level, runs on JDK 17 |
| Local LLM | Ollama on `http://localhost:11434/v1` (llama3.2, mistral, deepseek-r1) | used to validate the generic OpenAI-compatible provider end-to-end until Qwen credentials are supplied |

No `LLM_API_KEY` is present in the environment, so real-LLM validation runs against the
local Ollama endpoint through the same provider interface that Qwen will use. Tests never
touch a network LLM — they use the deterministic mock provider (§5.2).

---

## 3. Repository layout

```
apps/
  api/          Fastify control plane: start/inspect runs, events, artifacts, evidence
  worker/       Pipeline executor process (consumes runs, drives the orchestrator)
  web/          Next.js engineering dashboard (evidence-first, not marketing)
  cli/          `phoenix modernize ./legacy-system`

packages/
  shared/              Zod schemas for every artifact, task, result, event, evidence edge
  llm/                 Provider interface, OpenAI-compatible client, mock, prompts, cost
  artifact-store/      Content-addressed artifact persistence + indexed retrieval
  execution-sandbox/   Controlled command execution: allowlists, timeouts, logs, isolation
  repository-tools/    Tool layer (read_file, list_files, search_repository, write_file,
                       apply_patch, run_command, run_tests, query_database, inspect_git_diff)
                       with per-role permission enforcement
  agent-runtime/       Agent loop, handoff contract, retries, resumability, telemetry
  legacy-analysis/     Deterministic static analysis of an unknown repository
  specification/       Business rules, invariants, evidence graph construction
  characterization/    Behavior-capture test generation + execution against the legacy system
  differential-testing/ Adapters, normalization, deterministic comparator, mismatch records
  adversarial-testing/ Scenario derivation and attack execution
  verification/        Deterministic verdict computation + release gate
  orchestrator/        Stage state machine + autonomous repair loop
  config/              Env parsing (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, limits, DB)

examples/
  legacy-bank/         The ugly inherited financial system Phoenix is fed (Java 8 / Spring
                       Boot 2.7 / PostgreSQL / Maven). Contains no hints for Phoenix.

benchmarks/
  legacy-bank/         Ground truth + scoring. Deliberately OUTSIDE examples/legacy-bank so
                       it can never leak into a Phoenix run.

artifacts/             Per-run artifact tree: artifacts/<runId>/<stage>/...
docker/                Compose + Dockerfiles
docs/                  architecture.md agents.md security.md evidence-model.md demo.md
scripts/               Bootstrap, db setup, run demo, evaluate discovery quality
```

### 3.1 Deviations from the brief's suggested layout

* `apps/cli` added — §14 of the brief requires `phoenix modernize ./legacy-system`; giving it
  its own app keeps the API and the CLI independently runnable.
* `packages/config` added — env/limits parsing was going to be duplicated across api, worker,
  cli and orchestrator; centralizing it keeps a single source of truth for `MAX_REPAIR_ITERATIONS`
  and provider settings.
* `benchmarks/` added — the brief demands ground truth live outside the repository Phoenix
  receives. A sibling top-level directory is the only way to guarantee that structurally.

---

## 4. Core data contracts (Zod, `packages/shared`)

Everything crosses an agent boundary as a validated artifact. The canonical types:

* `RunRecord` — runId, legacy target, config fingerprint, stage states, timings, token usage.
* `AgentTask` — `{ taskId, runId, role, objective, inputArtifacts, allowedTools, constraints,
  acceptanceCriteria }`.
* `AgentResult` — `{ taskId, status, generatedArtifacts, findings, evidence,
  nextRecommendedAction }`.
* `RepositoryMap`, `DependencyMap`, `DataFlow`, `DiscoveryFindings`.
* `BusinessRule` — id, description, `status: OBSERVED|INFERRED|UNKNOWN`, sourceEvidence[],
  confidence, affectedComponents, observableBehavior, edgeCases, assumptions.
* `Invariant` — id, statement, kind, criticality, sourceEvidence[], checkingStrategy.
* `CharacterizationCase` / `CharacterizationSuite` — executable behavioral contract.
* `ArchitectureDesign`, `MigrationPlan`, `RiskRegister`.
* `AdversarialScenario`, `AdversarialReport`.
* `DifferentialScenario`, `NormalizedResult`, `Mismatch` — scenario, legacyResult,
  modernResult, relevantRule, relevantInvariant, severity, evidence.
* `VerificationVerdict`, `ReleaseDecision` — `PASS | REJECT`, blocking reasons, evidence refs.
* `EvidenceNode`, `EvidenceEdge` — the evidence graph.
* `PhoenixEvent` — the structured observability event union (§7).
* `ToolInvocation` — tool, arguments, timestamp, exitCode, durationMs, outputSummary, role.

Schemas are the single source of truth: the API validates responses, the artifact store
validates on write **and** on read, and tests assert schema round-trips.

---

## 5. LLM strategy

### 5.1 Provider layer (`packages/llm`)

```ts
interface LlmProvider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
```

`CompletionResult` carries text, token usage, model id, latency, and finish reason. One
implementation — `OpenAiCompatibleProvider` — speaks the OpenAI chat-completions wire format
and therefore covers hosted Qwen (DashScope compatible mode), vLLM, Ollama, llama.cpp server
and any other compatible endpoint purely through `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`.
No Phoenix code may reference a specific model name or vendor.

Because small/local models are unreliable JSON producers, the layer includes:

* `completeStructured()` — schema-driven request, response validated with Zod;
* automatic **repair retries**: on validation failure the parse error is fed back to the model
  (bounded by `LLM_MAX_RETRIES`, default 3);
* fenced-code / leading-prose tolerant JSON extraction;
* hard failure (never a silent fabricated object) when retries are exhausted.

Cost estimation is configuration-driven (`pricing.json` per model, optional); when absent,
tokens are recorded and cost is reported as `null` rather than guessed.

### 5.2 Determinism boundary

The brief's rule — never ask an LLM to do what deterministic code can do reliably — is enforced
by construction:

| Concern | Who does it |
|---|---|
| File walking, language detection, endpoint/SQL/cron extraction, dependency graph | deterministic code (`legacy-analysis`) |
| Semantic interpretation: "what business rule does this code implement?" | LLM |
| Test *generation* | LLM (proposes) |
| Test *execution*, comparison, scoring | deterministic code |
| Mismatch detection, severity, verdict, release decision | deterministic code |
| Repair diagnosis (which rule is violated and why) | LLM proposes, verifier confirms by re-running |
| Prompt text | versioned files, persisted per run with a content hash |

### 5.3 Mock provider

`MockLlmProvider` is a **test-only** scriptable provider: it maps prompt fingerprints /
call sequences to canned responses, enabling deterministic tests of the orchestrator, repair
loop and release gate with zero network access. It is exported from a `/testing` subpath so
production code cannot import it accidentally, and it refuses to run unless `NODE_ENV=test`
or an explicit opt-in flag is set.

---

## 6. Agents

Each agent = role + permission profile + prompt pack + deterministic pre/post processors.
All of them emit artifacts and events; none may write outside its permitted roots.

| Role | Permissions | Outputs |
|---|---|---|
| Archaeologist | READ repo, EXECUTE read-only commands | `discovery/repository-map.json`, `dependency-map.json`, `data-flow.json`, `findings.md` |
| Business Rule Analyst | READ repo + discovery artifacts | `specification/business-rules.json` |
| Invariant Analyst | READ repo + rules | `specification/invariants.json` |
| Characterization Engineer | READ + EXECUTE against legacy runtime, WRITE artifacts | `characterization/**` |
| Architect | READ artifacts, WRITE design artifacts | `design/architecture.md`, `migration-plan.md`, `risk-register.json` |
| Modernizer | READ legacy (reference only) + WRITE modern target | modern implementation + `implementation/change-report.md` |
| Adversary | READ + EXECUTE against both systems | `adversarial/report.json` |
| Differential Verifier | READ + EXECUTE | `verification/differential-report.json` |
| Release Guardian | READ artifacts + EXECUTE tests; **no application writes** | `release/decision.json`, `release/report.md` |

Invariants are **not** hardcoded per domain. `packages/specification` ships a domain-neutral
invariant *taxonomy* (money conservation, idempotency, uniqueness, monotonicity, immutability,
rounding stability, ordering, retry semantics, state-machine legality) used only as a prompt
scaffold; the banking example must cause Phoenix to *discover* instances with source evidence.

---

## 7. Observability

One `runId` per execution. A single append-only event stream (`PhoenixEvent` discriminated
union) persisted to Postgres **and** mirrored as structured JSON logs and
`artifacts/<runId>/events.jsonl`:

`run.started`, `stage.transition`, `agent.started`, `agent.finished`, `tool.invoked`,
`artifact.created`, `test.executed`, `failure.discovered`, `repair.requested`,
`repair.completed`, `verification.result`, `release.decision`, `llm.completed` (tokens, cost),
`run.finished`.

Events are the API's source of truth for the dashboard timeline; nothing is recomputed from
prose.

---

## 8. Orchestration and repair loop

```
DISCOVERY → SPECIFICATION → CHARACTERIZATION → DESIGN → IMPLEMENTATION
  → ADVERSARIAL_TEST → DIFFERENTIAL_TEST → VERIFICATION
        VERIFICATION pass    → RELEASE
        VERIFICATION fail    → DIAGNOSE → CREATE_REPAIR_TASK → MODERNIZER → RETEST → VERIFICATION
```

* Stage state machine with persisted transitions: `WAITING | RUNNING | PASSED | FAILED |
  REPAIRING | SKIPPED`.
* Repair loop bounded by `MAX_REPAIR_ITERATIONS` (default 3) and `MAX_TOTAL_TOOL_CALLS`;
  each iteration must show **measurable progress** (mismatch count or severity strictly
  improving) or the loop terminates early rather than burning budget.
* Terminal states: `RELEASED_PASS`, `REJECTED_WITH_UNRESOLVED_FAILURES`, `FAILED_INTERNAL`.
  All evidence is preserved in every case.
* Resumability: every stage is idempotent w.r.t. its input artifact hashes, so a run can be
  resumed from the last completed stage.

---

## 9. Architectural decisions & deviations (living list)

| # | Decision | Reasoning |
|---|---|---|
| ADR-1 | Legacy bank runs natively (Maven + local PostgreSQL 16); Docker Compose still shipped | Docker is unavailable in this environment; the demo must actually run, and compose keeps the brief's portability intent |
| ADR-2 | Legacy bank is Java 8 **language level** on Spring Boot 2.7, executed on JDK 17 | Spring Boot 2.x is the realistic "inherited" stack; JDK 17 is what's installed and runs Java-8-target bytecode fine |
| ADR-3 | Ground truth lives in `benchmarks/`, never under `examples/legacy-bank` | Structural guarantee against leaking answers into a Phoenix run |
| ADR-4 | Modern replacement target is TypeScript/Node + PostgreSQL | Phoenix's own stack; exercises a genuine cross-language migration rather than a rewrite in the same idiom |
| ADR-5 | Verdicts and release decisions computed deterministically, never by the LLM | "The LLM said so" is not evidence; §13/§15 of the brief |
| ADR-6 | Dev/test runs resolve `@phoenix/*` through tsconfig paths + `tsx`; `tsc` emits `dist` for production | Avoids a mandatory build step during iteration without weakening type checking |
| ADR-7 | Real-LLM validation uses the local Ollama OpenAI-compatible endpoint until Qwen credentials exist | Proves provider genericity now; swapping in Qwen is env-only |
| ADR-8 | Artifact store is content-addressed on disk with a Postgres index | Cheap dedupe, tamper-evidence via SHA-256, and queryable run history |

---

## 10. Phase plan

| Phase | Deliverable | Exit criteria |
|---|---|---|
| 1 | Monorepo + `shared` schemas + config + artifact-store + sandbox/tools + llm | `typecheck`, `lint`, `test` all green |
| 2 | Runnable `examples/legacy-bank` + ground truth + scoring script | app boots, endpoints respond, DB triggers fire, quirks are real and undocumented |
| 3-4 | agent-runtime + legacy-analysis + Archaeologist | discovery artifacts produced from the legacy bank with a real LLM and with the mock |
| 5-6 | Rules, invariants, evidence graph, characterization | executable characterization suite passes **against legacy** (it records reality, including bugs) |
| 7-8 | Architect, Modernizer, differential engine | comparator detects an intentionally seeded divergence; normalization only when configured |
| 9 | Adversary + repair loop | a real mismatch is diagnosed, repaired, and re-verified without human input |
| 10 | Verification + Release Guardian | both PASS and REJECT paths demonstrated; rejection preserves evidence |
| 11-12 | API, worker, dashboard, CLI, docs, test hardening | end-to-end `phoenix modernize ./examples/legacy-bank`; dashboard shows evidence; docs complete |

After every phase: compile → lint → test → fix → commit → update `PROGRESS.md`.
The repository is never left knowingly broken.

---

## 11. First vertical slice (drives ordering)

Legacy app → Archaeologist → rules/invariants → characterization tests → small modern
replacement → differential verifier → mismatch → automatic repair → reverification →
PASS/REJECT. Everything else is sophistication layered on top of this working path.

---

## 12. Risk register (build-time)

| Risk | Mitigation |
|---|---|
| Small local models emit invalid JSON | Structured completion with bounded repair retries; deterministic fallbacks for anything that can be computed; hard failure instead of fabrication |
| Maven/Spring Boot dependency download is slow or flaky | Pin versions, build early (Phase 2 runs in parallel with core packages), keep a `mvn -o` offline path |
| Legacy app nondeterminism breaks differential comparison | Normalization is explicit and recorded; every normalized field appears in the report |
| Repair loop churns without progress | Progress-monotonic termination rule + iteration caps |
| Scope explosion | Phase gates; no UI polish before the engine works (brief §9) |
