#!/usr/bin/env bash
# Runs every test file on its own with a bounded timeout and prints one line per
# file: PASS/FAIL/TIMEOUT, pass count, fail count. A file that hangs cannot stall
# the whole run, and a per-file record makes a regression attributable.
#
#   scripts/perFileTestGate.sh [output-file] [timeout-seconds]

set -u
out="${1:-gate.status}"
limit="${2:-120}"

: > "$out"
total_pass=0
total_fail=0
failed_files=0

for file in test/*.test.js; do
  result="$(timeout "$limit" node --test "$file" 2>&1)"
  code=$?
  pass="$(printf '%s' "$result" | grep -oE ' pass [0-9]+$' | grep -oE '[0-9]+' | head -1)"
  fail="$(printf '%s' "$result" | grep -oE ' fail [0-9]+$' | grep -oE '[0-9]+' | head -1)"
  pass="${pass:-0}"
  fail="${fail:-0}"

  if [ "$code" -eq 124 ]; then
    status=TIMEOUT
  elif [ "$code" -ne 0 ] || [ "$fail" -ne 0 ]; then
    status=FAIL
  else
    status=PASS
  fi

  [ "$status" = PASS ] || failed_files=$((failed_files + 1))
  total_pass=$((total_pass + pass))
  total_fail=$((total_fail + fail))
  printf '%s\t%s\tpass=%s\tfail=%s\n' "$status" "$file" "$pass" "$fail" >> "$out"
done

printf 'TOTAL\tfiles=%s\tfailing_files=%s\tpass=%s\tfail=%s\n' \
  "$(ls test/*.test.js | wc -l)" "$failed_files" "$total_pass" "$total_fail" >> "$out"
tail -1 "$out"
