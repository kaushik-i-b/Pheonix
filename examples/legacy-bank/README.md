# corebank-legacy (retail ledger)

FNB core banking service for the retail book. Lifted onto Spring Boot in
the 2020 platform program; the domain model still mirrors the old COBOL
ledger (amounts are `numeric(18,4)` end to end, don't narrow them).

Oncall: `#corebank-support`. Deploy runbook lives on confluence under
"corebank REST v0.9" (last verified 2022-03, some of it may be stale).

## Running locally

Requirements: JDK 17 (the app compiles at Java 8 level), Maven, and
PostgreSQL 16 with the demo database:

    postgres://legacy:legacy@localhost:5432/legacy_bank

Then:

    ./run.sh          # builds the jar if missing, starts on :8080
    ./stop.sh         # stops it
    ./db/reset.sh     # drops the schema; next start replays migrations + seed

Flyway applies `V1__schema.sql`, `V2__seed.sql` and
`V3__batch_and_triggers.sql` on first boot. The seed book is accounts
1-10 (`ACCT-1001`..`ACCT-1010`).

Note: `JAVA_HOME` must point at a JDK the Boot 2.7 toolchain supports;
`run.sh` pins the zulu 17 install we use on the build box.

## Endpoints

| Method | Path | Notes |
| ------ | ---- | ----- |
| POST | `/api/accounts` | open an account (onboarding import may pass `openedAt`) |
| GET | `/api/accounts` | list book |
| GET | `/api/accounts/{id}` | account details |
| POST | `/api/transfers` | `INTERNAL` or `EXTERNAL`; honors `Idempotency-Key` |
| GET | `/api/transfers/{id}` | transfer receipt |
| POST | `/api/deposits` | honors `Idempotency-Key` |
| POST | `/api/withdrawals` | flat fee per the published schedule |
| GET | `/api/accounts/{id}/ledger` | full ledger |
| GET | `/api/accounts/{id}/history` | legacy statement feed (`frm`, `to`, `typ` params - names are contractual, FNB-2688) |
| POST | `/api/settlement/run` | manual re-drive of the nightly batch |
| GET | `/api/settlement/last` | last batch header |
| POST | `/api/reconciliation/run` | book-vs-ledger recon |
| GET | `/api/reconciliation/report` | latest recon report |
| POST | `/api/corrections` | back office same-day correction/reversal |
| GET | `/api/fees/schedule` | published fee table (2021-06 rev C) |
| GET | `/health` | liveness |

Internal transfers settle immediately; external transfers go `PENDING`
and are completed by the settlement batch (cron 23:15 on the ops box, or
the manual re-drive endpoint above).

## Notes

- Batch windows and the cron schedule are owned by ops; the manual
  re-drive endpoint is for oncall use during incidents only.
- The recon report goes to the morning standup as-is.
- The wire adapter is still stubbed pending FNB-4102 (ticket from the
  2022 platform program, may be out of date).
- This README predates the 2023 gateway consolidation; if an endpoint
  behaves oddly, check confluence "corebank REST v0.9" first.
