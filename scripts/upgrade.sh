#!/usr/bin/env bash
# Ringside devnet upgrade: graduation to Raydium + live Pyth SOL/USD.
#   1. Builds both programs with the devnet feature (0.5 virtual SOL curves).
#   2. Upgrades both programs in place (same IDs), one at a time, checking SOL
#      before each and extending the program accounts if they grew.
#   3. Resizes existing curves and markets for the creator_fees_locked field (resize-accounts.ts).
#   4. Restarts the keeper (now on Pyth) and relayer.
#   5. Sets devnet fees/caps, runs the graduation test and the creator-fee test.
# Safe to re-run: every step picks up where it left off.
set -euo pipefail
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

KEYFILE=${HELIUS_KEY_FILE:-/mnt/c/Users/glyde/Documents/helius-key.txt}
if [ -z "${RPC_URL:-}" ] && [ -f "$KEYFILE" ]; then
  KEY=$(python3 -c "import re,sys;t=open(sys.argv[1],encoding='utf-8-sig').read().strip();m=re.search(r'api-key=([A-Za-z0-9-]+)',t);print(m.group(1) if m else t)" "$KEYFILE")
  export RPC_URL="https://devnet.helius-rpc.com/?api-key=$KEY"
  echo "▸ Using your Helius devnet RPC"
fi
RPC=${RPC_URL:-https://api.devnet.solana.com}
LOG=${LOG_DIR:-/mnt/c/Users/glyde/Documents/ringside-logs}
mkdir -p "$LOG"
WALLET="$HOME/.config/solana/id.json"
redact() { sed -E 's/api-key=[A-Za-z0-9-]+/api-key=<redacted>/g'; }

build() { # build [anchor args...]
  anchor build "$@" -- --features devnet 2>&1 | redact > /tmp/ringside-build.log || { tail -30 /tmp/ringside-build.log; exit 1; }
  tail -3 /tmp/ringside-build.log
  stack_check
}
stack_check() {
if grep -qi "stack offset" /tmp/ringside-build.log; then
  echo "  compiler stack warnings (functions near SBF's 4 KB frame limit):"
  grep -i "stack offset" /tmp/ringside-build.log | sed -E 's/.*Function ([^ ]+) Stack/\1: Stack/' | sort -u | head -12
  echo
  echo "Not deploying: a program function overflows its 4 KB stack frame, which corrupts memory on chain."
  echo "Send this log to Claude (ringside-logs/upgrade.log)."
  exit 1
fi
}
say "Building with the devnet feature"
build

# --- Upgrade, one program at a time ---------------------------------------------------
# Each upgrade temporarily holds about the program's size in SOL (refunded when it
# finishes), plus a small permanent amount if the program grew.
lamports_per_byte=6960
ADDR=$(solana address)
# Deploys sign with the CLI's configured keypair; the tests use $WALLET. They must be the same wallet.
if [ "$ADDR" != "$(solana address -k "$WALLET")" ]; then
  echo "Not deploying: the Solana CLI keypair ($ADDR) is not $WALLET. Run: solana config set --keypair $WALLET"
  exit 1
fi
RELAYER_KP="$HOME/.config/solana/relayer.json"
bal() { solana balance --url "$RPC" --lamports | awk '{print $1}'; }
sol() { awk -v l="$1" 'BEGIN{printf "%.2f", l/1e9}'; }
reclaimed=0
ensure() { # ensure <lamports> <what>
  if [ "$(bal)" -lt "$1" ] && [ $reclaimed = 0 ] && [ -f "$RELAYER_KP" ]; then
    rb=$(solana balance "$(solana address -k "$RELAYER_KP")" --url "$RPC" --lamports | awk '{print $1}')
    if [ "$rb" -gt 60000000 ]; then
      echo "  borrowing $(sol $((rb - 50000000))) SOL back from the relayer (services.sh refunds it after)"
      solana transfer --url "$RPC" --keypair "$RELAYER_KP" --fee-payer "$RELAYER_KP" "$ADDR" "$(sol $((rb - 50000000)))" >/dev/null 2>&1 || true
    fi
    reclaimed=1
  fi
  # Public devnet airdrop (rate-limited; often refuses, costs nothing to try).
  for amt in 2 1 1; do
    [ "$(bal)" -ge "$1" ] && break
    echo "  asking the devnet faucet for $amt SOL"
    solana airdrop "$amt" "$ADDR" --url https://api.devnet.solana.com >/dev/null 2>&1 && sleep 3 || sleep 8
  done
  if [ "$(bal)" -lt "$1" ]; then
    echo; echo "Need $(sol "$1") devnet SOL for $2 and $ADDR has $(sol "$(bal)")."
    echo "Get more at https://faucet.solana.com (paste the address above), then run this again."
    exit 1
  fi
}

# SOL left in buffers by interrupted deploys comes back first.
solana program close --buffers --url "$RPC" 2>/dev/null | grep -i "closed\|reclaim" | redact || true

# Refuse a target/deploy keypair that isn't the real program (a fresh clone's anchor
# build makes random ones; deploying with them would create a new, useless program).
for p in ringside_perps ringside_launch; do
  want=$(sed -n '/^\[programs.devnet\]/,/^\[/p' Anchor.toml | awk -F'"' -v p="$p" '$0 ~ "^"p" " {print $2}')
  have=$(solana address -k target/deploy/$p-keypair.json 2>/dev/null || echo missing)
  if [ "$want" != "$have" ]; then
    echo "Not deploying: target/deploy/$p-keypair.json is $have but Anchor.toml says $want."
    echo "Put the real program keypair there (or run from the copy that has it), then run this again."
    exit 1
  fi
done

for p in ringside_perps ringside_launch; do
  id=$(solana address -k target/deploy/$p-keypair.json)
  size=$(stat -c%s target/deploy/$p.so)
  cur=$(solana program show "$id" --url "$RPC" --output json | node -pe 'JSON.parse(require("fs").readFileSync(0)).dataLen')
  grow=$(( size > cur ? size - cur + 4096 : 0 ))
  if solana program dump "$id" /tmp/$p.onchain.so --url "$RPC" >/dev/null 2>&1 && cmp -s -n "$size" target/deploy/$p.so /tmp/$p.onchain.so; then
    say "$p is already up to date on devnet"
    continue
  fi
  say "Upgrading $p ($size bytes, on chain $cur)"
  need=$(( (grow + size + 400) * lamports_per_byte + 20000000 ))
  if [ "$(bal)" -lt "$need" ]; then
    # Devnet only: a size-optimised build needs less SOL to deploy (mainnet keeps opt-level 3).
    echo "  $(sol "$(bal)") SOL is short of $(sol "$need"): rebuilding $p size-optimised for devnet"
    CARGO_PROFILE_RELEASE_OPT_LEVEL=s build -p "$p"
    size=$(stat -c%s target/deploy/$p.so)
    grow=$(( size > cur ? size - cur + 4096 : 0 ))
    echo "  $p is now $size bytes"
  fi
  ensure $(( (grow + size + 400) * lamports_per_byte + 20000000 )) "the $p upgrade"
  if [ $grow -gt 0 ]; then
    solana program extend "$id" "$grow" --url "$RPC" 2>&1 | redact
  fi
  for try in 1 2 3; do
    if solana program deploy target/deploy/$p.so --program-id target/deploy/$p-keypair.json --url "$RPC" \
         --use-rpc --with-compute-unit-price 2000 --max-sign-attempts 60 2>&1 | redact; then break; fi
    echo "  deploy attempt $try failed; closing its buffer and retrying"
    solana program close --buffers --url "$RPC" >/dev/null 2>&1 || true
    sleep 5
    [ $try = 3 ] && { echo "Upgrade failed after 3 tries. Run this again."; exit 1; }
  done
done
# Layout migration: Curve and Market gained creator_fees_locked (8 bytes). Grow the existing
# accounts before anything that reads them runs (the keeper and relayer restart below).
# Re-runs are harmless: accounts already at full size are skipped. A failure stops the upgrade here.
say "Resizing existing curves and markets (creator_fees_locked field)"
(cd client && ANCHOR_PROVIDER_URL=$RPC ANCHOR_WALLET=$WALLET npx tsx scripts/resize-accounts.ts 2>&1 | sed -u -E 's/api-key=[A-Za-z0-9-]+/api-key=<redacted>/g' | tee "$LOG/resize.log")

GRAD_TEST=1
if [ "$(bal)" -lt 2100000000 ]; then
  echo "  $(sol "$(bal)") SOL left: skipping the graduation test this time (it needs 2.1 SOL to buy out a curve)"
  GRAD_TEST=0
fi

say "Restarting keeper (Pyth price) and relayer"
SKIP_TEST=1 bash scripts/services.sh

cd client
if [ $GRAD_TEST = 1 ]; then
  say "Graduation and Pyth test"
  ANCHOR_PROVIDER_URL=$RPC ANCHOR_WALLET=$WALLET npx tsx scripts/graduation-devnet.ts 2>&1 | sed -u -E 's/api-key=[A-Za-z0-9-]+/api-key=<redacted>/g' | tee "$LOG/graduation-test.log"
fi
say "Creator-fee test (20% claimable, 80% locked until graduation, early forfeit refused)"
ANCHOR_PROVIDER_URL=$RPC ANCHOR_WALLET=$WALLET npx tsx scripts/fee-lock-devnet.ts 2>&1 | sed -u -E 's/api-key=[A-Za-z0-9-]+/api-key=<redacted>/g' | tee "$LOG/fee-lock-test.log"
say "Treasury sweep (protocol fees into treasury-owned vault liquidity)"
TREASURY_KEEP_USDC=${TREASURY_KEEP_USDC:-1000} ANCHOR_PROVIDER_URL=$RPC ANCHOR_WALLET=$WALLET npx tsx scripts/treasury.ts sweep 2>&1 | sed -u -E 's/api-key=[A-Za-z0-9-]+/api-key=<redacted>/g' | tee "$LOG/treasury.log"
