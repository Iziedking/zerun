# Zerun backend: the read API, the live-feed WebSocket, and the coordinator.
FROM node:22-slim

WORKDIR /app
RUN npm install -g pnpm@11.0.8

# Install dependencies first for better layer caching. Skip native build scripts
# (--ignore-scripts); the broker and storage SDKs use their JavaScript fallbacks,
# and esbuild/tsx come from platform packages, not build scripts.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --ignore-scripts

COPY . .

EXPOSE 8787

# Apply the schema (idempotent), then start the server. tsx is invoked directly
# so pnpm does not run its dependency check at container start.
CMD ["sh", "-c", "node_modules/.bin/tsx src/scripts/migrate.ts && node_modules/.bin/tsx src/server.ts"]
