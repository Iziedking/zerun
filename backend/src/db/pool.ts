import pg from "pg";
import { config } from "../config/index.js";

// One shared pool for the whole process (the API and the coordinator both use it).
//
// The timeouts here are what keep a busy match from wedging. A poker match writes to the
// DB on every decision (hundreds per match) plus a heavier standings query per hand, and
// several contests plus the API all share this pool. Without a connection timeout, once
// the pool is saturated a new query waits FOREVER for a free connection, so a match hangs
// mid-play, never settles, and only gets stale-cancelled. With these set, a saturated or
// slow query rejects promptly instead of hanging; the callers that matter (the poker
// loops) guard their writes, so a rejected cosmetic write is skipped and the match plays
// on to settlement. All overridable by env for tuning under real load.
const pool = new pg.Pool({
  connectionString: config.db.url,
  max: Number(process.env.PG_POOL_MAX ?? "20"),
  // Do not wait forever for a free connection; fail fast so the caller can move on.
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? "10000"),
  // Release idle connections so a burst does not hold the pool open indefinitely.
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? "30000"),
  // Server-side cap: a runaway query is cancelled instead of holding a connection. Kept
  // well above any normal query (runtime writes are sub-second) and above the boot
  // migration, but far below the multi-minute hang we are guarding against.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? "30000"),
  // Client-side cap on the whole query round trip, a backstop for a stalled connection.
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? "40000"),
});

// A pool-level error (a backend crash, a dropped connection) must not crash the process.
pool.on("error", (err) => {
  console.error("pg pool error (ignored):", err.message);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export { pool };
