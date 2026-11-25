#!/usr/bin/env bash
# Ringside mainnet build. Builds WITHOUT the devnet feature (30 SOL virtual
# curves, mainnet Raydium program/config/fee receiver, 10% max cap), stops on
# any SBF stack-frame warning, and prints the deploy and configuration steps.
# It does not deploy on its own: mainnet deploys go through a multisig.
set -euo pipefail
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."

echo "▸ Building for mainnet (no devnet feature)"
anchor build > /tmp/ringside-mainnet-build.log 2>&1 || { tail -30 /tmp/ringside-mainnet-build.log; exit 1; }
if grep -qi "stack offset" /tmp/ringside-mainnet-build.log; then
  grep -i "stack offset" /tmp/ringside-mainnet-build.log | sed -E 's/.*Function ([^ ]+) Stack/\1: Stack/' | sort -u
  echo "✗ A function overflows its 4 KB stack frame. Fix it before deploying."
  exit 1
fi
# Program binaries hold addresses as raw bytes, so decode the devnet Raydium ID and search for those.
if python3 - target/deploy/ringside_launch.so <<'PY'
import sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for ch in "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb":
    n = n * 58 + A.index(ch)
devnet_raydium = n.to_bytes(32, "big")
sys.exit(0 if devnet_raydium in open(sys.argv[1], "rb").read() else 1)
PY
then
  echo "✗ The launch program still references Raydium's DEVNET program. Was the devnet feature left on?"
  exit 1
fi
for p in ringside_launch ringside_perps; do
  printf "  %-16s %s  %s bytes\n" "$p" "$(solana address -k target/deploy/$p-keypair.json)" "$(stat -c%s target/deploy/$p.so)"
done

cat <<'MSG'

✓ Mainnet build is clean. Remaining steps (see the spec's Mainnet launch checklist):

  1. Audits signed off on exactly this build (compare the .so hashes: sha256sum target/deploy/*.so).
  2. Deploy each program with a funded deployer:
       solana program deploy target/deploy/ringside_launch.so --program-id target/deploy/ringside_launch-keypair.json -u mainnet-beta
       solana program deploy target/deploy/ringside_perps.so  --program-id target/deploy/ringside_perps-keypair.json  -u mainnet-beta
  3. Move both upgrade authorities to the Squads multisig:
       solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT> -u mainnet-beta
  4. Configure (dry run first, then CONFIRM=yes):
       cd client && ANCHOR_PROVIDER_URL=<mainnet RPC> FEE_RECIPIENT=<treasury> INSURANCE_RECIPIENT=<insurance> \
         npx tsx scripts/init-mainnet.ts
  5. Seed the vault, start two keepers (PYTH_API_KEY, NETWORK=mainnet) and the relayer, then open the beta.
MSG
