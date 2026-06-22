#!/usr/bin/env bash
# Deploy the Zerun contracts to 0G Galileo. Reads the deployer key from the
# gitignored root .env so the key never has to be typed or pasted anywhere.
#
# Run it yourself:  ! bash contracts/deploy-0g.sh
set -euo pipefail

cd "$(dirname "$0")"            # contracts/
set -a
. ../.env                       # loads DEPLOYER_PRIVATE_KEY, OG_RPC_URL, OG_CHAIN_ID
set +a

echo "deployer: $(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
echo "rpc:      $OG_RPC_URL"

forge script script/Deploy.s.sol:Deploy \
  --rpc-url og_testnet \
  --broadcast \
  --skip-simulation

echo
echo "Deployed. Addresses written to contracts/deployments/0g-galileo.json"
