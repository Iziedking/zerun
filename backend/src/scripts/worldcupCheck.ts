import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, closePool } from "../db/pool.js";
import { syncWorldCupMarkets, pickMissionMarkets } from "../runners/worldcup.js";

// End-to-end check of Phase 1 of the World Cup Prediction Mission: apply the schema,
// pull the live World Cup markets from Polymarket into the pool, and draw two missions
// to show the rotation picks fresh markets each time.  npm run worldcup:check

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(here, "../db/schema.sql"), "utf8");
  await query(sql);
  console.log("schema applied");

  console.log("\npulling World Cup markets from Polymarket...");
  const n = await syncWorldCupMarkets();
  console.log(`synced ${n} binary markets`);

  const { rows: stat } = await query<{ total: string; unresolved: string; events: string }>(
    `select count(*) as total,
            count(*) filter (where resolved = false) as unresolved,
            count(distinct event_title) as events
       from worldcup_markets`,
  );
  console.log(
    `pool: ${stat[0]?.total ?? 0} markets across ${stat[0]?.events ?? 0} events, ${stat[0]?.unresolved ?? 0} unresolved`,
  );

  for (let i = 1; i <= 2; i++) {
    const mission = await pickMissionMarkets(5);
    console.log(`\nmission ${i} (${mission.length} events):`);
    for (const m of mission) console.log(`  - [${m.groupTitle || m.eventTitle}] ${m.question}`);
  }

  await closePool();
}

main().catch((err) => {
  console.error("worldcup check failed:", err);
  process.exit(1);
});
