---
id: engineer.scenarios
version: 1.0.2
description: Task prompt that turns the specification's claims into a bounded set of executable characterization scenarios.
audience: characterization-engineer
outputSchemaId: engineer.report
requiredVariables: objective, context, brief, briefChars, capturedFrom, repositoryRoot, ruleCount, invariantCount
---
# Objective

{{objective}}

# Context

{{context}}

# The specification under test

{{ruleCount}} business rule(s) and {{invariantCount}} invariant(s) were discovered and
specified for the system captured at `{{capturedFrom}}`. The claims your scenarios must probe:

## Behavior brief ({{briefChars}} characters)

{{brief}}

Work only from this brief when deciding which behaviors matter. Before writing a request, inspect
the legacy repository at `{{repositoryRoot}}` with `search_repository` and `read_file` to find the
real public route, method, request fields and headers that invoke that behavior. This is API contract
discovery, not outcome discovery: do not infer or encode expected responses from implementation
logic. You see no recorded responses; what gets frozen later is what the live system actually does.
The brief's **Discovered public HTTP surface** is mechanically extracted and authoritative: every
HTTP step you propose must match one of its method/path pairs. Handler locations are supplied so you
can open the exact source and learn required request fields instead of guessing them.

# Your report

Reply with **only** a JSON object — no prose before or after it, no code fences — with the shape
below. The example is a different domain on purpose: it shows the shape of a well-formed answer,
not an answer. Do not copy its titles, its paths, its ids or its vocabulary; nothing in it
describes the system you are probing.

```json
{
  "summary": "Two or three sentences: which claims you chose to probe, why these over the rest, and anything in the brief you could not turn into a runnable scenario.",
  "scenarios": [
    {
      "title": "A document archived yesterday is still retrievable",
      "description": "Requests the content of a document whose archive date sits well inside its retention window. The boundary day itself is probed by a separate scenario; this one pins the safely-inside side.",
      "category": "normal-path",
      "hypothesis": "A document inside its retention window is retrievable, and the retrieval leaves the archive unchanged.",
      "targetRuleIds": ["BR-DOCUMENT-RETENTION-WINDOW"],
      "targetInvariantIds": [],
      "setup": [],
      "steps": [
        {
          "stepId": "fetch-content",
          "description": "Read the content of a document archived inside the window.",
          "kind": "http",
          "http": {
            "method": "GET",
            "path": "/api/documents/retention-sample/content",
            "query": {},
            "headers": {}
          }
        }
      ],
      "teardown": [],
      "knownNondeterministicPaths": ["servedAt"],
      "rationale": "The inside-the-window side separates a boundary off-by-one from a retrieval that is broken outright; it is also repeatable, so its second execution must agree with its first."
    }
  ]
}
```

Field rules — a reply that violates them is rejected and you will be told which field failed:

* `summary`: 20–4000 characters.
* `scenarios`: write 6 entries, and never more than 8. The report is rejected below 5. Entries past the 10th are dropped, so put every invariant probe inside the first 6.
* `scenarios[].title`: 5–300 characters. `description`: 10–4000 characters. `rationale`:
  10–2000 characters. `hypothesis`: 10–2000 characters, phrased as a prediction.
* `scenarios[].category`: `normal-path`, `boundary`, `failure`, `retry`, `concurrency`,
  `rounding`, `precision`, `state-transition`, `history`, `timing`, `idempotency`, `ordering`,
  `partial-failure`, `migration` or `other`.
* `scenarios[].targetRuleIds` / `targetInvariantIds`: at most 10 each, and every scenario needs
  at least one of the two non-empty. Every id must exist in the specification brief above; a
  reference to a claim nobody made fails the task.
* `scenarios[].steps`: 1 to 20 steps. `setup` and `teardown`: at most 10 each. `stepId` must be
  unique across all three lists.
* `steps[].kind`: `http` or `wait` — those are the only kinds the capture target can run; any
  other kind rejects the scenario. An `http` step carries `method` (`GET`, `POST`, `PUT`,
  `PATCH`, `DELETE` or `HEAD`), `path`, and optionally `query`, `headers` and `body`. A `wait`
  step carries `waitMs`. A step carries exactly the payload its kind needs and no other.
* `steps[].http.body` is the JSON value itself, not JSON text. Write `"body": {"amount": 100}`,
  never `"body": "{\"amount\": 100}"`; a string body is rejected. `rawBody` is only for a
  deliberate byte-exact malformed-payload scenario.
* `steps[].path` is resolved against the target's base URL. Copy it from a controller annotation or
  API document you opened in this task; never derive a path from a rule title or prose description.
* `scenarios[].knownNondeterministicPaths`: response fields you already expect to vary between
  two identical calls (fields echoing a timestamp or a per-request token), named as response
  paths. Record them rather than avoiding the behavior; an empty list asserts the scenario is
  fully repeatable.
* There is no field for an expected status, an expected body, or any other expectation. The
  schema has nowhere to put one. What the system actually returns is recorded by Phoenix and
  becomes the assertion.

Where the brief names no path for a claim, leave that claim alone — an invented endpoint
produces a capture of a 404, not of the behavior. Probe the claims that name their request;
state the ones you had to skip in `summary`.
