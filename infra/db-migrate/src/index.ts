import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  const migrationsDir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'migrations');

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'db_migrate_start', migrationsDir }));

  const maxAttempts = Number(process.env.DB_CONNECT_MAX_ATTEMPTS ?? 30);
  const delayMs = Number(process.env.DB_CONNECT_DELAY_MS ?? 1000);

  let client: pg.PoolClient | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      client = await pool.connect();
      break;
    } catch (e: any) {
      const code = e?.code;
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ level: 'warn', msg: 'db_connect_retry', attempt, maxAttempts, code }));
      if (attempt === maxAttempts) throw e;
      await sleep(delayMs);
    }
  }

  if (!client) throw new Error('failed_to_connect');
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const files = (await fs.readdir(migrationsDir))
    .filter((f: string) => f.endsWith('.sql'))
    .sort((a: string, b: string) => a.localeCompare(b));

  for (const file of files) {
    const id = file;
    const already = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id]);
    if (already.rowCount) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await c.query('COMMIT');
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ level: 'info', msg: 'db_migrate_applied', id }));
    } catch (e: any) {
      try {
        await c.query('ROLLBACK');
      } catch {}
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', msg: 'db_migrate_failed', id, err: e?.message ?? String(e) }));
      process.exit(1);
    } finally {
      c.release();
    }
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'db_migrate_done', count: files.length }));
  await pool.end();
}

await main();
