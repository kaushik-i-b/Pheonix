#!/usr/bin/env node
/**
 * score-discovery.mjs - score Phoenix's discovered rules/invariants against
 * the legacy-bank ground truth. Dependency-free Node ESM.
 *
 * Usage:
 *   node score-discovery.mjs --discovered findings.json [--ground-truth gt.json] [--strict]
 *
 * Discovered file shape:
 *   { "rules": [{ "id", "description", "evidence": [] }],
 *     "invariants": [{ "id", "statement", "description" }] }
 *
 * Matching (case-insensitive substring) per ground-truth behavior:
 *   FOUND if any discovered item's text matches >= 2 matchKeywords,
 *   OR it contains relatedInvariantKind plus >= 1 matchKeyword.
 *
 * Prints a per-behavior table + recall, then one JSON summary line.
 * Exit non-zero on recall < 100% only with --strict.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { discovered: null, groundTruth: resolve(here, "ground-truth.json"), strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--discovered") args.discovered = argv[++i];
    else if (a === "--ground-truth") args.groundTruth = argv[++i];
    else if (a === "--strict") args.strict = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.discovered) {
    console.error("missing --discovered <file.json>");
    process.exit(2);
  }
  return args;
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`failed to read ${path}: ${e.message}`);
    process.exit(2);
  }
}

function discoveredTexts(doc) {
  const texts = [];
  for (const r of Array.isArray(doc.rules) ? doc.rules : []) {
    const parts = [r.id, r.title, r.description, Array.isArray(r.evidence) ? r.evidence.join(" ") : String(r.evidence ?? "")];
    texts.push(parts.filter(Boolean).join("\n").toLowerCase());
  }
  for (const inv of Array.isArray(doc.invariants) ? doc.invariants : []) {
    const parts = [inv.id, inv.title, inv.statement, inv.description];
    texts.push(parts.filter(Boolean).join("\n").toLowerCase());
  }
  return texts.filter((t) => t.trim().length > 0);
}

function matches(text, behavior) {
  const keywords = (behavior.matchKeywords ?? []).map((k) => k.toLowerCase());
  const hitCount = keywords.filter((k) => text.includes(k)).length;
  if (hitCount >= 2) return true;
  const kind = (behavior.relatedInvariantKind ?? "").toLowerCase();
  if (kind && text.includes(kind) && hitCount >= 1) return true;
  return false;
}

const args = parseArgs(process.argv.slice(2));
const gt = loadJson(args.groundTruth);
const discovered = loadJson(args.discovered);

if (gt.version !== 1) {
  console.error(`unsupported ground-truth version: ${gt.version}`);
  process.exit(2);
}

const texts = discoveredTexts(discovered);
const behaviors = Array.isArray(gt.behaviors) ? gt.behaviors : [];
const rows = [];
let found = 0;

for (const b of behaviors) {
  const hit = texts.some((t) => matches(t, b));
  if (hit) found++;
  rows.push({ id: b.id, title: b.title ?? "", status: hit ? "FOUND" : "MISSED" });
}

const missed = rows.length - found;
const recall = rows.length === 0 ? 0 : (found / rows.length) * 100;

const idW = Math.max(4, ...rows.map((r) => r.id.length));
const stW = 6;
console.log("=".repeat(78));
console.log(`legacy-bank discovery score  (target: ${gt.target}, key version ${gt.version})`);
console.log(`discovered items: ${texts.length}   ground-truth behaviors: ${rows.length}`);
console.log("=".repeat(78));
console.log(`${"ID".padEnd(idW)}  ${"STATUS".padEnd(stW)}  TITLE`);
console.log("-".repeat(78));
for (const r of rows) {
  console.log(`${r.id.padEnd(idW)}  ${r.status.padEnd(stW)}  ${r.title}`);
}
console.log("-".repeat(78));
console.log(`FOUND ${found}/${rows.length}   MISSED ${missed}   recall ${recall.toFixed(1)}%`);

const summary = {
  target: gt.target,
  total: rows.length,
  found,
  missed,
  missedIds: rows.filter((r) => r.status === "MISSED").map((r) => r.id),
  recallPercent: Number(recall.toFixed(2)),
  strict: args.strict,
  pass: args.strict ? recall === 100 : true,
};
console.log(`SUMMARY ${JSON.stringify(summary)}`);

if (args.strict && recall < 100) process.exit(1);
