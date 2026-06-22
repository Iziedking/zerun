import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, closePool } from "../db/pool.js";

// Apply the schema. Idempotent (every statement is IF NOT EXISTS).
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(here, "../db/schema.sql"), "utf8");
  await query(sql);
  console.log("schema applied");
  await closePool();
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
