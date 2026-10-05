# PHOENIX Run Inspector — UI Design

Date: 2026-10-05
Status: Approved for implementation (user: "ok create an ui", after approving the
read-only run-inspector scope, the evidence-and-citations emphasis, the
artifacts-plus-live-source treatment, the Next.js + Tailwind approach, and the
Vercel publication constraints).

## 1. Context and goal

PHOENIX is a legacy-modernization pipeline (DISCOVER → SPECIFY → CHARACTERIZE →
MODERNIZE → DIFFERENTIAL VERIFY → MISMATCH → REPAIR → REVERIFY) currently driven
by a TypeScript CLI. It already persists everything it does: a run registry,
artifact files, an append-only event log, agent task records, and verification
verdicts. The one genuinely new capability this UI adds is the trust story: a
reader can open any claim the pipeline makes and see the real bytes it stands on.

This UI is a **read-only run inspector / evidence dashboard** over the persisted
artifacts of completed runs. It never writes to a run, never launches pipeline
stages, and never participates in the verification loop. The pipeline's own
records are the ground truth; the UI displays them and adds exactly one derived
computation (a live byte re-check of citations), which is always labeled as
UI-computed and never merged with pipeline-recorded results.

The first-class experience — the only one the user asked for — is the **evidence
& citations viewer**: every rule, finding, and invariant is traceable to recorded
source quotes, and each quote can be checked against the real bytes on disk.

## 2. Data sources (ground truth)

All data comes from the repository's `artifacts/` directory (gitignored; never
committed). Verified against the pinned lineage
`run_1ad5681e13294219959c3908022799c5`:

- `artifacts/<runId>/index.json` — the run's artifact registry (185 entries for
  the pinned run). Entry fields: `id` (`art_<sha256>`), `kind`, `format`,
  `runId`, `relativePath`, `sha256`, `bytes`, `createdAt`, `schemaVersion`,
  `producedBy {role, taskId, generator}`, `inputs`, `title`, `tags`. Includes
  attempt artifacts (17 entries whose paths contain `-attempt-task_`).
- `artifacts/<runId>/run/events.jsonl` — append-only event log (838 events).
  Fields: `runId`, `seq`, `at`, `stage`, `role`, `taskId`, `type`, plus
  type-specific fields. Stage values seen: `DISCOVERY`, `SPECIFICATION`,
  `CHARACTERIZATION`, `IMPLEMENTATION`, and `null` (106 events must render under
  an explicit "unattributed" bucket, never dropped). Event types: `agent.failed`,
  `agent.finished`, `agent.started`, `agent.step`, `artifact.created`,
  `failure.discovered`, `llm.completed`, `prompt.rendered`, `repair.completed`,
  `repair.requested`, `test.executed`, `tool.denied`, `tool.invoked`,
  `verification.result`. Timeline is ordered by `seq`, not file order.
- `artifacts/<runId>/agent/result-task_<id>.json` — per-task outcome; status is
  at `.payload.status` (`SUCCEEDED` | `PARTIAL` | `FAILED`; real examples of all
  three exist in the pinned run).
- `artifacts/<runId>/specification/business-rules.json` and
  `invariants.json` — **canonical** artifacts: by documented design
  (`packages/orchestrator/src/slug.ts`, `stages/specification.ts`), the FIRST
  specification attempt writes the canonical path and every retry writes
  `<name>-attempt-<taskId>` beside it. Consequence, displayed faithfully: the
  pinned run's canonical files came from a PARTIAL first attempt (1 business
  rule; 0 invariants) while a SUCCEEDED retry sits beside them (5 rules; 2
  invariants). The UI asserts nothing about "acceptance"; it shows canonical vs
  attempt and the producing task's recorded outcome.
- `artifacts/<runId>/discovery/findings.json`, `findings.md`,
  `repository-map.json`, `dependency-map.json`, `data-flow.json` — discovery
  findings carry `evidence[]` with the same `location {path, startLine,
  endLine, symbol?}` / `quote` / `note` shape as specification evidence.
- `artifacts/<runId>/characterization/suite.json` (+ attempts) — cases and
  assertions; canonical pinned suite: 9 cases / 381 assertions; a preserved
  attempt has 10 cases. Both render with their own numbers.
- `artifacts/<runId>/implementation/change-report*.json` (+ attempts) — what the
  modernizer changed, per repair iteration.
- `artifacts/<runId>/verification/differential-report*.json` and
  `verdict*.json` — per-iteration comparisons and verdicts. Verdict fields:
  `verdict`, `repairIteration`, `checks[] {checkId, kind, status, observed,
  threshold?, description}`, `mismatchSummary {bySeverity, highestSeverity,
  total, unexplained, unresolved}`, `reasons`, `confidence`, `inputArtifactIds`.
  Pinned run: r1 NOT_EQUIVALENT … r4 NOT_EQUIVALENT (7 MAJOR mismatches) →
  r5 EQUIVALENT (10/10 scenarios equal). Every iteration renders; failures are
  preserved, never collapsed.
- Source bytes: `examples/legacy-bank/` — the unchanged workload. Citation
  `location.path` is repo-relative to the artifact's `targetRoot` (a
  machine-absolute path in the artifact, sanitized by the UI before display).

Never read for display: `agent/transcript-*.json`, `agent/tool-log-*.json`,
`run/prompt-*.txt`, and the raw body of `llm.completed` events. These stay local
and are never published.

## 3. Architecture

- New workspace package `apps/web` → `@phoenix/web`. Next.js App Router +
  Tailwind CSS v4, TypeScript strict, same package conventions as the rest of
  the monorepo (`build` via `tsc` is not applicable to Next; package scripts:
  `dev`, `build`, `typecheck`, `test`, `lint` compatible with root `pnpm
  verify`). Root script `pnpm web` (already present) starts the dev server.
- **Static export** (`output: 'export'`) — every page is pre-rendered at build
  time; the deployed site performs no filesystem access at runtime. Dynamic
  routes get `generateStaticParams()` from the scanned artifacts.
- Data layer: pure TypeScript modules under `apps/web/src/data/`, importing only
  `node:fs`/`node:path`/`zod`, deliberately decoupled from producer packages so
  every preserved run (24 run directories) renders, not just the pinned one.
  Tolerant zod projections: unknown extra fields pass through where they are
  displayed, but every displayed field is validated; a malformed required file
  in the featured run fails the build loudly rather than rendering a lie.
- Rendering: server components read the data layer at build/request time; the
  few interactive pieces (timeline filter, evidence expand/collapse) are client
  components.
- Environment: `PHOENIX_ARTIFACTS_DIR` (default `<repoRoot>/artifacts`),
  `PHOENIX_LEGACY_ROOT` (default `<repoRoot>/examples/legacy-bank`),
  `PHOENIX_BUILD_TIME` inlined at build for the snapshot label.

### Data layer modules

| Module | Responsibility |
| --- | --- |
| `repo-root.ts` | Resolve repo root from the app location; honor env overrides. |
| `runs.ts` | `scanRuns()`: list run directories, load each `index.json`, counts, stage coverage, verdict summary, timestamps; `featuredRun()` = latest by last event timestamp, labeled "latest". |
| `events.ts` | `readRunEvents(runId)`: parse `events.jsonl`, sort by `seq`, `groupTimeline()` into stages + `unattributed` bucket. |
| `tasks.ts` | `loadTaskOutcomes(runId)`: `.payload.status` per task, joined to tasks seen in events. |
| `artifacts.ts` | `loadArtifacts(runId)`: registry entries + `canonical`/`attempt` classification + producing task outcome. |
| `specification.ts` | `loadSpecification(runId)`: canonical + attempt business-rules and invariants, rules, invariants, unknowns, per-artifact statistics. |
| `findings.ts` | `loadFindings(runId)`: discovery findings with evidence. |
| `verification.ts` | `loadVerifications(runId)`: differential reports + verdicts in iteration order. |
| `characterization.ts` | `loadCharacterization(runId)`: suite + attempts. |
| `legacy-source.ts` | `readLegacySource(path)`: real bytes of a repo-relative file under the legacy root; returns content or a typed absence (missing file), plus the source mode. |
| `recheck.ts` | `recheckEvidence(location, quote)`: the five-state byte re-check (below). |

## 4. Routes and screens

- `/` — Runs index. Every discovered run: id, timestamps, artifact count,
  event count, stage coverage, latest verdict (verdict + iteration + mismatch
  total). Latest run featured and labeled "latest". Empty state if no runs.
- `/runs/[runId]` — Run overview:
  - Header: run id, source mode banner (see §6), first/last event time, totals.
  - Stage timeline: events grouped by stage in `seq` order; `unattributed`
    bucket for null-stage events; per-event detail (type, at, role, summary
    fields). Agent tasks render with their recorded outcome badge.
  - Task table: all tasks seen in events, role, stage, outcome, links to their
    recorded artifacts.
  - Artifact inventory: registry entries grouped by stage/kind, each labeled
    `canonical` or `attempt`, with producing `role:taskId`, outcome, bytes,
    sha256 prefix, and title.
  - Verification panel: every verdict iteration r1…rn with `checkId`, status,
    observed vs threshold, and mismatch summary; non-EQUIVALENT iterations
    visually distinct and never collapsed into the final verdict. Differential
    report per iteration: scenario table with `equal`, category, duration.
  - Specification summary: canonical + attempts, rule/invariant counts per
    artifact, unknowns count, links into `/specification`.
- `/runs/[runId]/specification` — Rules and invariants: canonical artifact
  first, then each attempt as its own clearly-labeled group. Per rule: id,
  title, kind, epistemic status, lifecycle status, confidence + basis,
  observable behavior, affected components, assumptions, proposed checks,
  contradictions, derived invariants, duplicate implementations; link to the
  rule's evidence view. Per invariant: id, formal statement, criticality,
  checking strategy (kind, automated, executable query), examples, epistemic
  status. Unknowns table. Zero-count artifacts state "0 recorded (this is what
  the artifact says)" — never hidden.
- `/runs/[runId]/rules/[artifactSlug]/[ruleId]` — **Evidence view
  (centerpiece)**: rule header as above, then for each `sourceEvidence` and
  each edge case's evidence, an evidence card; each card carries the source
  panel (§5). Edge-case expected behavior, proposed checks, and cross-links
  (contradicts / derived-from / duplicates) render inline.
- `/runs/[runId]/findings` and `/runs/[runId]/findings/[findingId]` — Discovery
  findings with the same evidence cards + source panel (findings carry the same
  citation shape; the trust story applies to them equally).

### States

Every route renders explicit states: not present in this run, empty artifact,
zero counts, missing files, unattributed events, and per-run partial data. No
state is silently omitted; no placeholder is invented.

## 5. Evidence & citations viewer (centerpiece)

Claim → evidence → bytes. For a rule or finding:

1. **Claim header** — identity (rule id / finding id), title, epistemic status
   (`OBSERVED`, `INFERRED`, …), confidence and confidence basis, observable
   behavior / summary, affected components.
2. **Evidence card** — for each evidence entry: `path:startLine–endLine`,
   optional symbol, evidence kind, `collectedAt`/`collectedBy`, the recorded
   `quote` (preserved verbatim, monospace, exact whitespace), and the recorded
   `note` when present (e.g. the archaeologist's paraphrase disclosure
   "model quote paraphrased or fused; similarity 0.75" renders as recorded).
3. **Source panel** — the real bytes of `location.path` read from the legacy
   root, with lines `startLine..endLine` highlighted, line numbers gutter, and a
   **re-check status** (below). In local dev the panel says where it read from
   and that the bytes are the current working tree; in the hosted build it says
   the bytes are a snapshot captured at deploy build time (timestamp).

### Re-check states (UI-computed, labeled as such)

Computed by comparing the recorded quote against the real bytes at the recorded
range; the result is displayed as a UI observation, never mixed with any
pipeline-recorded validation result:

- **matched** — the bytes at the recorded range equal the quote exactly (the
  comparison normalizes only the line-ending style; nothing else).
- **drifted** — lines exist at the range but differ; show recorded quote and
  actual bytes side by side, with the first differing line called out.
- **relocated** — the quote is not at the recorded range but appears elsewhere
  in the file; state the found line range.
- **file missing** — `location.path` does not exist under the legacy root.
- **out of range** — the file is shorter than `startLine`/`endLine`; state the
  file's line count.

The byte comparison is exact; a matching prefix is not a match. If the quote
cannot be compared as recorded (whitespace-only difference at range ends is a
drift, not a match), it is reported as drifted with the diff shown.

## 6. Publication safety (Vercel)

- Deployment is **prebuilt**: the static export is produced locally (where
  `artifacts/` and `examples/legacy-bank/` exist), then uploaded with
  `vercel build` + `vercel deploy --prebuilt`. Vercel never receives the raw
  artifacts directory, prompts, or transcripts; only the rendered static site
  leaves the machine. Nothing is committed for deployment.
- **Path sanitization**: machine-absolute paths (artifact `targetRoot`, any
  host path) render repo-relative (`examples/legacy-bank`) with a "host path
  withheld" note. The build-time data layer performs the normalization; raw
  absolute paths must not reach the bundle.
- **Secret scan gate**: before any deploy, a scanner walks the static output and
  fails the build listing file + masked match if it finds API-key patterns
  (`sk-…`, `AQ.…`), `Authorization`/`Bearer` values, or absolute `/Users/`
  paths. Failing loudly is the point; the deploy script runs the scan and
  refuses to deploy on failure.
- Default deployment target is a **preview** URL. Production promotion is a
  separate, explicit action.
- The published site is a frozen snapshot of the pinned lineage at build time;
  wording in the UI distinguishes "current working tree" (local dev) from
  "source snapshot at deploy build time" (hosted).

## 7. Testing

- TDD for the data layer: every function above gets unit tests first, against
  temporary fixture trees (a minimal synthetic run + a legacy source tree) and
  against shape tolerance for the 24-run directory. Re-check tests cover all
  five states plus line-ending normalization; sanitization tests cover absolute
  path removal; the scanner gets tests for each pattern class (with masked
  output asserted).
- The pinned lineage itself is a build-time fixture for a smoke check: the
  scanner-less `pnpm --filter @phoenix/web build` must succeed against the real
  artifacts and emit the expected routes (runs index, pinned run overview, its
  specification page, its rule evidence pages, findings).
- UI behavior is verified in a real browser against the dev server (golden
  path: index → pinned run → rule evidence → source panel states), not only by
  unit tests.
- Root `pnpm verify` must stay green (typecheck + lint + tests across packages;
  the web package participates with its own typecheck/test scripts).

## 8. Scope boundaries

In: read-only inspection of persisted runs; evidence and citation viewing with
live byte re-check; verification history; artifact inventory; discovery
findings. Out (v1): writing to runs, launching or resuming pipeline stages,
editing artifacts, authentication, multi-user features, server-side runtime
behaviour, reading agent transcripts/prompts for display, any mutation of the
pipeline or its evidence.

The UI is a viewer of the record. If the record says a canonical artifact came
from a PARTIAL attempt with zero invariants, the UI shows exactly that — the
inspector exists to make the record legible, not to make it look better.
