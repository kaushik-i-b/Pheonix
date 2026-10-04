---
id: modernizer.implementation
version: 1.0.0
description: Task prompt that turns the specification and characterization scenarios into an implementation returned as files.
audience: modernizer
outputSchemaId: modernizer.report
requiredVariables: objective, context, specBrief, scenarioBrief, failureReport, repositoryRoot, modernRoot, port
---
# Objective

{{objective}}

# Context

{{context}}

# The specification

{{specBrief}}

# The scenarios

{{scenarioBrief}}

# Differential failures to address

{{failureReport}}

# Building it

The implementation is a Node.js + TypeScript HTTP server. Constraints that the host enforces, not
requests:

* Only Node.js built-in modules (`node:http`, `node:crypto`, …) and your own files. Nothing is
  installed: there is no `package.json`, no `npm install`, no imports from `node_modules`.
* The server reads its port from the `PORT` environment variable ({{port}} when unset) and listens
  on it as soon as it is up.
* `GET /health` returns HTTP 200 once the server is ready to serve.
* `POST` to the path you declare in `resetPath` returns every piece of state to a clean startup
  condition — accounts, ledgers, counters, everything. The differential harness calls it between
  scenarios.
* Responses are deterministic: no random values, no formatting that depends on the current time,
  stable field order. Two identical requests must produce byte-identical responses.
* The whole answer is one model reply. Keep the implementation small — a single entry file of a few
  hundred lines is expected, not a layered application.

Before you write a line, open with `read_file` the legacy files your rules cite under
{{repositoryRoot}}. Amounts, rounding, status codes and edge cases come from that code. The
specification summarizes it; the code decides. When a scenario's request has no rule behind it,
read the legacy handler for that route and reproduce exactly what it returns — including error
bodies and status codes.

If the differential failures above name scenarios, your job is to make **those** scenarios pass by
changing the modern implementation only. Legacy's recorded behavior is not negotiable and must not
be edited; {{modernRoot}} is yours to regenerate entirely.

# Your report

Reply with **only** a JSON object — no prose before or after it, no code fences — with the shape
below. The example is a different domain on purpose: it shows the shape of a well-formed answer,
not an answer. Do not copy its ids, its paths, its rules or its code.

```json
{
  "summary": "Two or three sentences: what you built, which behaviors it reproduces, and what you were unsure about.",
  "entryPoint": "server.ts",
  "files": [
    {
      "path": "server.ts",
      "content": "the complete file contents, verbatim, with real newlines",
      "description": "Optional: what this file holds."
    }
  ],
  "resetPath": "/test/reset",
  "ruleIdsImplemented": ["BR-DOCUMENT-RETENTION-WINDOW"],
  "invariantIdsAddressed": ["INV-CATALOG-COUNT-CONSERVED"],
  "assumptions": ["One sentence per assumption: what you could not settle from the specification or the code, and what you chose instead."]
}
```

Field rules — a reply that violates them is rejected and you will be told which field failed:

* `summary`: 20–4000 characters.
* `entryPoint`: a relative path with no leading `/`, no `..`, no backslash, and it must be one of
  `files[].path` — the host starts your server by running `tsx <entryPoint>`.
* `files`: 1 to 12 entries. Every `path` is relative and safe; every `content` is the complete file,
  not a diff or an excerpt; the total of all `content` lengths stays under 60000 characters.
* `resetPath`: an absolute HTTP path such as `/test/reset`.
* `ruleIdsImplemented`, `invariantIdsAddressed`: ids from the specification above, and only those —
  an id that is not in the specification fails the task.
* `assumptions`: at most 20 entries, each at most 1000 characters.

Do not include any file other than implementation files: no `package.json`, no lockfile, no README.
The host writes your files to {{modernRoot}} exactly as returned and adds its own launcher script.
