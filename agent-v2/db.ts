/**
 * Postgres pool used by the ranker scripts.
 *
 * Vanilla `pg` so it works against any Postgres — Supabase, RDS,
 * self-hosted, neon, doesn't matter. The queries the ranker runs are
 * standard SQL.
 *
 * Connection comes from DATABASE_URL. For Supabase, that's the
 * "Connection string" you find under Project Settings → Database →
 * "Connection pooling" (session mode is fine here — the scripts are
 * short-lived).
 */
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy agent-v2/.env.example to .env and fill it in.',
  );
}

export const pool = new Pool({
  connectionString,
  // Supabase pooled connections terminate idle clients aggressively;
  // these are one-shot scripts so we can keep the pool small.
  max: 4,
  idleTimeoutMillis: 5_000,
});
