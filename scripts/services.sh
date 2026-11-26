#!/usr/bin/env bash
# Starts the Ringside keeper (SOL/USD from Pyth) and relayer against devnet, then runs the
# sponsored-order test. Logs go to Documents/ringside-logs on Windows.
#
#   bash scripts/services.sh                       keeper + relayer, then the sponsored-order test (SKIP_TEST=1 skips it)
#   bash scripts/services.sh start <svc>...        start backend services: indexer social sponsor copy
#   bash scripts/services.sh stop [<svc>...]       stop services (default: all, keeper and relayer included)
#   bash scripts/services.sh status [<svc>...]     up/down and health for each (exit 1 if any is down)
#
# Ports: relayer 8787, keeper health 8789, indexer 8790, social 8791, sponsor 8792, copy 8793 (override with
# INDEXER_PORT, SOCIAL_PORT, SPONSOR_PORT, COPY_PORT). Secrets are read from the environment and never printed.
# Required env: indexer HELIUS_WEBHOOK_SECRET; social SESSION_SECRET and SOCIAL_DOMAIN; sponsor
# SPONSOR_SESSION_SECRET (or SESSION_SECRET) and SPONSOR_KEYPAIR_PATH. Everything else keeps the service's own defaults.
set -euo pipefail
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
KEYFILE=${HELIUS_KEY_FILE:-/mnt/c/Users/glyde/Documents/helius-key.txt}
if [ -z "${RPC_URL:-}" ] && [ -f "$KEYFILE" ]; then
  KEY=$(python3 -c "import re,sys;t=open(sys.argv[1],encoding='utf-8-sig').read().strip();m=re.search(r'api-key=([A-Za-z0-9-]+)',t);print(m.group(1) if m else t)" "$KEYFILE")
  RPC_URL="https://devnet.helius-rpc.com/?api-key=$KEY"
  echo "▸ Using your Helius devnet RPC"
fi
RPC=${RPC_URL:-https://api.devnet.solana.com}
# Optional Pyth API key (Hermes needs one since Aug 2026); without it devnet uses the sponsored feed.
PYTH_KEY_FILE=${PYTH_KEY_FILE:-/mnt/c/Users/glyde/Documents/pyth-key.txt}
if [ -z "${PYTH_API_KEY:-}" ] && [ -f "$PYTH_KEY_FILE" ]; then
  export PYTH_API_KEY=$(python3 -c "import sys;print(open(sys.argv[1],encoding='utf-8-sig').read().strip())" "$PYTH_KEY_FILE")
  echo "▸ Using your Pyth API key"
fi
LOG=${LOG_DIR:-/mnt/c/Users/glyde/Documents/ringside-logs}
mkdir -p "$LOG"

# ---------------------------------------------------------------------------
# Backend services: indexer, social, sponsor, copy (pid files and logs in $LOG)
# ---------------------------------------------------------------------------
INDEXER_PORT=${INDEXER_PORT:-8790}; SOCIAL_PORT=${SOCIAL_PORT:-8791}
SPONSOR_PORT=${SPONSOR_PORT:-8792}; COPY_PORT=${COPY_PORT:-8793}
ALL_SERVICES="keeper relayer indexer social sponsor copy"

svc_port()  { case $1 in keeper) echo 8789;; relayer) echo 8787;; indexer) echo "$INDEXER_PORT";; social) echo "$SOCIAL_PORT";; sponsor) echo "$SPONSOR_PORT";; copy) echo "$COPY_PORT";; esac; }
svc_path()  { case $1 in indexer) echo "/leaderboard?window=24h";; *) echo /health;; esac; }
svc_entry() { case $1 in keeper|relayer) echo "dist/$1.js";; sponsor) echo dist/sponsor.js;; *) echo "dist/$1/main.js";; esac; }
svc_pid()   { local f="$LOG/$1.pid"; [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && cat "$f"; return 0; }
svc_ok()    { curl -sf --max-time 3 "http://127.0.0.1:$(svc_port "$1")$(svc_path "$1")" >/dev/null 2>&1; }
check_svc() { case $1 in keeper|relayer|indexer|social|sponsor|copy) ;; *) echo "unknown service '$1' (one of: $ALL_SERVICES)" >&2; exit 2;; esac; }
bytes()     { printf %s "$1" | wc -c | tr -d ' '; }   # length only; the value is never printed

# Prints one line per missing or too-short variable, never a value. Returns 1 if any problem.
need_env() {
  local bad=0 spec name min
  for spec in "$@"; do
    name=${spec%%:*}; min=${spec##*:}
    if [ -z "${!name:-}" ]; then echo "  $name is not set" >&2; bad=1
    elif [ "$min" != "$spec" ] && [ "$(bytes "${!name}")" -lt "$min" ]; then echo "  $name must be at least $min bytes" >&2; bad=1; fi
  done
  return $bad
}

start_svc() {
  local svc=$1 pid
  if [ -n "$(svc_pid "$svc")" ]; then echo "  $svc already running (pid $(svc_pid "$svc"))"; return 0; fi
  case $svc in
    indexer) need_env HELIUS_WEBHOOK_SECRET:16 || { echo "indexer: missing required env" >&2; return 1; };;
    social)  need_env SESSION_SECRET:32 SOCIAL_DOMAIN || { echo "social: missing required env" >&2; return 1; };;
    sponsor)
      [ -n "${SPONSOR_SESSION_SECRET:-}" ] || export SPONSOR_SESSION_SECRET=${SESSION_SECRET:-}   # the service accepts either name
      need_env SPONSOR_SESSION_SECRET:32 SPONSOR_KEYPAIR_PATH || { echo "sponsor: missing required env (SPONSOR_SESSION_SECRET or SESSION_SECRET, SPONSOR_KEYPAIR_PATH)" >&2; return 1; }
      [ -f "$SPONSOR_KEYPAIR_PATH" ] || { echo "sponsor: SPONSOR_KEYPAIR_PATH does not point to a file" >&2; return 1; };;
    copy)
      echo "copy: cannot be started on its own yet: client/src/copy/main.ts exports startCopyService() and has no entry point" >&2
      echo "      (the social port is not wired; see the TODO there). Status and stop work once it runs on :$COPY_PORT." >&2
      return 1;;
  esac
  ( cd client && npm run build --silent )
  echo "▸ Starting $svc on :$(svc_port "$svc") (logs: $LOG/$svc.log)"
  case $svc in
    indexer) (cd client; INDEXER_PORT=$INDEXER_PORT nohup node "$(svc_entry indexer)" > "$LOG/indexer.log" 2>&1 & echo $! > "$LOG/indexer.pid");;
    social)  (cd client; SOCIAL_PORT=$SOCIAL_PORT nohup node "$(svc_entry social)" > "$LOG/social.log" 2>&1 & echo $! > "$LOG/social.pid");;
    sponsor) (cd client; RPC_URL=$RPC SPONSOR_PORT=$SPONSOR_PORT nohup node "$(svc_entry sponsor)" > "$LOG/sponsor.log" 2>&1 & echo $! > "$LOG/sponsor.pid");;
  esac
  local i; for i in $(seq 1 20); do svc_ok "$svc" && { echo "  $svc is up"; return 0; }; sleep 1; done
  echo "$svc did not become healthy; last log lines:" >&2; tail -n 15 "$LOG/$svc.log" >&2
  return 1
}

stop_svc() {
  local svc=$1 pid; pid=$(svc_pid "$svc")
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true
  else case $svc in keeper|relayer) pkill -f "node $(svc_entry "$svc")" 2>/dev/null || true;; esac; fi
  rm -f "$LOG/$svc.pid"
  echo "  $svc stopped"
}

status_svc() {
  local svc=$1 pid; pid=$(svc_pid "$svc")
  if svc_ok "$svc"; then echo "  $svc: up on :$(svc_port "$svc")${pid:+ (pid $pid)}"
  elif [ -n "$pid" ]; then echo "  $svc: running (pid $pid) but :$(svc_port "$svc")$(svc_path "$svc") is not answering"; return 1
  else echo "  $svc: down"; return 1; fi
}

CMD=${1:-}
case $CMD in
  start|stop|status)
    shift; rc=0
    if [ $# -eq 0 ]; then
      case $CMD in start) echo "usage: services.sh start <indexer|social|sponsor|copy>..." >&2; exit 2;; *) set -- $ALL_SERVICES;; esac
    fi
    for svc in "$@"; do check_svc "$svc"; done
    for svc in "$@"; do
      case $CMD in
        start) case $svc in keeper|relayer) echo "$svc is started by running services.sh with no arguments" >&2; rc=1;; *) start_svc "$svc" || rc=1;; esac;;
        stop) stop_svc "$svc";;
        status) status_svc "$svc" || rc=1;;
      esac
    done
    exit $rc;;
  "") ;;
  *) echo "usage: services.sh [start|stop|status [service...]]" >&2; exit 2;;
esac

PERPS=$(solana address -k target/deploy/ringside_perps-keypair.json)
USDC=$(node -p "require('./devnet-deployment.json').usdcMint")
WALLET="$HOME/.config/solana/id.json"
RELAYER_KP="$HOME/.config/solana/relayer.json"

[ -f "$RELAYER_KP" ] || solana-keygen new --no-bip39-passphrase --silent -o "$RELAYER_KP"
REL=$(solana address -k "$RELAYER_KP")
if [ "$(solana balance "$REL" --url "$RPC" --lamports | awk '{print $1}')" -lt 300000000 ]; then
  echo "▸ Funding the relayer with 0.5 SOL from your wallet"
  solana transfer --url "$RPC" --allow-unfunded-recipient "$REL" 0.5 >/dev/null
fi

cd client
npm install --silent
npm run build --silent

pkill -f "node dist/keeper.js" 2>/dev/null || true
pkill -f "node dist/relayer.js" 2>/dev/null || true
echo "▸ Starting keeper (logs: $LOG/keeper.log)"
PYTH_API_KEY=${PYTH_API_KEY:-} PERPS_PROGRAM_ID=$PERPS RPC_URL=$RPC KEEPER_KEYPAIR=$WALLET USDC_MINT=$USDC KEEPER_INTERVAL_MS=3000 \
  ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL:-} KEEPER_HEALTH_PORT=8789 RELAYER_ADDRESS=$(solana-keygen pubkey "$RELAYER_KP" 2>/dev/null) \
  MONITOR_IGNORE_MARKETS=${MONITOR_IGNORE_MARKETS:-} \
  nohup node dist/keeper.js > "$LOG/keeper.log" 2>&1 &
echo $! > "$LOG/keeper.pid"
echo "▸ Starting relayer on :8787 (logs: $LOG/relayer.log)"
PINATA_JWT=${PINATA_JWT:-} PUBLIC_URL=${PUBLIC_URL:-http://localhost:5173/relayer} METADATA_DIR=$HOME/ringside-metadata \
  PERPS_PROGRAM_ID=$PERPS RPC_URL=$RPC RELAYER_KEYPAIR=$RELAYER_KP PORT=8787 \
  nohup node dist/relayer.js > "$LOG/relayer.log" 2>&1 &
echo $! > "$LOG/relayer.pid"
sleep 4
curl -sf localhost:8787/health >/dev/null && echo "  relayer is up" || { echo "relayer did not start:"; cat "$LOG/relayer.log"; exit 1; }

if [ "${SKIP_TEST:-0}" = 1 ]; then echo "  keeper and relayer running"; exit 0; fi
echo "▸ Running the sponsored-order test"
ANCHOR_PROVIDER_URL=$RPC ANCHOR_WALLET=$WALLET RELAYER_URL=http://localhost:8787 \
  npx tsx scripts/sponsored-order-devnet.ts 2>&1 | tee "$LOG/sponsored-test.log"
echo
echo "Keeper and relayer keep running in the background. Stop them with:"
echo "  bash scripts/services.sh stop keeper relayer"
