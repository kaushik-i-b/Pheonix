#!/usr/bin/env bash
# wipe + recreate the public schema so the next app start replays the
# flyway migrations from scratch (demo reset). app must be stopped, or
# at least idle - open connections get kicked.
set -e
cd "$(dirname "$0")/.."

export PGPASSWORD="${PGPASSWORD:-legacy}"
PSQL="psql -h ${PGHOST:-localhost} -p ${PGPORT:-5432} -U ${PGUSER:-legacy} -d ${PGDATABASE:-legacy_bank} -v ON_ERROR_STOP=1"

$PSQL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();" > /dev/null
$PSQL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
$PSQL -c "GRANT ALL ON SCHEMA public TO legacy; GRANT ALL ON SCHEMA public TO public;"

echo "schema dropped. start the app (./run.sh) to re-apply V1..V3 and reseed."
