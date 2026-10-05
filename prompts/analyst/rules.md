---
id: analyst.rules
version: 1.0.6
description: Task prompt that turns archaeological findings into an evidenced set of candidate business rules and invariants.
audience: business-rule-analyst
outputSchemaId: analyst.report
requiredVariables: objective, context, brief
---

# Objective

{{objective}}

# What discovery established

{{context}}

## Findings brief ({{briefChars}} characters)

{{brief}}

The brief carries the Archaeologist's claims and their citations — {{findingCount}} finding(s) and
{{openQuestionCount}} open question(s). It is a starting point. Open the cited files with
`read_file`, `list_files` and `search_repository` and read past the quoted line before you turn an
observation into a rule. Quotes you inherit from the brief belong to the Archaeologist's reading,
not yours: copy each `quote` from the file itself, opened with `read_file` in this task, or the
citation will not verify. An answer submitted before you have opened any file is rejected outright.
Paths are relative to `{{repositoryRoot}}`, and the paths you cite must be
too.

# Your specification

Reply with **only** one JSON object — no prose before or after it, no code fences. The object must
be complete. A reply cut off by the token limit is rejected, and a nested object inside an
unfinished document is not this report.

## Compactness

Keep the report small enough to finish in one reply:

- 3 to 5 rules you can support from files you opened in this task. Omit the rest.
- 1 to 2 invariants you can support the same way.
- Short exact citations. Each `quote` is the smallest verbatim span that still contains every
  condition the claim depends on: the comparison, the constant, the rounding mode, the exception,
  the status. Do not drop a condition to save space, and do not paste a whole method when those
  lines are enough.
- Concise unknowns for behaviour those rules and invariants do not settle. One or two sentences
  each, not an essay.
- Every required field, filled. Optional arrays may be empty.

If a claim cannot be cited without cutting a condition out of its quote, do not make the claim.
Record the gap under `unknowns`.

The example below is a different domain on purpose: it shows the shape of a well-formed answer, not
an answer, and it is longer than your reply should be. Do not copy its ids, its paths, its rules or
its vocabulary; nothing in it describes the repository you are specifying.

```json
{
  "summary": "Two or three sentences: what this system guarantees, where the guarantees are enforced, and what is still unsettled.",
  "rules": [
    {
      "ruleId": "BR-DOCUMENT-RETENTION-WINDOW",
      "title": "An archived document stops being eligible for retrieval after the retention window closes",
      "description": "Eligibility is computed from the archive date plus a per-category window held in a lookup table, and it is enforced in two places: the retrieval service and a database function called by the nightly purge. Read both before stating the rule; if they disagree, state one rule per path and record the contradiction.",
      "kind": "timing",
      "epistemicStatus": "OBSERVED",
      "confidence": 0.82,
      "confidenceBasis": "Both code paths compare against the same lookup table, but the comparison operators differ and I could not establish from source which boundary the production data actually reaches; a characterization run on the boundary date would settle it.",
      "sourceEvidence": [
        {
          "path": "src/main/java/com/example/archive/RetrievalService.java",
          "startLine": 88,
          "endLine": 91,
          "symbol": "RetrievalService#isEligible",
          "quote": "archivedAt.plusDays(category.retentionDays()).isBefore(clock.instant())",
          "note": "Optional: why this quote carries the rule."
        }
      ],
      "affectedComponents": ["src/main/java/com/example/archive/RetrievalService.java"],
      "observableBehavior": "GET /api/documents/{id}/content for a document archived exactly one retention window ago returns 410 with a body naming the retention rule, while the same request one day earlier returns 200 with the content.",
      "edgeCases": [
        {
          "id": "EC-RETENTION-BOUNDARY-DAY",
          "description": "A retrieval attempted on the last day of the window rather than after it.",
          "expectedBehavior": "The document is still retrievable.",
          "epistemicStatus": "INFERRED",
          "confidence": 0.6,
          "evidence": [
            { "path": "db/migration/V4__retention.sql", "startLine": 17, "quote": "retention_days" }
          ]
        }
      ],
      "assumptions": [
        "The category row for the document exists and has not been edited since archiving."
      ],
      "testable": true,
      "proposedChecks": [
        {
          "id": "CHK-RETENTION-BOUNDARY",
          "description": "Archive a document, then request its content at the boundary and one day past it.",
          "kind": "api-scenario",
          "targetsRuleId": "BR-DOCUMENT-RETENTION-WINDOW"
        }
      ],
      "duplicateImplementations": ["db/migration/V4__retention.sql:purge_expired"],
      "contradictsRuleIds": [],
      "derivedFromInvariantIds": ["INV-ARCHIVE-IMMUTABLE"]
    }
  ],
  "invariants": [
    {
      "invariantId": "INV-CATALOG-COUNT-CONSERVED",
      "statement": "The number of rows in the catalog equals the number of documents that have not been purged.",
      "formalStatement": "forall t: (select count(*) from catalog) == (select count(*) from documents where purged_at is null)",
      "kind": "totality",
      "criticality": "MAJOR",
      "scope": {
        "components": ["src/main/java/com/example/archive/CatalogService.java"],
        "operations": ["POST /api/documents", "POST /api/purge/run"]
      },
      "epistemicStatus": "OBSERVED",
      "confidence": 0.75,
      "sourceEvidence": [
        {
          "path": "db/migration/V6__catalog_trigger.sql",
          "startLine": 24,
          "symbol": "catalog_count_check",
          "quote": "RAISE EXCEPTION 'catalog count drifted'"
        }
      ],
      "checkingStrategy": {
        "kind": "database-query",
        "detail": "After each scenario, compare the catalog row count with the count of non-purged documents; any difference is a violation.",
        "automated": true,
        "executable": "SELECT (SELECT count(*) FROM catalog) AS catalog_rows, (SELECT count(*) FROM documents WHERE purged_at IS NULL) AS live_documents"
      },
      "violationSeverity": "MAJOR",
      "derivedFromRuleIds": ["BR-DOCUMENT-RETENTION-WINDOW"],
      "examples": [
        {
          "description": "A purge run over a category whose window has closed",
          "expected": "Catalog rows and live documents still agree"
        }
      ],
      "knownExceptions": []
    }
  ],
  "unknowns": [
    {
      "id": "UNK-PURGE-RERUN",
      "question": "Does running the purge job twice for the same window delete anything a second time?",
      "whyItMatters": "If it does, a differential run that executes the job more than once compares two different systems, and the retry semantics must be specified before anything is migrated.",
      "resolutionStrategy": "runtime-probe",
      "relatedRuleIds": [],
      "relatedInvariantIds": []
    }
  ]
}
```

Field rules — a reply that violates them is rejected and you will be told which field failed:

- `summary`: 40–4000 characters.
- `rules[].ruleId`: `BR-` followed by 1–80 uppercase letters, digits and dashes.
- `rules[].kind`: `calculation`, `derived-value`, `validation`, `constraint`, `state-transition`,
  `timing`, `authorization`, `persistence`, `retry`, `default-value`, `error-handling` or `other`.
- `rules[].confidence`, `rules[].edgeCases[].confidence`, and `invariants[].confidence`: each field is
  required and must be a JSON number from 0 through 1 inclusive. Never substitute `confidenceBasis`
  for a numeric `confidence` and never omit the field.
- `rules[].confidenceBasis`: 20–2000 characters. Say what evidence is missing or ambiguous. "The
  code is clear" is not a basis. This field exists on rules only, not invariants or edge cases.
- `rules[].sourceEvidence`: 1 to 8 entries, each with a `path` relative to the repository root and a
  `quote` copied verbatim from it. `startLine` and `symbol` are optional but required in practice: a
  rule marked `OBSERVED` that cites no line or symbol anywhere is rejected.
- `invariants[].sourceEvidence`: 1 to 8 entries, each with a `path` and a verbatim `quote` — exactly
  as for rules. An invariant with an empty evidence list is rejected. If a candidate invariant cannot
  be evidenced from the repository, do not assert it here: record it under `unknowns` instead.
- `rules[].affectedComponents`: at least one entry.
- `rules[].observableBehavior`: 20–4000 characters, stated from outside the system. For an HTTP-testable
  rule, include the exact method, route, required JSON fields and relevant headers copied from a public
  controller or API document you opened. Cite that entry point; do not invent a route from the rule title.
- `rules[].duplicateImplementations`, `contradictsRuleIds`, `derivedFromInvariantIds`,
  `invariants[].derivedFromRuleIds`, `unknowns[].related*Ids`: every id you name must exist in this
  same reply. A reference to a claim you did not make fails the task.
- `rules[].edgeCases[].id`: `EC-` followed by uppercase letters, digits and dashes.
- `rules[].proposedChecks[].kind`: `api-scenario`, `unit-test`, `db-query`, `property-test`,
  `concurrency-probe` or `time-probe`.
- `invariants[].invariantId`: `INV-` followed by 1–80 uppercase letters, digits and dashes.
- `invariants[].kind`: `conservation`, `idempotency`, `uniqueness`, `monotonicity`, `immutability`,
  `rounding-stability`, `ordering`, `retry-semantics`, `state-machine-legality`, `precision`,
  `referential-integrity`, `bound`, `totality`, `determinism`, `authorization`, `auditability` or
  `other`.
- `invariants[].criticality`: `CRITICAL`, `MAJOR` or `MINOR`. `violationSeverity`: `CRITICAL`,
  `MAJOR`, `MINOR` or `INFO`.
- `invariants[].checkingStrategy.kind`: `differential-scenario`, `database-query`, `property-test`,
  `unit-test`, `api-invariant-check`, `concurrency-probe` or `manual`. `detail` must be 20–4000
  characters and concrete enough to implement without asking you anything. Supply `executable`
  whenever the check is a query or an assertion a machine can run as written.
- `unknowns[].resolutionStrategy`: `runtime-probe`, `characterization-test`, `differential-scenario`,
  `adversarial-scenario`, `database-inspection`, `human-input` or `unresolvable`.

You cannot set `lifecycleStatus` or a `confirmation` on anything, and there is no field for them:
every rule and invariant you produce leaves this stage a candidate, to be confirmed or contradicted
by executed tests in later stages.

Prefer fewer, sharper rules over broad ones. Stop at 3 to 5 supported rules and 1 to 2 supported
invariants. Where two code paths disagree, that disagreement is itself the most valuable thing you
can report — write both rules, cite both paths, and mark the contradiction, and let that pair count
toward the limit. Do not add further rules once the reply would risk being cut off.
