# Phoenix

Phoenix modernizes a legacy service by running one lineage of stages:

`DISCOVER → SPECIFY → CHARACTERIZE → MODERNIZE → differential verification → repair → reverification`

A single successful lineage is evidence that the slice can complete. It is not a production-readiness claim.

## Requirements

- Node.js 22 or newer, pnpm 12
- PostgreSQL 16 on `localhost:5432`
- JDK 17 (the demo pins Zulu 17) and Maven, for `examples/legacy-bank`
- `psql` and `pg_dump` on `PATH`
- An OpenAI-compatible model endpoint

```bash
pnpm install
cp .env.example .env
```

Set `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` in `.env`. Do not commit `.env`.

The completed lineage used DeepSeek's OpenAI-compatible API (`LLM_MODEL=deepseek-flash`) with thinking disabled:

```bash
LLM_EXTRA_BODY='{"thinking":{"type":"disabled"}}'
```

`LLM_MAX_TOKENS=8192` truncated the specification report. The run that produced accepted artifacts used `16384`, which is inside DeepSeek's published output limit for that model. There is no second provider.

## Legacy service

The demo user is `legacy` / `legacy` (see `examples/legacy-bank/README.md`). That role cannot create databases. Create an isolated database as a superuser, then point both the JVM and Phoenix at it:

```bash
createdb -O legacy legacy_bank_slice
export PGDATABASE=legacy_bank_slice
( cd examples/legacy-bank && ./db/reset.sh )
export SPRING_DATASOURCE_URL='jdbc:postgresql://localhost:5432/legacy_bank_slice'
export LEGACY_BANK_DB_URL='postgres://legacy:legacy@localhost:5432/legacy_bank_slice'
# run.sh backgrounds Java and then exits, which can reap the server.
# Keep this process alive for the whole lineage.
( cd examples/legacy-bank && exec java -jar target/corebank-legacy-0.9.3.jar )
```

`GET http://localhost:8080/health` should report `UP` before characterization. Characterization snapshots the business tables and restores that snapshot before each execution, so two passes of a mutating scenario see the same book. Re-running the Flyway seed between those passes calls `now()` again and moves every timestamp.

## One lineage

From the repository root, with the legacy server still listening:

```bash
export LLM_MAX_TOKENS=16384
export STAGE_TIMEOUT_MS=900000
export LEGACY_BANK_DB_URL='postgres://legacy:legacy@localhost:5432/legacy_bank_slice'

pnpm phoenix discover --run-id <run-id> --max-steps 8
pnpm phoenix specify --run-id <run-id> --max-steps 8
pnpm phoenix characterize --run-id <run-id> --max-steps 8
pnpm phoenix modernize --run-id <run-id> --max-steps 12 --max-repairs 3
```

`discover` prints the run id when you omit `--run-id`. Later stages require that id. `modernize` exits 0 only when the final differential verdict is `EQUIVALENT`.

The pinned completed lineage is `run_1ad5681e13294219959c3908022799c5`. Its artifacts, including failed attempts, are under `artifacts/` and are not committed.

## Checks

```bash
pnpm verify
```

That is `pnpm typecheck && pnpm lint && pnpm test`. `pnpm format:check` is not part of that gate.

## What this run does not include

Dashboards, workers, provider fallback, and cloud deployment are out of scope. Clock fields (`createdAt`, `settledAt`, and other `At` / `Time` suffixes) are recorded and then excluded from equivalence: a seed snapshot's instant is not a business output a second process has to reproduce. Amounts, statuses, dates, and fees stay strict.
