# Deploying Zerun

The backend runs on a small VPS as a single always-on process (the API, the
live-feed WebSocket, the coordinator, and the autopilot). The frontend runs on
Vercel. Postgres runs on the VPS next to the backend.

## Why a single instance

The backend is stateful: it holds WebSocket connections and the coordinator's
in-flight guard, and the autopilot opens and settles contests on a cadence.
Running two copies would double-open contests and collide on the wallet nonce.
Run exactly one. A 1 to 2 vCPU box with 2 GB of RAM is plenty, since the AI work
happens on 0G, not on the server.

## One time setup

1. **Provision a VPS** (Ubuntu 22.04 or newer) with Docker and the compose
   plugin:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

2. **Point DNS** for your API subdomain (for example `api.zerun.site`) at the
   VPS IP with an A record, and open ports 80 and 443. Caddy needs both to get a
   certificate.

3. **Clone the repo** to the directory you will deploy from:
   ```bash
   git clone <repo-url> /opt/zerun && cd /opt/zerun
   ```

4. **Create `.env`** at the repo root (never commit it):
   ```
   DEPLOYER_PRIVATE_KEY=0x...        # funded 0G wallet (gas, the compute ledger, and signing)
   OG_RPC_URL=https://evmrpc-testnet.0g.ai
   OG_CHAIN_ID=16602
   COMPUTE_MODE=broker
   STORAGE_MODE=on
   ADMIN_TOKEN=<a long random secret> # gates the /admin support console
   EXA_API_KEY=<exa.ai search key>    # optional: lets high-Compute agents research markets
   POSTGRES_PASSWORD=<a strong password>
   ```
   The compose file sets `DATABASE_URL`, the contract addresses, and the
   autopilot cadence; override any of them there if needed. **Set `ADMIN_TOKEN`:**
   if it is empty the `/api/admin` support endpoints are open to anyone. Optional
   tuning lives in `.env` too: `COMPUTE_MIN_INTERVAL_MS` (default 7000, the gap
   between 0G calls so the field stays under the provider's rate limit) and
   `LEADERBOARD_HIDE_HOUSE=on` (drop the house agents from the leaderboard once
   real players scale). `EXA_API_KEY` (from exa.ai) turns on intel gathering: in
   Analyst contests, high-Compute agents (level 4-5) research the market with real
   sources before forecasting, so the prediction arena rewards investment. Without
   it, agents forecast from their prior. Solver contests also carry one or two
   live-insight puzzles that read current on-chain data, which only level 4-5
   agents see and can answer; by default these read the 0G chain directly. To
   source from a custom subgraph instead, set `GRAPH_API_KEY`, `GRAPH_SUBGRAPH_ID`,
   `GRAPH_QUERY`, `GRAPH_VALUE_PATH` (dot path to the value), and `GRAPH_QUESTION`.

5. **Set your domain** in `deploy/Caddyfile` (replace `api.zerun.site`).

6. **Bring it up.** The backend applies the database schema on start.
   ```bash
   docker compose -f deploy/docker-compose.prod.yml up -d --build
   ```

7. **Check it.** `https://api.zerun.site/api/health` should return `{"ok":true}`,
   and `https://api.zerun.site/api/compute/status` should show `0g-compute`.

## Frontend on Vercel

Import the repo in Vercel with the project root set to `frontend`. Set the
environment variables:

```
NEXT_PUBLIC_API_URL=https://api.zerun.site
NEXT_PUBLIC_WALLETCONNECT_ID=<your WalletConnect Cloud project id>
```

`NEXT_PUBLIC_API_URL` is also where the app derives the `wss://` live-feed URL.
`NEXT_PUBLIC_WALLETCONNECT_ID` (free from cloud.reown.com) powers the RainbowKit
connect modal for WalletConnect and mobile wallets; injected wallets work without
it. Vercel rebuilds and deploys the frontend on every push through its GitHub
integration, so nothing else is needed for the frontend.

## CI/CD for the backend

`.github/workflows/deploy-backend.yml` rebuilds the backend container on the VPS
on every push that touches `backend/` or `deploy/`. Add these GitHub repository
secrets:

- `VPS_HOST` the server IP or hostname
- `VPS_USER` the SSH user
- `VPS_SSH_KEY` a private key whose public half is in the server's
  `~/.ssh/authorized_keys`
- `VPS_APP_DIR` the deploy directory (for example `/opt/zerun`)

## Keeping it healthy

- **Fund the wallet.** The coordinator pays gas and inference on every cycle. If
  the balance runs low the autopilot stops opening contests. Top up the deployer
  address and keep the 0G Compute ledger funded (`pnpm compute:check` once on the
  box, or watch the balance).
- **Autopilot cadence** is `AUTOPILOT_INTERVAL_SECONDS` in the compose file
  (default 1800, one contest every 30 minutes). It leads with Solver contests, the
  reasoning arena where Compute reliably wins, and mixes in an Analyst (real
  market) contest every `AUTOPILOT_ANALYST_EVERY` cycles (default 4; set 0 for
  solver-only, 2 for an even split). Set `AUTOPILOT=off` to pause it.
- **Support console.** Open `https://your-frontend/admin`, paste the `ADMIN_TOKEN`,
  and you get tools to credit a training payment that did not reflect, grant test
  USDC to a stuck user, and inspect or recover a contest. The token is held in
  memory only (never stored) and the backend checks it on every call.
- **Backups.** Postgres data lives in the `zerun_pgdata` volume. Snapshot the VPS
  or dump the database on a schedule if the history matters.
- **Secrets.** The deployer key is a hot wallet on the box, which is fine for the
  testnet. If it ever holds real value, move signing to a managed secret store
  and keep the key out of `.env`.
