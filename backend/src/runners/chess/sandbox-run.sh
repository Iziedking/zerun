#!/usr/bin/env bash
#
# Isolation wrapper for uploaded chess agents. Ships inside the backend image (next to the harness).
# Point the backend at it:
#
#   CHESS_SANDBOX_CMD=bash /app/src/runners/chess/sandbox-run.sh
#
# The runner calls:  sandbox-run.sh <harness.py> <agent.py>
# and this runs the player's untrusted agent under bubblewrap (no network, non-root, ephemeral
# filesystem) with prlimit ceilings (CPU, memory, processes). The agent has NO network of its own;
# its only path to a model is the call_model bridge the harness relays back to the backend over
# stdio, so Zerun always owns (and meters) the inference.
#
# The image already has python3 + bubblewrap (see the Dockerfile). bwrap needs unprivileged user
# namespaces, which Docker's default seccomp profile can block; if it errors with "clone failed" /
# "permission denied", add to the backend service in docker-compose.prod.yml:
#     security_opt:
#       - seccomp=unconfined
# (that relaxes seccomp for the backend container only), or drop --unshare-user below and rely on
# --unshare-net alone for the network cut.

set -euo pipefail

HARNESS="${1:?harness path required}"
AGENT="${2:?agent file path required}"

# Ceilings: 5s CPU, 512 MB address space, 64 processes, no core dumps. A CPU-bound or fork-bombing
# agent hits these; the backend's wall-clock timeout is the second line of defence for idle hangs.
exec prlimit --cpu=5 --as=536870912 --nproc=64 --core=0 -- \
  bwrap \
    --unshare-all \
    --die-with-parent \
    --ro-bind /usr /usr \
    --ro-bind /bin /bin \
    --ro-bind /lib /lib \
    --ro-bind-try /lib64 /lib64 \
    --ro-bind-try /etc/alternatives /etc/alternatives \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --ro-bind "$HARNESS" /sb/harness.py \
    --ro-bind "$AGENT" /sb/agent.py \
    --chdir /sb \
    --clearenv \
    --setenv PATH /usr/bin:/bin \
    --setenv PYTHONDONTWRITEBYTECODE 1 \
    python3 -I -B /sb/harness.py /sb/agent.py
