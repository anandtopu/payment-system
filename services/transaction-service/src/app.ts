import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';

const { Pool } = pg;

type PaymentIntentStatus = 'created' | 'processing' | 'succeeded' | 'failed';

type TransactionStatus = 'pending' | 'succeeded' | 'failed' | 'timeout';

export const app = Fastify({ logger: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mockAuthorize(cardNumber: string): { outcome: 'succeeded' | 'failed' | 'timeout'; reason?: string } {
  if (!cardNumber || typeof cardNumber !== 'string') return { outcome: 'failed', reason: 'invalid_card' };
  if (cardNumber.endsWith('0000')) return { outcome: 'failed', reason: 'insufficient_funds' };
  if (cardNumber.endsWith('9999')) return { outcome: 'timeout' };
  return { outcome: 'succeeded' };
}

app.get('/health', async () => ({ ok: true }));

app.post('/payment-intents/:paymentIntentId/transactions', async (req: FastifyRequest, reply: FastifyReply) => {
  const merchantId = (req.headers['x-merchant-id'] as string | undefined) ?? '';
  if (!merchantId) return reply.code(401).send({ error: 'missing_merchant' });

  const { paymentIntentId } = req.params as any;
  const body = req.body as any;
  if (!body || body.type !== 'charge') return reply.code(400).send({ error: 'invalid_type' });
  if (!body.card || typeof body.card.number !== 'string') return reply.code(400).send({ error: 'invalid_card' });

  const piRes = await pool.query(
    'SELECT id, amount_in_cents, currency, status FROM payment_intents WHERE id = $1 AND merchant_id = $2',
    [paymentIntentId, merchantId]
  );
  if (!piRes.rowCount) return reply.code(404).send({ error: 'payment_intent_not_found' });

  const paymentIntent = piRes.rows[0] as any;
  const currentStatus = paymentIntent.status as PaymentIntentStatus;
  if (currentStatus === 'succeeded') return reply.code(409).send({ error: 'already_succeeded' });

  const txRes = await pool.query(
    'INSERT INTO transactions (payment_intent_id, merchant_id, type, amount_in_cents, currency, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status, created_at',
    [paymentIntentId, merchantId, 'charge', paymentIntent.amount_in_cents, paymentIntent.currency, 'pending']
  );
  const tx = txRes.rows[0];

  await pool.query('UPDATE payment_intents SET status = $1 WHERE id = $2 AND merchant_id = $3', [
    'processing',
    paymentIntentId,
    merchantId
  ]);

  const latency = Number(process.env.MOCK_NETWORK_LATENCY_MS ?? 200);
  await sleep(latency);

  const outcome = mockAuthorize(body.card.number);

  let finalTxStatus: TransactionStatus = 'pending';
  let finalPiStatus: PaymentIntentStatus = 'processing';
  let failureReason: string | null = null;

  if (outcome.outcome === 'succeeded') {
    finalTxStatus = 'succeeded';
    finalPiStatus = 'succeeded';
  } else if (outcome.outcome === 'failed') {
    finalTxStatus = 'failed';
    finalPiStatus = 'failed';
    failureReason = outcome.reason ?? 'declined';
  } else {
    finalTxStatus = 'timeout';
    finalPiStatus = 'processing';
    failureReason = 'network_timeout';
  }

  await pool.query('UPDATE transactions SET status = $1, failure_reason = $2 WHERE id = $3', [
    finalTxStatus,
    failureReason,
    tx.id
  ]);

  if (finalPiStatus !== 'processing') {
    await pool.query('UPDATE payment_intents SET status = $1, error_message = $2 WHERE id = $3', [
      finalPiStatus,
      failureReason,
      paymentIntentId
    ]);
  }

  return reply.code(201).send({
    id: tx.id,
    paymentIntentId,
    type: 'charge',
    status: finalTxStatus,
    failureReason,
    createdAt: tx.created_at
  });
});



