import {
  anchorQuote,
  type CitationRewriteOutcome,
  type CitationRewriteRequest,
} from '@phoenix/agent-runtime';
import {
  archaeologistReportSchema,
  type ArchaeologistReport,
  type ModelEvidence,
  type ModelFinding,
  type ModelOpenQuestion,
} from './discovery-schema.js';

/**
 * Host anchoring for the Archaeologist's citations.
 *
 * The 7B can find the right file and the right neighbourhood but not reproduce Java bytes: it
 * paraphrases method bodies and fuses distant SQL fragments into one quote. The verbatim gate is
 * right to reject those, and the ordinary repair rounds give the model a chance to copy the bytes it
 * was handed — but two of them are not enough for a model that cannot copy. This policy is the
 * honest third path between rejecting the whole report and weakening the gate: the host locates each
 * rejected quote in the repository's real bytes (quote-anchor.ts), rewrites the evidence to what the
 * file actually says, and leaves a provenance note on every item it touched.
 *
 * What each outcome means on the last attempt, when no repair round remains:
 *  - the quote anchors to real bytes  → kept, with the real bytes and real line span;
 *  - the quote cannot be located      → the citation is dropped; if that leaves the finding with no
 *    evidence at all, the finding is demoted to an open question rather than asserted unsupported.
 *
 * Nothing here decides whether a claim is TRUE; it decides whether the bytes it cites say what it
 * quotes. That distinction is the same one the ordinary citation check makes.
 */

const MAX_NOTES = 12;
const NOTE_LIMIT = 500;
const WHY_IT_MATTERS_LIMIT = 2000;
const OPEN_QUESTION_LIMIT = 40;

type CitationRead = CitationRewriteRequest<ArchaeologistReport>['read'];

interface ResolvedItem {
  kind: 'resolved';
  evidence: ModelEvidence;
  note?: string;
}

interface UnresolvedItem {
  kind: 'unresolved';
  reason: string;
  definitive: boolean;
}

type ItemOutcome = ResolvedItem | UnresolvedItem;

export async function anchorReportCitations(
  request: CitationRewriteRequest<ArchaeologistReport>,
): Promise<CitationRewriteOutcome<ArchaeologistReport>> {
  const { value: report, read, attemptsExhausted } = request;
  const notes: string[] = [];

  const keptFindings: ModelFinding[] = [];
  const demotedFindings: ModelFinding[] = [];
  for (const finding of report.findings) {
    const keptEvidence: ModelEvidence[] = [];
    for (let index = 0; index < finding.evidence.length; index += 1) {
      const item = finding.evidence[index];
      if (item === undefined) continue;
      const outcome = await anchorEvidenceItem(finding.id, index + 1, item, read);
      if (outcome.kind === 'resolved') {
        keptEvidence.push(outcome.evidence);
        if (outcome.note !== undefined) notes.push(outcome.note);
        continue;
      }
      if (!attemptsExhausted || !outcome.definitive) {
        // A repair round remains, or the host could not read the complete file. Leave the report alone;
        // only a complete read proving the quote absent can justify dropping evidence.
        notes.push(
          clip(
            `could not anchor ${finding.id}/ev-${index + 1} (${item.path}): ${outcome.reason}`,
            NOTE_LIMIT,
          ),
        );
        return { notes: capNotes(notes) };
      }
      notes.push(
        clip(
          `dropped citation ${finding.id}/ev-${index + 1} (${item.path}): ${outcome.reason}`,
          NOTE_LIMIT,
        ),
      );
    }
    if (keptEvidence.length > 0) {
      // Always use the anchored evidence, even when nothing was dropped: a verbatim quote with a
      // wrong cited span, or an anchored rewrite, has corrected bytes that must replace the original.
      keptFindings.push({ ...finding, evidence: keptEvidence });
    } else {
      demotedFindings.push(finding);
    }
  }

  const takenIds = new Set(report.openQuestions.map((question) => question.id));
  const demotedQuestions: ModelOpenQuestion[] = [];
  for (const finding of demotedFindings) {
    if (report.openQuestions.length + demotedQuestions.length >= OPEN_QUESTION_LIMIT) {
      notes.push(
        clip(
          `left ${finding.id} out of the report entirely: every citation failed anchoring and the open-questions list is full`,
          NOTE_LIMIT,
        ),
      );
      continue;
    }
    const question = demoteToQuestion(finding, takenIds);
    takenIds.add(question.id);
    demotedQuestions.push(question);
    notes.push(
      clip(
        `demoted ${finding.id} to ${question.id}: no citation could be anchored, so the claim is recorded as an open question instead of an assertion`,
        NOTE_LIMIT,
      ),
    );
  }

  if (droppedItemsAcross(keptFindings, report) === 0 && demotedQuestions.length === 0) {
    // Every citation already resolved against the file — the only possible residual problem was the
    // read-before-cite gate, which the host's own reads above satisfy. Re-checking is the caller's job.
    return { value: rebuild(report, keptFindings, []), notes: capNotes(notes) };
  }

  const candidate = rebuild(report, keptFindings, demotedQuestions);
  const parsed = archaeologistReportSchema.safeParse(candidate);
  if (!parsed.success) {
    notes.push(
      clip(
        `the rewritten report is still not schema-valid and was not returned: ${parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
        NOTE_LIMIT,
      ),
    );
    return { notes: capNotes(notes) };
  }
  return { value: parsed.data, notes: capNotes(notes) };
}

async function anchorEvidenceItem(
  claimId: string,
  evidenceNumber: number,
  item: ModelEvidence,
  read: CitationRead,
): Promise<ItemOutcome> {
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
      reason: `its quote was not found in the file (best similarity ${anchored.score.toFixed(2)}); it may have been paraphrased or invented`,
      definitive: true,
    };
  }
  const { startLine, endLine, quote } = anchored;
  const citedSpanWrong =
    (item.startLine !== undefined && item.startLine !== startLine) ||
    (item.endLine !== undefined && item.endLine !== endLine);
  const provenance =
    anchored.kind === 'anchored'
      ? `host-anchored to real bytes at lines ${startLine}-${endLine} of ${item.path} (model quote paraphrased or fused; similarity ${anchored.score.toFixed(2)})`
      : citedSpanWrong
        ? `host-corrected cited line span to ${startLine}-${endLine} of ${item.path}`
        : undefined;
  const note =
    provenance === undefined
      ? item.note
      : clip(item.note === undefined ? provenance : `${provenance}; ${item.note}`, NOTE_LIMIT);
  const evidence: ModelEvidence = {
    path: item.path,
    quote,
    startLine,
    endLine,
    ...(item.symbol !== undefined ? { symbol: item.symbol } : {}),
    ...(note !== undefined ? { note } : {}),
  };
  const noteForRun =
    anchored.kind === 'anchored'
      ? `host-anchored ${claimId}/ev-${evidenceNumber} in ${item.path} to real bytes at lines ${startLine}-${endLine} (similarity ${anchored.score.toFixed(2)})`
      : citedSpanWrong
        ? `corrected the line span of ${claimId}/ev-${evidenceNumber} in ${item.path} to ${startLine}-${endLine}`
        : undefined;
  return {
    kind: 'resolved',
    evidence,
    ...(noteForRun !== undefined ? { note: clip(noteForRun, NOTE_LIMIT) } : {}),
  };
}

function demoteToQuestion(finding: ModelFinding, taken: ReadonlySet<string>): ModelOpenQuestion {
  const stem = finding.id.slice(2);
  let id = `Q-${stem}`;
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `Q-${stem.slice(0, 36)}-${suffix}`;
  }
  const reason =
    'its citations could not be anchored to the repository during host review, so it is recorded as an open question instead of being asserted without evidence';
  const whyItMatters =
    finding.detail === undefined ? reason : `${reason}. Original detail: ${finding.detail}`;
  return {
    id,
    question: finding.summary,
    whyItMatters: whyItMatters.slice(0, WHY_IT_MATTERS_LIMIT),
    resolutionStrategy: 'runtime-probe',
  };
}

function rebuild(
  report: ArchaeologistReport,
  findings: readonly ModelFinding[],
  demoted: readonly ModelOpenQuestion[],
): ArchaeologistReport {
  return {
    summary: report.summary,
    sections: report.sections,
    findings: [...findings],
    openQuestions: [...report.openQuestions, ...demoted],
  };
}

function droppedItemsAcross(kept: readonly ModelFinding[], report: ArchaeologistReport): number {
  const keptCount = kept.reduce((sum, finding) => sum + finding.evidence.length, 0);
  const originalCount = report.findings.reduce((sum, finding) => sum + finding.evidence.length, 0);
  return originalCount - keptCount;
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
