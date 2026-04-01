import pg from 'pg';
import { GoogleGenAI } from '@google/genai';

const { Pool } = pg;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

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
    let agentReasoning = 'reconciled_timeout';
    let forceFail = true;

    if (ai) {
      try {
        const prompt = `You are a Smart Reconciliation Agent. A transaction (ID: ${tx.id}) for merchant ${tx.merchant_id} has been stuck in 'timeout' for longer than usual.
Raw state: ${JSON.stringify(tx)}
Should we FAIL this transaction completely, or keep it open?
Respond in strictly JSON format like {"decision": "fail" | "keep", "reason": "..."}`;
        
        const res = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt
        });

        const text = res.text?.replace(/```json/g, '').replace(/```/g, '');
        if (text) {
          const parsed = JSON.parse(text);
          if (parsed.decision === 'keep') forceFail = false;
          if (parsed.reason) agentReasoning = parsed.reason;
        }
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ msg: 'llm_reconcile_fail', err: err.message }));
      }
    }

    if (!forceFail) {
      // Agent says keep it open, do not fail.
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ level: 'info', msg: 'agent_kept_open', txId: tx.id }));
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updatedTx = await client.query(
        `UPDATE transactions
         SET status = 'failed',
             failure_reason = COALESCE(failure_reason, $2)
         WHERE id = $1 AND status = 'timeout'
         RETURNING id, payment_intent_id`,
        [tx.id, agentReasoning]
      );

      if (!updatedTx.rowCount) {
        await client.query('ROLLBACK');
        continue;
      }

      const paymentIntentId = updatedTx.rows[0].payment_intent_id;

      await client.query(
        `UPDATE payment_intents
         SET status = 'failed',
             error_message = COALESCE(error_message, $2)
         WHERE id = $1 AND status = 'processing'`,
        [paymentIntentId, agentReasoning]
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

export async function main() {
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
