# legacy-bank benchmark — ANSWER KEY (do not ship to Phoenix)

This directory is the **ground truth** for the `examples/legacy-bank` demo
workload. It exists to score how much of the legacy system's hidden
behavior Phoenix discovers autonomously.

> **`ground-truth.json` must NEVER be given to Phoenix** (not in its repo
> snapshot, context, prompts, or retrieval corpus). Phoenix only sees
> `examples/legacy-bank/`. Everything here is grader-side.

## Contents

| File | Purpose |
| ---- | ------- |
| `ground-truth.json` | Machine-readable answer key, schema version 1. One entry per hidden behavior (LB-001 … LB-016) with code locations, an exact reproducible observable, the naive-rewrite failure mode, match keywords, and the related invariant kind. |
| `score-discovery.mjs` | Dependency-free Node ESM scorer. Compares Phoenix's discovered rules/invariants against the key. |
| `probe.sh` | Black-box probe: curls a **running** instance (plus `psql` for DB-side assertions) and exercises every ground-truth behavior, printing actual vs expected. This is the reality check that keeps the answer key honest. |

## Scoring

Phoenix (or a human grader) produces a discovery file shaped like:

```json
{
  "rules":      [{ "id": "R1", "description": "...", "evidence": ["file:line", "..."] }],
  "invariants": [{ "id": "I1", "statement": "...", "description": "..." }]
}
```

Then run:

```bash
node score-discovery.mjs --discovered phoenix-findings.json
node score-discovery.mjs --discovered phoenix-findings.json --ground-truth ground-truth.json --strict
```

Deterministic matching (case-insensitive substrings over each discovered
rule/invariant's `id + description + evidence` / `id + statement + description`):

- a ground-truth behavior counts as **FOUND** when one discovered item
  matches **>= 2** of its `matchKeywords`, **OR**
- it contains the behavior's `relatedInvariantKind` **plus at least one**
  keyword.

The scorer prints a per-behavior FOUND/MISSED table, recall %, and a final
one-line JSON summary. Exit status is non-zero on recall < 100% **only**
with `--strict`.

## Verifying the key against reality

The key is only valid if the app actually behaves as documented:

```bash
cd ../../examples/legacy-bank
./db/reset.sh && ./run.sh          # fresh book, migrations replay
../../benchmarks/legacy-bank/probe.sh
```

`probe.sh` is rerunnable against a live instance (it namespaces its
idempotency keys per run) and exits non-zero if any documented observable
fails to reproduce. If probe and key disagree, fix one of them before
scoring anyone.
