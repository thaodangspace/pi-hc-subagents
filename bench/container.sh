#!/usr/bin/env bash
# Container entrypoint: private herdr-core, then the benchmark.
#
# Required: BENCH_LIVE_MODEL=1, BENCH_MODEL, and whatever provider credentials
# that model needs. Pass them with `docker run -e ...`, never bake them in.
set -euo pipefail

export HOME="${HOME:-/root}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-/tmp/bench/state}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/tmp/bench/config}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/bench/run}"
export HC_SESSION="${HC_SESSION:-bench-$$}"

# Unix sockets need a short, private runtime dir.
rm -rf "$XDG_RUNTIME_DIR"
mkdir -p "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

cleanup() {
  hc server stop --json >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

hc server start --json >/dev/null
socket="$(find "$XDG_RUNTIME_DIR" -name "*.sock" -type s | head -n 1)"
if [ -z "$socket" ]; then
  echo "bench: hc did not create a socket under $XDG_RUNTIME_DIR" >&2
  exit 1
fi
export BENCH_HC_SOCKET="$socket"

# One long-lived anchor so delegated children are parented, not orphaned.
parent="$(hc run --bg --no-notify --no-parent --name bench-parent --json sh -c 'sleep 86400' | sed -n 's/.*"address"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [ -n "$parent" ]; then
  export BENCH_PARENT_TERMINAL="$parent"
fi

echo "bench: core=$HC_SESSION socket=$BENCH_HC_SOCKET parent=${parent:-none}"
exec node bench/run.ts "$@"
