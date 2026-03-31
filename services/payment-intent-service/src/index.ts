import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

type PaymentIntentRow = {
  id: string;
  merchant_id: string;
  amount_in_cents: string;
  currency: string;
  description: string | null;
  status: 'created' | 'processing' | 'succeeded' | 'failed';
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

const app = Fastify({ logger: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function getOrCreateIdempotentResponse(params: {
  merchantId: string;
  key: string;
  requestHash: string;
  create: () => Promise<any>;
}): Promise<any> {
  const existing = await pool.query(
    'SELECT response_body FROM idempotency_keys WHERE merchant_id = $1 AND idem_key = $2',
    [params.merchantId, params.key]
  );
  if (existing.rowCount && existing.rows[0]?.response_body) {
    return existing.rows[0].response_body;
  }

  const created = await params.create();

  await pool.query(
    'INSERT INTO idempotency_keys (merchant_id, idem_key, request_hash, response_body) VALUES ($1,$2,$3,$4) ON CONFLICT (merchant_id, idem_key) DO NOTHING',
    [params.merchantId, params.key, params.requestHash, created]
  );

  return created;
}

app.get('/health', async () => ({ ok: true }));

app.post('/payment-intents', async (req: FastifyRequest, reply: FastifyReply) => {
  const merchantId = (req.headers['x-merchant-id'] as string | undefined) ?? '';
  if (!merchantId) return reply.code(401).send({ error: 'missing_merchant' });

  const body = req.body as any;
  if (!body || typeof body.amountInCents !== 'number' || body.amountInCents <= 0) {
    return reply.code(400).send({ error: 'invalid_amount' });
  }
  if (!body.currency || typeof body.currency !== 'string') return reply.code(400).send({ error: 'invalid_currency' });

  const idemKey = (req.headers['idempotency-key'] as string | undefined) ?? undefined;
  const requestHash = sha256(JSON.stringify(body));

  const create = async () => {
    const res = await pool.query<PaymentIntentRow>(
      'INSERT INTO payment_intents (merchant_id, amount_in_cents, currency, description, status) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [merchantId, body.amountInCents, body.currency, body.description ?? null, 'created']
    );
    const row = res.rows[0];
    return {
      id: row.id,
      amountInCents: Number(row.amount_in_cents),
      currency: row.currency,
      description: row.description,
      status: row.status,
      createdAt: row.created_at
    };
  };

  const response = idemKey
    ? await getOrCreateIdempotentResponse({ merchantId, key: idemKey, requestHash, create })
    : await create();

  return reply.code(201).send(response);
});

app.get('/payment-intents/:paymentIntentId', async (req: FastifyRequest, reply: FastifyReply) => {
  const merchantId = (req.headers['x-merchant-id'] as string | undefined) ?? '';
  if (!merchantId) return reply.code(401).send({ error: 'missing_merchant' });

  const { paymentIntentId } = req.params as any;

  const res = await pool.query<PaymentIntentRow>(
    'SELECT * FROM payment_intents WHERE id = $1 AND merchant_id = $2',
    [paymentIntentId, merchantId]
  );

  if (!res.rowCount) return reply.code(404).send({ error: 'not_found' });
  const row = res.rows[0];

  return reply.send({
    id: row.id,
    amountInCents: Number(row.amount_in_cents),
    currency: row.currency,
    description: row.description,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
});

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
