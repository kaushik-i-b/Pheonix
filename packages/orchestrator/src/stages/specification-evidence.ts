import {
  anchorQuote,
  MAX_SPAN_LINES,
  type CitationRewriteOutcome,
  type CitationRewriteRequest,
} from '@phoenix/agent-runtime';
import type { ProposedCheck } from '@phoenix/shared';
import { type ModelEvidence } from './discovery-schema.js';
import {
  analystReportSchema,
  type AnalystReport,
  type ModelEdgeCase,
  type ModelInvariant,
  type ModelRule,
} from './specification-schema.js';

const MAX_NOTES = 12;
const NOTE_LIMIT = 500;
const MAX_FEEDBACK = 8;
const FEEDBACK_LIMIT = 500;

type CitationRead = CitationRewriteRequest<AnalystReport>['read'];

type EvidenceOutcome =
  | { kind: 'resolved'; evidence: ModelEvidence; note?: string }
  | { kind: 'unresolved'; reason: string; definitive: boolean };

interface EvidenceListOutcome {
  evidence: ModelEvidence[];
  unresolved: boolean;
  indeterminate: boolean;
}

export async function anchorSpecificationCitations(
  request: CitationRewriteRequest<AnalystReport>,
): Promise<CitationRewriteOutcome<AnalystReport>> {
  const { value: report, read, attemptsExhausted } = request;
  const notes: string[] = [];
  const feedback: string[] = [];
  const rules: ModelRule[] = [];

  for (const rule of report.rules) {
    const source = await anchorEvidenceList(
      rule.ruleId,
      rule.sourceEvidence,
      read,
      notes,
      feedback,
      attemptsExhausted,
    );
    if (source.indeterminate || (source.unresolved && !attemptsExhausted)) {
      return rejected(notes, feedback);
    }

    const edgeCases: ModelEdgeCase[] = [];
    for (const edgeCase of rule.edgeCases) {
      const edge = await anchorEvidenceList(
        `${rule.ruleId}/${edgeCase.id}`,
        edgeCase.evidence,
        read,
        notes,
        feedback,
        attemptsExhausted,
      );
      if (edge.indeterminate || (edge.unresolved && !attemptsExhausted)) {
        return rejected(notes, feedback);
      }
      if (edgeCase.evidence.length > 0 && edge.evidence.length === 0) {
        notes.push(
          clip(
            `dropped edge case ${rule.ruleId}/${edgeCase.id}: none of its citations could be anchored`,
            NOTE_LIMIT,
          ),
        );
        continue;
      }
      edgeCases.push({ ...edgeCase, evidence: edge.evidence });
    }

    if (rule.sourceEvidence.length > 0 && source.evidence.length === 0) {
      notes.push(
        clip(
          `demoted ${rule.ruleId}: no source citation could be anchored, so the claim cannot remain in the specification`,
          NOTE_LIMIT,
        ),
      );
    }
    rules.push({ ...rule, sourceEvidence: source.evidence, edgeCases });
  }

  const invariants: ModelInvariant[] = [];
  for (const invariant of report.invariants) {
    const source = await anchorEvidenceList(
      invariant.invariantId,
      invariant.sourceEvidence,
      read,
      notes,
      feedback,
      attemptsExhausted,
    );
    if (source.indeterminate || (source.unresolved && !attemptsExhausted)) {
      return rejected(notes, feedback);
    }
    if (invariant.sourceEvidence.length > 0 && source.evidence.length === 0) {
      notes.push(
        clip(
          `demoted ${invariant.invariantId}: no source citation could be anchored, so the claim cannot remain in the specification`,
          NOTE_LIMIT,
        ),
      );
    }
    invariants.push({ ...invariant, sourceEvidence: source.evidence });
  }

  const droppedRuleIds = new Set(
    rules.filter((rule) => rule.sourceEvidence.length === 0).map((rule) => rule.ruleId),
  );
  const droppedInvariantIds = new Set(
    invariants
      .filter((invariant) => invariant.sourceEvidence.length === 0)
      .map((invariant) => invariant.invariantId),
  );
  const candidate = {
    ...report,
    rules: rules.map((rule) => ({
      ...rule,
      proposedChecks: rule.proposedChecks.filter((check) =>
        targetsSurvivingClaim(check, droppedRuleIds, droppedInvariantIds),
      ),
      contradictsRuleIds: rule.contradictsRuleIds.filter((id) => !droppedRuleIds.has(id)),
      derivedFromInvariantIds: rule.derivedFromInvariantIds.filter(
        (id) => !droppedInvariantIds.has(id),
      ),
    })),
    invariants: invariants.map((invariant) => ({
      ...invariant,
      derivedFromRuleIds: invariant.derivedFromRuleIds.filter((id) => !droppedRuleIds.has(id)),
    })),
    unknowns: report.unknowns.map((unknown) => ({
      ...unknown,
      relatedRuleIds: unknown.relatedRuleIds.filter((id) => !droppedRuleIds.has(id)),
      relatedInvariantIds: unknown.relatedInvariantIds.filter((id) => !droppedInvariantIds.has(id)),
    })),
  };
  const parsed = analystReportSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join('; ');
    notes.push(
      clip(
        `the rewritten specification is still not schema-valid and was not returned: ${issues}`,
        NOTE_LIMIT,
      ),
    );
    // The host's own rewrite came back invalid, so nothing is returned and the model answers again.
    // Saying only "still not schema-valid" leaves it guessing which field, so the issues are carried
    // into the rejection; it leads the list because the per-citation diagnoses below are capped.
    const schemaFeedback = clip(
      `the host's citation rewrite did not produce a schema-valid specification: ${issues}. ` +
        `Resubmit with short exact quotes for every claim you keep, and record anything you cannot support under unknowns`,
      FEEDBACK_LIMIT,
    );
    return rejected(notes, [schemaFeedback, ...feedback]);
  }
  return { value: parsed.data, notes: capNotes(notes) };
}

async function anchorEvidenceList(
  claimId: string,
  evidence: readonly ModelEvidence[],
  read: CitationRead,
  notes: string[],
  feedback: string[],
  attemptsExhausted: boolean,
): Promise<EvidenceListOutcome> {
  const kept: ModelEvidence[] = [];
  let unresolved = false;
  let indeterminate = false;
  for (let index = 0; index < evidence.length; index += 1) {
    const item = evidence[index];
    if (item === undefined) continue;
    const outcome = await anchorEvidenceItem(claimId, index + 1, item, read);
    if (outcome.kind === 'resolved') {
      kept.push(outcome.evidence);
      if (outcome.note !== undefined) notes.push(outcome.note);
    } else {
      unresolved = true;
      indeterminate ||= !outcome.definitive;
      const disposition = attemptsExhausted && outcome.definitive ? 'dropped' : 'could not anchor';
      notes.push(
        clip(
          `${disposition} citation ${claimId}/ev-${index + 1} (${item.path}): ${outcome.reason}`,
          NOTE_LIMIT,
        ),
      );
      feedback.push(
        clip(`${claimId}/ev-${index + 1} (${item.path}): ${outcome.reason}`, FEEDBACK_LIMIT),
      );
    }
  }
  return { evidence: kept, unresolved, indeterminate };
}

async function anchorEvidenceItem(
  claimId: string,
  evidenceNumber: number,
  item: ModelEvidence,
  read: CitationRead,
): Promise<EvidenceOutcome> {
  const outcome = await read(item.path);
  if (outcome.text === undefined) {
    return {
      kind: 'unresolved',
      reason: `the file could not be read: ${outcome.problem ?? 'unknown error'}`,
      definitive: outcome.definitive === true,
    };
  }
  const anchored = anchorQuote({
    fileText: outcome.text,
    quote: item.quote,
    ...(item.startLine !== undefined ? { citedStartLine: item.startLine } : {}),
  });
  if (
    anchored.kind === 'unresolved' ||
    anchored.startLine === undefined ||
    anchored.endLine === undefined ||
    anchored.quote === undefined
  ) {
    return {
      kind: 'unresolved',
      reason: unanchoredReason(anchored.score, item.quote),
      definitive: true,
    };
  }

  const citedSpanWrong =
    (item.startLine !== undefined && item.startLine !== anchored.startLine) ||
    (item.endLine !== undefined && item.endLine !== anchored.endLine);
  const provenance =
    anchored.kind === 'anchored'
      ? `host-anchored to real bytes at lines ${anchored.startLine}-${anchored.endLine} of ${item.path} (model quote paraphrased or fused; similarity ${anchored.score.toFixed(2)})`
      : citedSpanWrong
        ? `host-corrected cited line span to ${anchored.startLine}-${anchored.endLine} of ${item.path}`
        : undefined;
  const note =
    provenance === undefined
      ? item.note
      : clip(item.note === undefined ? provenance : `${provenance}; ${item.note}`, NOTE_LIMIT);
  const evidence: ModelEvidence = {
    path: item.path,
    quote: anchored.quote,
    startLine: anchored.startLine,
    endLine: anchored.endLine,
    ...(item.symbol !== undefined ? { symbol: item.symbol } : {}),
    ...(note !== undefined ? { note } : {}),
  };
  const runNote =
    anchored.kind === 'anchored'
      ? `host-anchored ${claimId}/ev-${evidenceNumber} in ${item.path} to real bytes at lines ${anchored.startLine}-${anchored.endLine} (similarity ${anchored.score.toFixed(2)})`
      : citedSpanWrong
        ? `corrected the line span of ${claimId}/ev-${evidenceNumber} in ${item.path} to ${anchored.startLine}-${anchored.endLine}`
        : undefined;
  return {
    kind: 'resolved',
    evidence,
    ...(runNote !== undefined ? { note: clip(runNote, NOTE_LIMIT) } : {}),
  };
}

function targetsSurvivingClaim(
  check: ProposedCheck,
  droppedRuleIds: ReadonlySet<string>,
  droppedInvariantIds: ReadonlySet<string>,
): boolean {
  return (
    (check.targetsRuleId === undefined || !droppedRuleIds.has(check.targetsRuleId)) &&
    (check.targetsInvariantId === undefined || !droppedInvariantIds.has(check.targetsInvariantId))
  );
}

function capNotes(notes: readonly string[]): string[] {
  if (notes.length <= MAX_NOTES) return [...notes];
  return [
    ...notes.slice(0, MAX_NOTES - 1),
    `(+${notes.length - (MAX_NOTES - 1)} more citation adjustment(s); every host read is in the task's tool log)`,
  ];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A rewrite that proves nothing: the loop keeps the rejection and gives the model another attempt. */
function rejected(
  notes: readonly string[],
  feedback: readonly string[],
): CitationRewriteOutcome<AnalystReport> {
  return {
    notes: capNotes(notes),
    ...(feedback.length > 0 ? { feedback: capFeedback(feedback) } : {}),
  };
}

function capFeedback(feedback: readonly string[]): string[] {
  return feedback.slice(0, MAX_FEEDBACK);
}

/**
 * Why a quote did not anchor, and what a resubmission has to look like.
 *
 * "Not found" alone leaves the model to guess between paraphrase, fusion of two places, and
 * invention, and the three need different repairs. The span limit is read from the anchorer rather
 * than restated, so this message can never promise a citation length the gate would then refuse.
 */
function unanchoredReason(score: number, quote: string): string {
  const nonBlank = quote.split('\n').filter((line) => line.trim().length > 0).length;
  return (
    `no contiguous run of its ${nonBlank} quoted line(s) appears in the file (best similarity ${score.toFixed(2)}); ` +
    `the quote was paraphrased, fused from separate places, or invented. Re-extract at most ${MAX_SPAN_LINES} ` +
    `contiguous lines copied exactly from the bytes read_file returned, cite each supporting place ` +
    `separately, or drop the claim and record it under unknowns`
  );
}
