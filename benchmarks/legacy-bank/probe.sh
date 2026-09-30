#!/usr/bin/env bash
# probe.sh - exercises every behavior documented in ground-truth.json
# against a RUNNING corebank-legacy instance, printing actual vs expected.
#
#   Usage:  ./probe.sh                     (BASE=http://localhost:8080)
#           BASE=http://host:port ./probe.sh
#
# Needs: curl, jq, psql. Env: PGPASSWORD (default legacy), PGHOST/PGPORT/PGUSER/PGDATABASE.
# Rerunnable: namespaces all idempotency keys per run. Exits non-zero on any FAIL.
set -u

BASE="${BASE:-http://localhost:8080}"
export PGPASSWORD="${PGPASSWORD:-legacy}"
PGH="${PGHOST:-localhost}"; PGP="${PGPORT:-5432}"; PGU="${PGUSER:-legacy}"; PGD="${PGDATABASE:-legacy_bank}"
RUNID="probe-$$-$(date +%s)"
TMPBODY="/tmp/probe-body-$$"
trap 'rm -f "$TMPBODY"' EXIT

PASS=0; FAIL=0

sq(){ psql -h "$PGH" -p "$PGP" -U "$PGU" -d "$PGD" -tAc "$1" 2>/dev/null; }
sqerr(){ psql -h "$PGH" -p "$PGP" -U "$PGU" -d "$PGD" -tAc "$1" 2>&1; }

req(){ # METHOD PATH JSON [extra curl args...]
  local m="$1" p="$2" j="$3"; shift 3
  local args=(-s -o "$TMPBODY" -w '%{http_code}' -X "$m" "$BASE$p" -H 'Content-Type: application/json')
  local a
  [ -n "$j" ] && args+=(-d "$j")
  for a in ${1+"$@"}; do [ -n "$a" ] && args+=("$a"); done
  CODE=$(curl "${args[@]}")
  BODY=$(cat "$TMPBODY" 2>/dev/null)
}

jqf(){ printf '%s' "$BODY" | jq -r "$1" 2>/dev/null; }

ok(){ PASS=$((PASS+1)); printf '  [PASS] %s\n' "$1"; }
ng(){ FAIL=$((FAIL+1)); printf '  [FAIL] %s\n      actual:   %s\n      expected: %s\n' "$1" "$2" "$3"; }
chk(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else ng "$1" "$2" "$3"; fi; }
chkn(){ if awk -v a="$2" -v b="$3" 'BEGIN{exit !(a+0==b+0)}' 2>/dev/null; then ok "$1 ($2 == $3)"; else ng "$1" "${2:-<empty>}" "$3"; fi; }
chkhas(){ case "$2" in *"$3"*) ok "$1 (contains '$3')";; *) ng "$1" "$2" "contains '$3'";; esac; }
sec(){ printf '\n== %s\n' "$1"; }

mkacct(){ req POST /api/accounts "$1"; jqf '.id // empty'; }

plus_days(){
  if date -j -v+"$2"d -f "%Y-%m-%d" "$1" +%F >/dev/null 2>&1; then date -j -v+"$2"d -f "%Y-%m-%d" "$1" +%F
  else date -d "$1 +$2 day" +%F; fi
}
dow_of(){
  if date -j -f "%Y-%m-%d" "$1" +%u >/dev/null 2>&1; then date -j -f "%Y-%m-%d" "$1" +%u
  else date -d "$1" +%u; fi
}
next_bd(){
  local t d
  t=$(plus_days "$1" 1); d=$(dow_of "$t")
  if [ "$d" = "6" ]; then plus_days "$t" 2
  elif [ "$d" = "7" ]; then plus_days "$t" 1
  else printf '%s' "$t"; fi
}

# ---------------------------------------------------------------- preflight
sec "preflight"
req GET /health ''
chk "GET /health status" "$(jqf .status)" "UP"
chk "GET /health db" "$(jqf .db)" "UP"
req GET /api/fees/schedule ''
chk "GET /api/fees/schedule internal max (published, wrong)" "$(jqf '.schedules[0].maximum')" "15.00"
req GET /api/settlement/last ''
chk "GET /api/settlement/last responds" "$CODE" "200"

A=$(mkacct '{"ownerName":"Probe A","type":"CHECKING","initialDeposit":1000}')
B=$(mkacct '{"ownerName":"Probe B","type":"SAVINGS","initialDeposit":0}')
if [ -z "$A" ] || [ -z "$B" ]; then echo "cannot create accounts; is the app up and DB reset?"; exit 2; fi

# ------------------------------------------------- LB-001 / LB-002 / LB-003
sec "LB-001+LB-002 fee logic drift & rounding (internal 105 -> 0.53 HALF_UP, batch 105 -> 0.52 HALF_EVEN)"
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$A,\"toAccountId\":$B,\"amount\":105.00,\"memo\":\"probe internal 105\"}" -H "Idempotency-Key: $RUNID-i105"
chk "internal 105 http" "$CODE" "201"
chkn "internal 105 fee (HALF_UP)" "$(jqf .fee)" "0.53"
req POST /api/transfers "{\"type\":\"EXTERNAL\",\"fromAccountId\":$A,\"amount\":105.00,\"beneficiaryName\":\"PROBE VENDOR\",\"beneficiaryRouting\":\"021000021\",\"beneficiaryAccountRef\":\"5550001\",\"memo\":\"probe external 105\"}"
E105=$(jqf .transferId)
chk "external 105 pending" "$(jqf .status)" "PENDING"
req POST /api/settlement/run ''
chk "settlement run http" "$CODE" "200"
req GET "/api/transfers/$E105" ''
chk "external 105 settled" "$(jqf .status)" "SETTLED"
chkn "external 105 batch fee (HALF_EVEN)" "$(jqf .fee)" "0.52"

sec "LB-003 magic waiver threshold 100.00 online-only (internal 80 -> 0, batch 80 -> 0.40)"
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$A,\"toAccountId\":$B,\"amount\":80.00,\"memo\":\"probe internal 80\"}"
chkn "internal 80 fee (waived <100)" "$(jqf .fee)" "0"
req POST /api/transfers "{\"type\":\"EXTERNAL\",\"fromAccountId\":$A,\"amount\":80.00,\"beneficiaryName\":\"PROBE VENDOR\",\"beneficiaryRouting\":\"021000021\",\"memo\":\"probe external 80\"}"
E80=$(jqf .transferId)
req POST /api/settlement/run ''
req GET "/api/transfers/$E80" ''
chkn "external 80 batch fee (no waiver)" "$(jqf .fee)" "0.40"

# ----------------------------------------------------------------- LB-016
sec "LB-016 comment/schedule claim a 15.00 cap; none exists (internal 10000 -> 50.00)"
BIG=$(mkacct '{"ownerName":"Probe Big Co","type":"BUSINESS","initialDeposit":20000}')
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$BIG,\"toAccountId\":$B,\"amount\":10000.00,\"memo\":\"probe cap\"}"
chkn "fee on 10000 (uncapped)" "$(jqf .fee)" "50.00"
MARKERS=$(sq "SELECT count(*) FROM settlement_marker;")
awk -v m="$MARKERS" 'BEGIN{exit !(m+0>0)}' && ok "settlement_marker rows written ($MARKERS, never read by code)" || ng "settlement_marker rows written" "$MARKERS" ">0"

# ----------------------------------------------------------------- LB-004
sec "LB-004 account-age waiver: opened >= 365 days -> no online fee"
TWO_Y_AGO=$(date -v-2y +%Y-%m-%dT09:00:00 2>/dev/null || date -d "-2 years" +%Y-%m-%dT09:00:00)
OLD=$(mkacct "{\"ownerName\":\"Probe Old Timer\",\"initialDeposit\":1000,\"openedAt\":\"$TWO_Y_AGO\"}")
NEW=$(mkacct '{"ownerName":"Probe New Comer","initialDeposit":1000}')
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$OLD,\"toAccountId\":$B,\"amount\":500.00,\"memo\":\"probe age old\"}"
chkn "old account (2y) internal 500 fee" "$(jqf .fee)" "0"
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$NEW,\"toAccountId\":$B,\"amount\":500.00,\"memo\":\"probe age new\"}"
chkn "new account internal 500 fee" "$(jqf .fee)" "2.50"

# ----------------------------------------------------------------- LB-005
sec "LB-005 partial idempotency: mixed-case deposit key double-posts; transfer key protected"
D=$(mkacct '{"ownerName":"Probe Idem","initialDeposit":0}')
req POST /api/deposits "{\"accountId\":$D,\"amount\":50,\"memo\":\"probe deposit mc\"}" -H "Idempotency-Key: $RUNID-MixedCase-Key"
DUP1=$(jqf .duplicate); T_1=$(jqf .transferId); chk "mixed-case deposit #1 http" "$CODE" "200"
req POST /api/deposits "{\"accountId\":$D,\"amount\":50,\"memo\":\"probe deposit mc\"}" -H "Idempotency-Key: $RUNID-MixedCase-Key"
DUP2=$(jqf .duplicate); T_2=$(jqf .transferId)
chk "mixed-case deposit #2 NOT detected as duplicate" "$DUP2" "false"
[ "$T_1" != "$T_2" ] && ok "two distinct deposit rows ($T_1 != $T_2)" || ng "distinct deposit rows" "$T_2" "!= $T_1"
req GET "/api/accounts/$D/ledger" ''
chkn "balance after duplicate mixed-case deposits (double-posted)" "$(jqf .balance)" "100"
req POST /api/deposits "{\"accountId\":$D,\"amount\":25}" -H "Idempotency-Key: $RUNID-lowercase-key" > /dev/null
req POST /api/deposits "{\"accountId\":$D,\"amount\":25}" -H "Idempotency-Key: $RUNID-lowercase-key"
chk "all-lowercase key replay detected" "$(jqf .duplicate)" "true"
chkn "lowercase replay did not double-post" "$(req GET "/api/accounts/$D/ledger" ''; jqf .balance)" "125"
T=$(mkacct '{"ownerName":"Probe Xfer Idem","initialDeposit":200}')
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$T,\"toAccountId\":$B,\"amount\":50.00,\"memo\":\"probe idem\"}" -H "Idempotency-Key: $RUNID-xfer-key"
XT1=$(jqf .transferId); chk "transfer first attempt 201" "$CODE" "201"
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$T,\"toAccountId\":$B,\"amount\":50.00,\"memo\":\"probe idem\"}" -H "Idempotency-Key: $RUNID-xfer-key"
chk "transfer replay 200 (inconsistent status code)" "$CODE" "200"
chk "transfer replay duplicate flag" "$(jqf .duplicate)" "true"
chk "transfer replay same id" "$(jqf .transferId)" "$XT1"
req GET "/api/accounts/$T/ledger" ''
chkn "transfer replay debited once (200-50)" "$(jqf .balance)" "150"

# ----------------------------------------------------------------- LB-006
sec "LB-006 swallowed audit failure: memo > 50 chars -> no audit row, transfer still succeeds"
A2=$(mkacct '{"ownerName":"Probe Audit","initialDeposit":500}')
LONGMEMO="This memo is far longer than fifty characters so the compliance trail write fails"
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$A2,\"toAccountId\":$B,\"amount\":10.00,\"memo\":\"$LONGMEMO\"}"
LT=$(jqf .transferId)
chk "long-memo transfer http 201" "$CODE" "201"
chk "long-memo transfer persisted" "$(sq "SELECT count(*) FROM transfers WHERE id=$LT;")" "1"
chk "long-memo audit rows (swallowed)" "$(sq "SELECT count(*) FROM audit_log WHERE ref_table='transfers' AND ref_id=$LT;")" "0"
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$A2,\"toAccountId\":$B,\"amount\":10.00,\"memo\":\"short memo\"}"
ST_=$(jqf .transferId)
chk "short-memo audit rows" "$(sq "SELECT count(*) FROM audit_log WHERE ref_table='transfers' AND ref_id=$ST_;")" "1"

# ----------------------------------------------------------------- LB-007
sec "LB-007 REQUIRES_NEW fee survives outer rollback on NSF"
C=$(mkacct '{"ownerName":"Probe Nsf","initialDeposit":100}')
BEFORE_N=$(sq "SELECT count(*) FROM transfers WHERE from_account_id=$C;")
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$C,\"toAccountId\":$B,\"amount\":500.00,\"memo\":\"probe nsf\"}"
chk "NSF transfer http 400" "$CODE" "400"
chk "NSF error code" "$(jqf .error)" "NSF"
req GET "/api/accounts/$C/ledger" ''
chkn "balance after failed transfer = 100 - 2.50 fee" "$(jqf .balance)" "97.50"
chk "FEE ledger entry survived rollback" "$(sq "SELECT count(*) FROM ledger_entries WHERE account_id=$C AND entry_type='FEE';")" "1"
chk "transfer row rolled back" "$(sq "SELECT count(*) FROM transfers WHERE from_account_id=$C;")" "$BEFORE_N"

# ------------------------------------------------- LB-008 + LB-009
sec "LB-008 settlement ordering ORDER BY id decides the survivor"
O=$(mkacct '{"ownerName":"Probe Order","initialDeposit":100}')
req POST /api/transfers "{\"type\":\"EXTERNAL\",\"fromAccountId\":$O,\"amount\":60.00,\"beneficiaryName\":\"FIRST\",\"beneficiaryRouting\":\"021000021\",\"memo\":\"probe order A\"}"
TA=$(jqf .transferId)
req POST /api/transfers "{\"type\":\"EXTERNAL\",\"fromAccountId\":$O,\"amount\":60.00,\"beneficiaryName\":\"SECOND\",\"beneficiaryRouting\":\"021000021\",\"memo\":\"probe order B\"}"
TB=$(jqf .transferId)
req POST /api/settlement/run ''
req GET "/api/transfers/$TA" ''; chk "lower-id transfer A" "$(jqf .status)" "SETTLED"
req GET "/api/transfers/$TB" ''; chk "higher-id transfer B (funds exhausted)" "$(jqf .status)" "FAILED"
chkn "balance after run 1 (100-0.30-60-0.30)" "$(sq "SELECT balance FROM accounts WHERE id=$O;")" "39.40"

sec "LB-009 non-idempotent retry: fee re-charged per attempt, stuck at retries=3"
req POST /api/settlement/run ''; req POST /api/settlement/run ''; req POST /api/settlement/run ''
req GET "/api/transfers/$TB" ''
chk "retries exhausted" "$(jqf .retries)" "3"
chk "still FAILED" "$(jqf .status)" "FAILED"
chk "FEE entries for B (one per attempt)" "$(sq "SELECT count(*) FROM ledger_entries WHERE reference='FEE-$TB';")" "4"
chkn "balance after 4 fee charges (39.40-0.90)" "$(sq "SELECT balance FROM accounts WHERE id=$O;")" "38.50"
req POST /api/deposits "{\"accountId\":$O,\"amount\":200}"
req POST /api/settlement/run ''
req GET "/api/transfers/$TB" ''
chk "funded but never retried again (stuck)" "$(jqf .status)" "FAILED"

# ------------------------------------------------- LB-011 + LB-012
sec "LB-011 trigger E188 immutability + correction-channel exception"
X=$(mkacct '{"ownerName":"Probe Corr","initialDeposit":1000}')
Y=$(mkacct '{"ownerName":"Probe Corr2","initialDeposit":0}')
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$X,\"toAccountId\":$Y,\"amount\":105.00,\"memo\":\"probe correction target\"}"
TC=$(jqf .transferId)
LE=$(sq "SELECT id FROM ledger_entries WHERE reference='XFER-$TC' AND status='SETTLED' LIMIT 1;")
OUT=$(sqerr "UPDATE ledger_entries SET memo='tamper' WHERE id=$LE;")
chkhas "direct SQL update of settled row rejected" "$OUT" "E188"
OUT=$(sqerr "DELETE FROM ledger_entries WHERE id=$LE;")
chkhas "direct SQL delete of settled row rejected" "$OUT" "E188"

sec "LB-012 correction re-prices via DB fee function: newAmount 80 -> newFee 0.40 (online would be 0)"
req POST /api/corrections "{\"transferId\":$TC,\"reason\":\"amount keyed wrong at branch\",\"newAmount\":80.00}"
chk "correction http 200" "$CODE" "200"
chkn "correction newFee (calc_transfer_fee, waiver <50)" "$(jqf .newFee)" "0.40"
chk "correction status" "$(jqf .status)" "SETTLED"
chk "original entries reversed" "$(sq "SELECT count(*) FROM ledger_entries WHERE reference='CORR-$TC' AND entry_type='REVERSAL';")" "3"
chk "originals marked CORRECTED (trigger exception channel)" "$(sq "SELECT count(*) FROM ledger_entries WHERE reference IN ('XFER-$TC','FEE-$TC') AND status='CORRECTED';")" "3"

# ----------------------------------------------------------------- LB-010
sec "LB-010 reconciliation silently balances the book, ignores drift <= 0.01"
R=$(mkacct '{"ownerName":"Probe Recon","initialDeposit":300}')
req POST /api/reconciliation/run ''
chk "recon run http 202" "$CODE" "202"
chk "baseline discrepancies" "$(jqf .report.discrepancies)" "0"
chk "baseline autoCorrections" "$(jqf .report.autoCorrections)" "0"
sq "UPDATE accounts SET balance = balance + 5 WHERE id=$R;" > /dev/null
req POST /api/reconciliation/run ''
chk "drift 5.00: report still claims 0 discrepancies" "$(jqf .report.discrepancies)" "0"
chk "drift 5.00: silent balancing entry posted" "$(jqf .report.autoCorrections)" "1"
chk "drift 5.00: status IN_BALANCE" "$(jqf .report.status)" "IN_BALANCE"
chkn "RECON_ADJUST entry amount" "$(sq "SELECT amount FROM ledger_entries WHERE account_id=$R AND entry_type='RECON_ADJUST';")" "5"
chkn "balance untouched (still corrupt)" "$(sq "SELECT balance FROM accounts WHERE id=$R;")" "305"
req GET "/api/reconciliation/report" ''
chk "GET report matches run" "$(jqf .autoCorrections)" "1"
sq "UPDATE accounts SET balance = balance + 0.01 WHERE id=$R;" > /dev/null
req POST /api/reconciliation/run ''
chk "drift 0.01: tolerated, no adjustment" "$(jqf .report.autoCorrections)" "0"
[ "$(jqf .report.toleranceHits)" -ge 1 ] && ok "drift 0.01: toleranceHits >= 1 ($(jqf .report.toleranceHits))" || ng "drift 0.01 toleranceHits" "$(jqf .report.toleranceHits)" ">=1"
chkn "drift 0.01: persists in the book" "$(sq "SELECT (balance - (SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE account_id=$R)) FROM accounts WHERE id=$R;")" "0.01"

# ----------------------------------------------------------------- LB-013
sec "LB-013 stale static balance cache on GET /api/accounts/{id}"
K=$(mkacct '{"ownerName":"Probe Cache","initialDeposit":100}')
req GET "/api/accounts/$K" ''
chkn "first GET populates cache" "$(jqf .balance)" "100"
req POST /api/deposits "{\"accountId\":$K,\"amount\":50}"
req GET "/api/accounts/$K" ''
chkn "GET after deposit is STALE" "$(jqf .balance)" "100"
req GET "/api/accounts/$K/ledger" ''
chkn "ledger endpoint shows truth" "$(jqf .balance)" "150"
LISTBAL=$(req GET /api/accounts ''; jqf ".accounts[] | select(.id==$K) | .balance")
chkn "list endpoint shows truth + clears cache" "$LISTBAL" "150"
req GET "/api/accounts/$K" ''
chkn "GET after unrelated list call is fresh" "$(jqf .balance)" "150"

# ----------------------------------------------------------------- LB-014
sec "LB-014 17:00 cutoff -> value_date = next business day"
TODAY=$(date +%F); HOUR=$((10#$(date +%H)))
if [ "$HOUR" -ge 17 ]; then EXP_VD=$(next_bd "$TODAY"); else EXP_VD="$TODAY"; fi
req POST /api/transfers "{\"type\":\"INTERNAL\",\"fromAccountId\":$X,\"toAccountId\":$Y,\"amount\":10.00,\"memo\":\"probe cutoff\"}"
chk "valueDate vs cutoff (hour=$HOUR)" "$(jqf .valueDate)" "$EXP_VD"
chk "createdAt stays today" "$(jqf .createdAt | cut -dT -f1)" "$TODAY"

# ----------------------------------------------------------------- LB-015
sec "LB-015 wire timeout 504 leaves committed orphan; retry replays; settlement completes it"
F=$(mkacct '{"ownerName":"Probe Orphan","initialDeposit":500}')
req POST /api/transfers "{\"type\":\"EXTERNAL\",\"fromAccountId\":$F,\"amount\":100.00,\"beneficiaryName\":\"SLOW CORRESPONDENT\",\"beneficiaryRouting\":\"000000000\",\"memo\":\"probe orphan\"}" -H "Idempotency-Key: $RUNID-orphan"
chk "gateway timeout http 504" "$CODE" "504"
chk "error code" "$(jqf .error)" "WIRE_GATEWAY_TIMEOUT"
TO=$(jqf .transferId)
chk "orphan committed as PENDING" "$(sq "SELECT status FROM transfers WHERE id=$TO;")" "PENDING"
req POST /api/transfers "{\"type\":\"EXTERNAL\",\"fromAccountId\":$F,\"amount\":100.00,\"beneficiaryName\":\"SLOW CORRESPONDENT\",\"beneficiaryRouting\":\"000000000\",\"memo\":\"probe orphan\"}" -H "Idempotency-Key: $RUNID-orphan"
chk "retry http 200" "$CODE" "200"
chk "retry duplicate flag" "$(jqf .duplicate)" "true"
chk "retry same transferId" "$(jqf .transferId)" "$TO"
req POST /api/settlement/run ''
req GET "/api/transfers/$TO" ''
chk "orphan later settled by batch" "$(jqf .status)" "SETTLED"
chkn "orphan batch fee on 100.00" "$(jqf .fee)" "0.50"
req GET "/api/accounts/$F/ledger" ''
chkn "balance 500-100-0.50 (single debit despite 504+retry)" "$(jqf .balance)" "399.50"

# ------------------------------------------------------- endpoint coverage
sec "endpoint coverage (awkward status codes, legacy history params)"
req POST /api/withdrawals "{\"accountId\":$F,\"amount\":20,\"memo\":\"probe atm\"}"
chk "withdrawal http 200" "$CODE" "200"
chkn "withdrawal flat fee" "$(jqf .fee)" "0.50"
req POST /api/withdrawals "{\"accountId\":$F,\"amount\":999999}"
chk "withdrawal NSF 400" "$CODE" "400"
req GET "/api/accounts/$A/history?frm=1900-01-01&to=2999-12-31&typ=FEE" ''
chk "legacy history params work" "$(jqf .typ)" "FEE"
req GET "/api/accounts/$A/ledger" ''
chk "ledger endpoint" "$CODE" "200"
req GET /api/accounts/999999 ''
chk "unknown account -> 404" "$CODE" "404"
req GET /api/transfers/999999 ''
chk "unknown transfer -> 500 (inconsistent)" "$CODE" "500"

# ------------------------------------------------------------------ summary
printf '\n%s\n' "--------------------------------------------------------------"
printf 'probe complete: %d passed, %d failed (run %s)\n' "$PASS" "$FAIL" "$RUNID"
[ "$FAIL" -eq 0 ] && echo "ALL GROUND-TRUTH BEHAVIORS REPRODUCED" || echo "SOME BEHAVIORS DID NOT REPRODUCE"
[ "$FAIL" -eq 0 ]
