import crypto from 'node:crypto';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import { Kafka } from 'kafkajs';
import { request as undiciRequest } from 'undici';

const { Pool } = pg;

const app = Fastify({ logger: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const kafka = new Kafka({ clientId: 'webhook-service', brokers: kafkaBrokers });

function signPayload(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function computeBackoffSeconds(attemptCount: number): number {
  const base = 5;
  const seconds = Math.pow(base, Math.max(1, attemptCount));
  return Math.min(seconds, 60 * 60);
}

app.get('/health', async () => ({ ok: true }));

app.post('/webhook-subscriptions', async (req: FastifyRequest, reply: FastifyReply) => {
  const merchantId = (req.headers['x-merchant-id'] as string | undefined) ?? '';
  if (!merchantId) return reply.code(401).send({ error: 'missing_merchant' });

  const body = req.body as any;
  if (!body || typeof body.callbackUrl !== 'string' || !Array.isArray(body.events) || typeof body.secret !== 'string') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const res = await pool.query(
    'INSERT INTO webhook_subscriptions (merchant_id, callback_url, secret, events, enabled) VALUES ($1,$2,$3,$4,true) RETURNING id',
    [merchantId, body.callbackUrl, body.secret, body.events]
  );

  return reply.code(201).send({ id: res.rows[0].id });
});

app.get('/webhook-deliveries', async (req: FastifyRequest, reply: FastifyReply) => {
  const merchantId = (req.headers['x-merchant-id'] as string | undefined) ?? '';
  if (!merchantId) return reply.code(401).send({ error: 'missing_merchant' });

  const q = req.query as any;
  const limit = Math.min(Number(q?.limit ?? 50), 200);

  const res = await pool.query(
    'SELECT id, event_type, status, attempt_count, next_attempt_at, last_error, last_status_code, created_at, updated_at FROM webhook_deliveries WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2',
    [merchantId, limit]
  );

  return reply.send({ deliveries: res.rows });
});

async function deliverWebhook(params: {
  callbackUrl: string;
  secret: string;
  eventType: string;
  eventPayload: any;
}) {
  const payload = JSON.stringify({
    id: crypto.randomUUID(),
    type: params.eventType,
    created: Math.floor(Date.now() / 1000),
    data: { object: params.eventPayload }
  });

  const signature = `sha256=${signPayload(params.secret, payload)}`;
  const res = await undiciRequest(params.callbackUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': signature
    },
    body: payload
  });

  return res.statusCode;
}

async function enqueueDeliveries(params: {
  merchantId: string;
  eventType: string;
  eventPayload: any;
}) {
  const subsRes = await pool.query(
    'SELECT callback_url, secret, events FROM webhook_subscriptions WHERE merchant_id = $1 AND enabled = true',
    [params.merchantId]
  );

  for (const sub of subsRes.rows) {
    const events: string[] = sub.events ?? [];
    if (!events.includes(params.eventType)) continue;

    await pool.query(
      'INSERT INTO webhook_deliveries (merchant_id, callback_url, secret, event_type, event_payload, status, attempt_count, next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())',
      [params.merchantId, sub.callback_url, sub.secret, params.eventType, params.eventPayload, 'pending', 0]
    );
  }
}

async function startDeliveryWorker() {
  const pollMs = Number(process.env.WEBHOOK_WORKER_POLL_MS ?? 1000);
  const maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 10);

  setInterval(async () => {
    try {
      const due = await pool.query(
        `SELECT id, merchant_id, callback_url, secret, event_type, event_payload, attempt_count
         FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC
         LIMIT 25`
      );

      for (const row of due.rows) {
        try {
          const statusCode = await deliverWebhook({
            callbackUrl: row.callback_url,
            secret: row.secret,
            eventType: row.event_type,
            eventPayload: row.event_payload
          });

          if (statusCode >= 200 && statusCode < 300) {
            await pool.query(
              'UPDATE webhook_deliveries SET status = $1, attempt_count = attempt_count + 1, last_error = NULL, last_status_code = $2 WHERE id = $3',
              ['succeeded', statusCode, row.id]
            );
          } else {
            const nextAttempt = Number(row.attempt_count) + 1;
            if (nextAttempt >= maxAttempts) {
              await pool.query(
                'UPDATE webhook_deliveries SET status = $1, attempt_count = attempt_count + 1, last_error = $2, last_status_code = $3 WHERE id = $4',
                ['failed', `http_${statusCode}`, statusCode, row.id]
              );
            } else {
              const nextSeconds = computeBackoffSeconds(nextAttempt);
              await pool.query(
                'UPDATE webhook_deliveries SET attempt_count = attempt_count + 1, last_error = $1, last_status_code = $2, next_attempt_at = now() + ($3 || \' seconds\')::interval WHERE id = $4',
                [`http_${statusCode}`, statusCode, nextSeconds, row.id]
              );
            }
          }
        } catch (e: any) {
          const nextAttempt = Number(row.attempt_count) + 1;
          if (nextAttempt >= maxAttempts) {
            await pool.query(
              'UPDATE webhook_deliveries SET status = $1, attempt_count = attempt_count + 1, last_error = $2, last_status_code = NULL WHERE id = $3',
              ['failed', e?.message ?? 'delivery_error', row.id]
            );
          } else {
            const nextSeconds = computeBackoffSeconds(nextAttempt);
            await pool.query(
              'UPDATE webhook_deliveries SET attempt_count = attempt_count + 1, last_error = $1, last_status_code = NULL, next_attempt_at = now() + ($2 || \' seconds\')::interval WHERE id = $3',
              [e?.message ?? 'delivery_error', nextSeconds, row.id]
            );
          }
        }
      }
    } catch (err: any) {
      app.log.error({ err }, 'webhook_delivery_worker_error');
    }
  }, pollMs);
}

async function startConsumer() {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const groupId =
    process.env.KAFKA_CONSUMER_GROUP_ID ??
    (nodeEnv === 'production' ? 'webhook-service' : `webhook-service-${crypto.randomUUID()}`);
  const consumer = kafka.consumer({ groupId });

  await consumer.connect();
  await consumer.subscribe({
    topic: 'paymentdb.public.payment_intents',
    fromBeginning: nodeEnv !== 'production'
  });

  await consumer.run({
    eachMessage: async ({ message }: { message: { value: Buffer | null } }) => {
      if (!message.value) return;
      const evt = JSON.parse(message.value.toString('utf8'));

      const payload = evt?.payload ?? evt;
      const after = payload?.after;
      const op = payload?.op;
      if (!after || (op !== 'c' && op !== 'u' && op !== 'r')) return;

       app.log.info({ op, table: payload?.source?.table, id: after?.id, status: after?.status }, 'cdc_payment_intents_event');

      const merchantId = after.merchant_id;
      const status = after.status;

      let eventType: string | null = null;
      if (status === 'succeeded') eventType = 'payment.succeeded';
      if (status === 'failed') eventType = 'payment.failed';
      if (!eventType) return;

      app.log.info({ merchantId, eventType, paymentIntentId: after.id, op }, 'enqueue_webhook_deliveries');

      await enqueueDeliveries({
        merchantId,
        eventType,
        eventPayload: {
          id: after.id,
          amountInCents: after.amount_in_cents,
          currency: after.currency,
          status
        }
      });
    }
  });
}

await startConsumer();
await startDeliveryWorker();

const port = Number(process.env.PORT ?? 3003);
await app.listen({ port, host: '0.0.0.0' });
