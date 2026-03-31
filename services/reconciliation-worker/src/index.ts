import pg from 'pg';

const { Pool } = pg;

type Row = {
  id: string;
  payment_intent_id: string;
  merchant_id: string;
  status: 'timeout' | string;
  failure_reason: string | null;
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const pollMs = Number(process.env.RECONCILIATION_POLL_MS ?? 2000);
const reconcileAfterMs = Number(process.env.RECONCILE_AFTER_MS ?? 10_000);

async function reconcileOnce() {
  const res = await pool.query<Row>(
    `SELECT id, payment_intent_id, merchant_id, status, failure_reason
     FROM transactions
     WHERE status = 'timeout'
       AND updated_at <= now() - ($1 || ' milliseconds')::interval
     ORDER BY updated_at ASC
     LIMIT 50`,
    [reconcileAfterMs]
  );

  for (const tx of res.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updatedTx = await client.query(
        `UPDATE transactions
         SET status = 'failed',
             failure_reason = COALESCE(failure_reason, 'reconciled_timeout')
         WHERE id = $1 AND status = 'timeout'
         RETURNING id, payment_intent_id`,
        [tx.id]
      );

      if (!updatedTx.rowCount) {
        await client.query('ROLLBACK');
        continue;
      }

      const paymentIntentId = updatedTx.rows[0].payment_intent_id;

      await client.query(
        `UPDATE payment_intents
         SET status = 'failed',
             error_message = COALESCE(error_message, 'reconciled_timeout')
         WHERE id = $1 AND status = 'processing'`,
        [paymentIntentId]
      );

      await client.query('COMMIT');
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ level: 'info', msg: 'reconciled_timeout', txId: tx.id, paymentIntentId }));
    } catch (e: any) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', msg: 'reconcile_error', err: e?.message ?? String(e) }));
    } finally {
      client.release();
    }
  }
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'reconciliation_worker_started', pollMs, reconcileAfterMs }));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await reconcileOnce();
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', msg: 'reconcile_loop_error', err: e?.message ?? String(e) }));
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

await main();
