import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './repo-root.js';
import { normalizeEvidenceList, normalizeUnknown } from './specification.js';
import type { Evidence, SpecUnknown } from './specification.js';

export interface Finding {
  id: string;
  kind: string;
  summary: string;
  severity: string | null;
  epistemicStatus: string | null;
  confidence: number | null;
  affectedComponents: string[];
  relatedRuleIds: string[];
  relatedInvariantIds: string[];
  evidence: Evidence[];
}

export interface FindingsSection {
  heading: string;
  body: string;
}

export interface FindingsView {
  findings: Finding[];
  openQuestions: SpecUnknown[];
  sections: FindingsSection[];
  summary: string | null;
  problems: string[];
}

export function loadFindings(ws: Workspace, runId: string): FindingsView {
  const fileName = 'findings.json';
  const file = path.join(ws.artifactsDir, runId, 'discovery', fileName);
  if (!existsSync(file)) {
    return {
      findings: [],
      openQuestions: [],
      sections: [],
      summary: null,
      problems: [`${fileName} missing`],
    };
  }
  const problems: string[] = [];
  const payload = readPayload(file, fileName, problems);
  if (payload === null) {
    return { findings: [], openQuestions: [], sections: [], summary: null, problems };
  }
  return {
    findings: normalizeFindings(payload.findings, fileName, problems),
    openQuestions: normalizeOpenQuestions(payload.openQuestions, fileName, problems),
    sections: normalizeSections(payload.sections, fileName, problems),
    summary: normalizeSummary(payload.summary, fileName, problems),
    problems,
  };
}

function readPayload(
  file: string,
  fileName: string,
  problems: string[],
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    problems.push(`${fileName}: unparseable JSON`);
    return null;
  }
  const payload = asRecord(asRecord(parsed)?.payload);
  if (payload === null) {
    problems.push(`${fileName}: payload is not an object`);
    return null;
  }
  return payload;
}

function normalizeFindings(raw: unknown, fileName: string, problems: string[]): Finding[] {
  if (!Array.isArray(raw)) {
    problems.push(`${fileName}: payload.findings is not an array`);
    return [];
  }
  const out: Finding[] = [];
  for (const [index, item] of raw.entries()) {
    const finding = normalizeFinding(item, fileName, index, problems);
    if (finding !== null) out.push(finding);
  }
  return out;
}

function normalizeFinding(
  raw: unknown,
  fileName: string,
  index: number,
  problems: string[],
): Finding | null {
  const record = asRecord(raw);
  const id = record?.id;
  const kind = record?.kind;
  const summary = record?.summary;
  if (
    record === null ||
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof kind !== 'string' ||
    kind.length === 0 ||
    typeof summary !== 'string' ||
    summary.length === 0
  ) {
    problems.push(`${fileName}: dropped finding ${index + 1}: missing id, kind, or summary`);
    return null;
  }
  return {
    id,
    kind,
    summary,
    severity: asString(record.severity),
    epistemicStatus: asString(record.epistemicStatus),
    confidence: asNumber(record.confidence),
    affectedComponents: stringArray(record.affectedComponents),
    relatedRuleIds: stringArray(record.relatedRuleIds),
    relatedInvariantIds: stringArray(record.relatedInvariantIds),
    evidence: normalizeEvidenceList(record.evidence, `finding ${id}`, fileName, problems),
  };
}

function normalizeOpenQuestions(raw: unknown, fileName: string, problems: string[]): SpecUnknown[] {
  if (!Array.isArray(raw)) {
    problems.push(`${fileName}: payload.openQuestions is not an array`);
    return [];
  }
  const out: SpecUnknown[] = [];
  for (const [index, item] of raw.entries()) {
    const question = normalizeUnknown(item, fileName, index, problems);
    if (question !== null) out.push(question);
  }
  return out;
}

function normalizeSections(raw: unknown, fileName: string, problems: string[]): FindingsSection[] {
  if (!Array.isArray(raw)) {
    problems.push(`${fileName}: payload.sections is not an array`);
    return [];
  }
  const out: FindingsSection[] = [];
  for (const [index, item] of raw.entries()) {
    const record = asRecord(item);
    const heading = record?.heading;
    const body = record?.body;
    if (
      record === null ||
      typeof heading !== 'string' ||
      heading.length === 0 ||
      typeof body !== 'string' ||
      body.length === 0
    ) {
      problems.push(`${fileName}: dropped section ${index + 1}: missing heading or body`);
      continue;
    }
    out.push({ heading, body });
  }
  return out;
}

function normalizeSummary(raw: unknown, fileName: string, problems: string[]): string | null {
  if (raw === undefined) return null;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  problems.push(`${fileName}: summary is not a string`);
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
