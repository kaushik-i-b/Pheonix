import type { z } from 'zod';
import type { FileArtifactStore } from '@phoenix/artifact-store';
import {
  type AcceptanceCriterion,
  type AcceptanceOutcome,
  type ArtifactKind,
  type EvidenceRef,
  type Finding,
  type GeneratedArtifact,
  type RunId,
} from '@phoenix/shared';

/**
 * Deterministic acceptance checking.
 *
 * The brief's rule — an agent may not declare its own work correct — is implemented by keeping the
 * judge out of the model's reach. Criteria are declarative data; the only things that can satisfy
 * them are artifacts on disk, items inside validated payloads, recorded test executions, and
 * registered checks written in ordinary code. A criterion that cannot be evaluated (no schema
 * registered, no check registered, no test runs recorded) is reported **unsatisfied** with the
 * reason: an unverifiable claim fails, it does not pass by default.
 */

export interface AcceptanceItem {
  id: string;
  evidence: readonly EvidenceRef[];
  /** Epistemic or verification status carried by the item, e.g. `OBSERVED`, `UNKNOWN`, `FAILED`. */
  status?: string;
}

/** How a stage exposes one artifact kind to the acceptance checker. */
export interface ArtifactExpectation {
  kind: ArtifactKind;
  /**
   * Selects a specific artifact when a stage writes more than one of the same kind — for example
   * discovery findings exist both as JSON and as rendered markdown, and only the JSON parses.
   */
  relativePath?: string;
  /** Payload schema; the envelope is unwrapped by the artifact store. */
  schema: z.ZodTypeAny;
  /** Projects the payload onto the items that item-level criteria are evaluated against. */
  items?: (payload: unknown) => readonly AcceptanceItem[];
}

/** Result of a test execution, produced by an executor — never by the model. */
export interface TestRunSummary {
  suiteId: string;
  target: 'legacy' | 'modern' | 'both';
  executed: number;
  passed: number;
  failed: number;
  skipped?: number;
}

export interface CustomCheckContext {
  runId: RunId;
  artifacts: FileArtifactStore;
  generated: readonly GeneratedArtifact[];
  findings: readonly Finding[];
  testRuns: readonly TestRunSummary[];
  /** Parsed payload of an artifact kind this run produced, or `undefined` when absent. */
  payloadOf: (kind: ArtifactKind) => unknown | undefined;
}

export interface CustomCheckResult {
  satisfied: boolean;
  /** What the check actually observed; recorded in the outcome. */
  observed?: string;
  reason?: string;
}

export type CustomCheck = (context: CustomCheckContext) => CustomCheckResult | Promise<CustomCheckResult>;

export interface AcceptanceInput {
  runId: RunId;
  artifacts: FileArtifactStore;
  criteria: readonly AcceptanceCriterion[];
  generated: readonly GeneratedArtifact[];
  findings: readonly Finding[];
  expectations?: readonly ArtifactExpectation[];
  testRuns?: readonly TestRunSummary[];
  customChecks?: Readonly<Record<string, CustomCheck>>;
}

export interface AcceptanceReport {
  outcomes: AcceptanceOutcome[];
  satisfied: number;
  unsatisfied: number;
  allSatisfied: boolean;
  /** One-line summary of what failed, for events and the dashboard. */
  summary: string;
}

const MAX_REPORTED_ITEMS = 20;

export async function evaluateAcceptance(input: AcceptanceInput): Promise<AcceptanceReport> {
  const expectations = new Map<ArtifactKind, ArtifactExpectation>();
  for (const expectation of input.expectations ?? []) expectations.set(expectation.kind, expectation);
  const testRuns = input.testRuns ?? [];
  const customChecks = input.customChecks ?? {};

  const payloadCache = new Map<ArtifactKind, { payload?: unknown; problem?: string }>();

  const generatedIds = new Set(input.generated.map((artifact) => artifact.artifactId));

  const readPayload = (kind: ArtifactKind): { payload?: unknown; problem?: string } => {
    const cached = payloadCache.get(kind);
    if (cached !== undefined) return cached;
    const expectation = expectations.get(kind);
    if (expectation === undefined) {
      const missed = { problem: `no schema registered for artifact kind "${kind}", so its contents cannot be checked` };
      payloadCache.set(kind, missed);
      return missed;
    }
    const meta = locate(kind, expectation);
    if (meta === undefined) {
      const missed = { problem: describeMissing(kind, expectation, input.runId) };
      payloadCache.set(kind, missed);
      return missed;
    }
    try {
      const payload: unknown = input.artifacts.readJson(meta, expectation.schema);
      const loaded = { payload };
      payloadCache.set(kind, loaded);
      return loaded;
    } catch (error) {
      const missed = { problem: describe(error) };
      payloadCache.set(kind, missed);
      return missed;
    }
  };

  const locate = (kind: ArtifactKind, expectation: ArtifactExpectation) => {
    const candidates = input.artifacts
      .list(input.runId, { kind })
      .filter((meta) => generatedIds.has(meta.id));
    if (expectation.relativePath === undefined) return candidates[candidates.length - 1];
    return candidates.find((meta) => meta.relativePath === expectation.relativePath);
  };

  const locateAny = (kind: ArtifactKind) => {
    const candidates = input.artifacts
      .list(input.runId, { kind })
      .filter((meta) => generatedIds.has(meta.id));
    return candidates[candidates.length - 1];
  };

  const payloadOf = (kind: ArtifactKind): unknown | undefined => readPayload(kind).payload;

  const itemsOf = (kind: ArtifactKind): { items?: readonly AcceptanceItem[]; problem?: string } => {
    const expectation = expectations.get(kind);
    if (expectation === undefined) {
      return { problem: `no schema registered for artifact kind "${kind}", so its items cannot be checked` };
    }
    if (expectation.items === undefined) {
      return { problem: `artifact kind "${kind}" has no item projection, so item-level criteria cannot be checked` };
    }
    const loaded = readPayload(kind);
    if (loaded.payload === undefined) return { problem: loaded.problem ?? `no payload for "${kind}"` };
    return { items: expectation.items(loaded.payload) };
  };

  const outcomes: AcceptanceOutcome[] = [];

  for (const criterion of input.criteria) {
    outcomes.push(await evaluateCriterion(criterion));
  }

  const satisfied = outcomes.filter((outcome) => outcome.satisfied).length;
  const failed = outcomes.filter((outcome) => !outcome.satisfied);
  return {
    outcomes,
    satisfied,
    unsatisfied: failed.length,
    allSatisfied: failed.length === 0,
    summary:
      outcomes.length === 0
        ? 'no acceptance criteria declared; nothing was verified'
        : failed.length === 0
          ? `all ${outcomes.length} acceptance criteria satisfied`
          : `${failed.length} of ${outcomes.length} acceptance criteria unsatisfied: ${failed
              .map((outcome) => `${outcome.criterionId} (${outcome.reason ?? outcome.observed ?? 'unmet'})`)
              .join('; ')}`,
  };

  async function evaluateCriterion(criterion: AcceptanceCriterion): Promise<AcceptanceOutcome> {
    switch (criterion.kind) {
      case 'artifact-present':
        return artifactPresent(criterion);
      case 'artifact-schema-valid':
        return artifactSchemaValid(criterion);
      case 'min-item-count':
        return minItemCount(criterion);
      case 'every-item-has-evidence':
        return everyItemHasEvidence(criterion);
      case 'no-unknown-status-items':
        return noUnknownStatusItems(criterion);
      case 'tests-executed':
        return testsExecuted(criterion);
      case 'tests-pass':
        return testsPass(criterion);
      case 'custom-check':
        return await customCheck(criterion);
      default: {
        // Unreachable while the enum and this switch agree; the compiler enforces that.
        const exhaustive: never = criterion.kind;
        return unsatisfied(criterion, `unknown acceptance criterion kind "${String(exhaustive)}"`);
      }
    }
  }

  function artifactPresent(criterion: AcceptanceCriterion): AcceptanceOutcome {
    const kind = criterion.artifactKind;
    if (kind === undefined) return unsatisfied(criterion, 'criterion does not name an artifact kind');
    const expectation = expectations.get(kind);
    const meta = expectation === undefined ? locateAny(kind) : locate(kind, expectation);
    if (meta === undefined) {
      return unsatisfied(criterion, describeMissing(kind, expectation, input.runId), `generated: ${input.generated.length}`);
    }
    return satisfiedOutcome(criterion, `${meta.id} at ${meta.relativePath} (${meta.bytes} bytes)`);
  }

  function artifactSchemaValid(criterion: AcceptanceCriterion): AcceptanceOutcome {
    const kind = criterion.artifactKind;
    if (kind === undefined) return unsatisfied(criterion, 'criterion does not name an artifact kind');
    const expectation = expectations.get(kind);
    const meta = expectation === undefined ? locateAny(kind) : locate(kind, expectation);
    if (meta === undefined) return unsatisfied(criterion, describeMissing(kind, expectation, input.runId));
    const loaded = readPayload(kind);
    if (loaded.payload === undefined) return unsatisfied(criterion, loaded.problem ?? 'payload could not be read', meta.id);
    return satisfiedOutcome(criterion, `${meta.id} parses against its schema`);
  }

  function minItemCount(criterion: AcceptanceCriterion): AcceptanceOutcome {
    const kind = criterion.artifactKind;
    if (kind === undefined) return unsatisfied(criterion, 'criterion does not name an artifact kind');
    if (criterion.minCount === undefined) return unsatisfied(criterion, 'criterion does not declare minCount');
    const projected = itemsOf(kind);
    if (projected.items === undefined) return unsatisfied(criterion, projected.problem ?? 'no items');
    const count = projected.items.length;
    if (count < criterion.minCount) {
      return unsatisfied(criterion, `found ${count} item(s), needed at least ${criterion.minCount}`);
    }
    return satisfiedOutcome(criterion, `${count} item(s), minimum ${criterion.minCount}`);
  }

  function everyItemHasEvidence(criterion: AcceptanceCriterion): AcceptanceOutcome {
    const kind = criterion.artifactKind;
    if (kind === undefined) return unsatisfied(criterion, 'criterion does not name an artifact kind');
    const projected = itemsOf(kind);
    if (projected.items === undefined) return unsatisfied(criterion, projected.problem ?? 'no items');
    if (projected.items.length === 0) {
      return unsatisfied(criterion, 'the artifact contains no items, so nothing is evidenced');
    }
    const missing = projected.items.filter((item) => item.evidence.length === 0).map((item) => item.id);
    if (missing.length > 0) {
      return unsatisfied(
        criterion,
        `${missing.length} item(s) carry no evidence: ${listIds(missing)}`,
      );
    }
    return satisfiedOutcome(criterion, `all ${projected.items.length} item(s) carry evidence`);
  }

  function noUnknownStatusItems(criterion: AcceptanceCriterion): AcceptanceOutcome {
    const kind = criterion.artifactKind;
    if (kind === undefined) return unsatisfied(criterion, 'criterion does not name an artifact kind');
    const projected = itemsOf(kind);
    if (projected.items === undefined) return unsatisfied(criterion, projected.problem ?? 'no items');
    const unknown = projected.items.filter((item) => (item.status ?? '').toUpperCase() === 'UNKNOWN').map((item) => item.id);
    if (unknown.length > 0) {
      return unsatisfied(criterion, `${unknown.length} item(s) are still UNKNOWN: ${listIds(unknown)}`);
    }
    return satisfiedOutcome(criterion, `no UNKNOWN items among ${projected.items.length}`);
  }

  function testsExecuted(criterion: AcceptanceCriterion): AcceptanceOutcome {
    const executed = testRuns.reduce((total, run) => total + run.executed, 0);
    const required = criterion.minCount ?? 1;
    if (testRuns.length === 0) {
      return unsatisfied(criterion, 'no test execution was recorded for this task');
    }
    if (executed < required) {
      return unsatisfied(criterion, `${executed} test(s) executed across ${testRuns.length} suite(s), needed ${required}`);
    }
    return satisfiedOutcome(criterion, `${executed} test(s) executed across ${testRuns.length} suite(s)`);
  }

  function testsPass(criterion: AcceptanceCriterion): AcceptanceOutcome {
    if (testRuns.length === 0) {
      return unsatisfied(criterion, 'no test execution was recorded for this task');
    }
    const failed = testRuns.filter((run) => run.failed > 0);
    if (failed.length > 0) {
      const total = failed.reduce((sum, run) => sum + run.failed, 0);
      return unsatisfied(
        criterion,
        `${total} failing test(s) in ${failed.map((run) => run.suiteId).join(', ')}`,
      );
    }
    const executed = testRuns.reduce((total, run) => total + run.executed, 0);
    if (executed === 0) return unsatisfied(criterion, 'suites reported no executed tests');
    return satisfiedOutcome(criterion, `${executed} test(s) passed across ${testRuns.length} suite(s)`);
  }

  async function customCheck(criterion: AcceptanceCriterion): Promise<AcceptanceOutcome> {
    if (criterion.checkId === undefined) return unsatisfied(criterion, 'criterion does not name a checkId');
    const check = customChecks[criterion.checkId];
    if (check === undefined) {
      return unsatisfied(
        criterion,
        `no deterministic check is registered for "${criterion.checkId}"`,
        `registered: ${Object.keys(customChecks).sort().join(', ') || '(none)'}`,
      );
    }
    const result = await check({
      runId: input.runId,
      artifacts: input.artifacts,
      generated: input.generated,
      findings: input.findings,
      testRuns,
      payloadOf,
    });
    return result.satisfied
      ? satisfiedOutcome(criterion, result.observed ?? 'check passed')
      : unsatisfied(criterion, result.reason ?? 'check reported the criterion is not met', result.observed);
  }
}

function describeMissing(kind: ArtifactKind, expectation: ArtifactExpectation | undefined, runId: RunId): string {
  const where = expectation?.relativePath !== undefined ? ` at ${expectation.relativePath}` : '';
  return `no artifact of kind "${kind}"${where} exists for run ${runId}`;
}

function satisfiedOutcome(criterion: AcceptanceCriterion, observed: string): AcceptanceOutcome {
  return { criterionId: criterion.id, satisfied: true, observed: clip(observed, 1000) };
}

function unsatisfied(criterion: AcceptanceCriterion, reason: string, observed?: string): AcceptanceOutcome {
  return {
    criterionId: criterion.id,
    satisfied: false,
    reason: clip(reason, 2000),
    ...(observed !== undefined ? { observed: clip(observed, 1000) } : {}),
  };
}

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_REPORTED_ITEMS).join(', ');
  return ids.length > MAX_REPORTED_ITEMS ? `${shown}, … (${ids.length} total)` : shown;
}

/** The ellipsis is part of the string, so it comes out of the budget: total length never exceeds `max`. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
