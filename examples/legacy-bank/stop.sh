#!/usr/bin/env bash
# stops the locally running corebank-legacy
cd "$(dirname "$0")"

if [ -f .app.pid ]; then
  PID=$(cat .app.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "stopped pid $PID"
  fi
  rm -f .app.pid
else
  PID=$(lsof -ti tcp:8080 2>/dev/null || true)
  if [ -n "$PID" ]; then
    kill $PID
    echo "stopped pid(s) on :8080: $PID"
  else
    echo "nothing listening on :8080"
  fi
fi
