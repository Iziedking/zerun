#!/usr/bin/env bash
# Set how many agents one operator can hold. Admin only (the deployer).
# Run it:  ! bash contracts/set-max-agents.sh 2
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ../.env
set +a

AGENT_REGISTRY=0x8babef47747c07b3BaaeA2D4184Ba2e42bd3915c
LIMIT="${1:-2}"

echo "setting maxAgentsPerOwner to $LIMIT on $AGENT_REGISTRY"
cast send "$AGENT_REGISTRY" "setMaxAgentsPerOwner(uint16)" "$LIMIT" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --rpc-url "$OG_RPC_URL" \
  --legacy --gas-price 3000000000
echo "done. operators can now hold at most $LIMIT agents."
