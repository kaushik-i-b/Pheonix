#!/usr/bin/env bash
# starts corebank-legacy on :8080 against the local postgres.
# the build box default JVM is too new for boot 2.x, pin zulu 17.
set -e
cd "$(dirname "$0")"

export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home}"
JAR="target/corebank-legacy-0.9.3.jar"

if [ ! -f "$JAR" ]; then
  echo "building $JAR ..."
  mvn -q -DskipTests package
fi

mkdir -p logs
nohup "$JAVA_HOME/bin/java" -jar "$JAR" > logs/app.log 2>&1 &
echo $! > .app.pid
echo "corebank-legacy starting (pid $(cat .app.pid)), log: logs/app.log"

for i in $(seq 1 60); do
  if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
    echo "up: http://localhost:8080/health"
    exit 0
  fi
  sleep 1
done

echo "did not come up in 60s, tail logs/app.log" >&2
exit 1
