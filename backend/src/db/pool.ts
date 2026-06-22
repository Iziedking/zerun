import pg from "pg";
import { config } from "../config/index.js";

// One shared pool for the whole process. Queries are small and short-lived.
const pool = new pg.Pool({ connectionString: config.db.url, max: 8 });

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
