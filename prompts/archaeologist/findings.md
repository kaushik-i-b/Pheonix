---
id: archaeologist.findings
version: 1.1.1
description: Task prompt that turns deterministic discovery output into an evidenced archaeological report.
audience: archaeologist
outputSchemaId: archaeologist.report
requiredVariables: objective, context, digest
---
# Objective

{{objective}}

# What Phoenix already knows (deterministic static analysis)

{{context}}

## Discovery digest

{{digest}}

The digest is a summary, not the repository. Use `read_file`, `list_files` and `search_repository`
to read the actual source before you claim anything about it. Paths in the digest are relative to
the repository root, and the paths you cite must be too. The digest quotes fragments of source text
to draw your attention — a quote copied from the digest is almost always attributed to the wrong
file and is rejected; copy every quote from a file you opened with `read_file` in this task.

# Your report

Reply with **only** a JSON object — no prose before or after it, no code fences — with the shape
below. Every value shown as `<...>` is a placeholder: it is not a real path, id or quote, and a
reply that still contains any `<` or `>` placeholder text, or any placeholder word like YOUR, is
rejected. Fill every field with what you actually observed in **this** repository. Before your
answer is accepted, Phoenix verifies every citation against the real files: a `path` that does not
exist, a `startLine` past the end of the file, a `quote` that does not appear in that file, or a
citation to a file you never opened with `read_file` during this task — even when the quote is
verbatim correct — causes the answer to be rejected with the exact violation listed, and you get one
chance to fix it.

```json
{
  "summary": "Two or three sentences saying what this system is and where its behaviour actually lives.",
  "sections": [
    {
      "heading": "What the system does",
      "body": "Markdown prose. Say what the domain objects are, which routes carry real work, and which parts of the codebase are load-bearing versus vestigial."
    },
    {
      "heading": "Where behaviour hides",
      "body": "Database triggers and functions, scheduled jobs, rounding modes, ordering assumptions, transaction boundaries, retry semantics — anything a naive rewrite would drop."
    },
    {
      "heading": "Migration hazards",
      "body": "The specific constructs that make this risky: drifted duplicates, swallowed exceptions, mutable static state, magic numbers, missing authorization on one of two twin routes."
    }
  ],
  "findings": [
    {
      "id": "F-<YOUR-FINDING-SLUG>",
      "kind": "behavior",
      "summary": "What the behaviour is, in one sentence, stated as a claim about the system.",
      "detail": "Optional longer explanation, including why the difference matters and what would settle it.",
      "epistemicStatus": "OBSERVED",
      "confidence": 0.9,
      "severity": "MAJOR",
      "affectedComponents": ["<relative/path/you/actually/read.java>"],
      "evidence": [
        {
          "path": "<relative/path/you/actually/read.java>",
          "startLine": 1,
          "symbol": "<ClassOrFile>#<method>",
          "quote": "<text copied verbatim from that file>",
          "note": "Optional: why this quote matters."
        }
      ]
    }
  ],
  "openQuestions": [
    {
      "id": "Q-<YOUR-QUESTION-SLUG>",
      "question": "A question about behaviour you could not settle by reading code.",
      "whyItMatters": "Why the migration would be wrong or risky if this stays unknown.",
      "resolutionStrategy": "runtime-probe"
    }
  ]
}
```

Field rules — a reply that violates them is rejected and you will be told which field failed:

* `summary`: 40–4000 characters.
* `sections`: 3 to 12 entries; `heading` and `body` are markdown prose, `body` up to 20000 characters.
* `findings[].id`: `F-` followed by uppercase letters, digits and dashes (for example `F-LEDGER-IMMUTABLE`).
* `findings[].kind`: one of `behavior`, `business-rule-candidate`, `invariant-candidate`, `risk`,
  `anomaly`, `duplication`, `dead-code`, `data-flow`, `entry-point`, `dependency`, `configuration`,
  `suspicious-behavior`, `mismatch`, `gap`.
* `findings[].epistemicStatus`: `OBSERVED`, `INFERRED` or `UNKNOWN`.
* `findings[].confidence`: a number from 0 to 1 — your honest confidence, not a formality.
* `findings[].severity`: optional; `CRITICAL`, `MAJOR`, `MINOR` or `INFO`.
* `findings[].evidence`: 1 to 6 entries. Each needs `path` (relative to the repository root) and
  `quote` — text copied verbatim from that file, whitespace aside. `startLine` and `symbol` are
  optional but strongly preferred. Every citation is verified against the real file, and the file
  must be one you opened with `read_file` during this task. Keep each quote to the lines that
  actually carry the claim — a few statements, one method at most. Quoting an entire file or a
  hundred-line region is rejected as copied text far more often than it is accepted.
* `openQuestions[].id`: `Q-` followed by uppercase letters, digits and dashes.
* `openQuestions[].resolutionStrategy`: `runtime-probe`, `characterization-test`,
  `differential-scenario`, `human-input` or `unresolvable`.

Before answering, read at least three files the digest points at with `read_file`. Findings must
describe code you actually read with your tools; the digest alone is context, not evidence. An answer
submitted before you have opened any file is rejected outright, whatever it says. Produce
3 to 10 findings — real, evidenced behaviour from this repository, with `F-` ids you invent for it.
Prefer fewer, well-evidenced findings over many vague ones. Anything you could not establish goes
into `openQuestions` with the strategy that would settle it — do not promote a guess to a finding.
