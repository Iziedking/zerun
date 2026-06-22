import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { app } from "./api/index.js";
import { attachWebSocket } from "./coordinator/ws.js";
import { computeMode } from "./compute/client.js";
import { deploymentReady } from "./chain/contracts.js";

// Single process: the read API, the live-feed WebSocket, and the coordinator
// triggers all run here. The coordinator runs contests on demand (admin/demo
// endpoints); there is no always-on scheduler in the MVP.

const server = serve({ fetch: app.fetch, port: config.server.port }, (info) => {
  console.log(`Zerun backend listening on http://localhost:${info.port}`);
  console.log(`compute mode: ${computeMode()}`);
  console.log(`deployment ready: ${deploymentReady()}`);
});

attachWebSocket(server as unknown as Parameters<typeof attachWebSocket>[0]);
