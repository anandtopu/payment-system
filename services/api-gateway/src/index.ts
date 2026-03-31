import crypto from 'node:crypto';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import Redis from 'ioredis';
import pg from 'pg';
import { request as undiciRequest } from 'undici';

const { Pool } = pg;

type MerchantRow = {
  id: string;
  public_api_key: string;
  secret_api_key: string;
};

const app = Fastify({ logger: true });

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PAYMENT_INTENT_SERVICE_URL = process.env.PAYMENT_INTENT_SERVICE_URL ?? 'http://localhost:3001';
const TRANSACTION_SERVICE_URL = process.env.TRANSACTION_SERVICE_URL ?? 'http://localhost:3002';
const WEBHOOK_SERVICE_URL = process.env.WEBHOOK_SERVICE_URL ?? 'http://localhost:3003';

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

async function getMerchantByPublicKey(publicKey: string): Promise<MerchantRow | null> {
  const res = await pool.query<MerchantRow>(
    'SELECT id, public_api_key, secret_api_key FROM merchants WHERE public_api_key = $1',
    [publicKey]
  );
  return res.rows[0] ?? null;
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function canonicalBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  return stableStringify(body);
}

function computeSignature(params: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  const payload = [params.method.toUpperCase(), params.path, params.timestamp, params.nonce, params.body].join('\n');
  return crypto.createHmac('sha256', params.secret).update(payload).digest('hex');
}

app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url === '/health') return;
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'production' && req.url.startsWith('/dev/')) return;

  const auth = req.headers['authorization'];
  const timestamp = req.headers['x-request-timestamp'];
  const nonce = req.headers['x-request-nonce'];
  const signatureHeader = req.headers['x-signature'];

  if (!auth || !timestamp || !nonce || !signatureHeader) {
    return reply.code(401).send({ error: 'missing_auth_headers' });
  }

  const m = /^Bearer\s+(.+)$/.exec(Array.isArray(auth) ? auth[0] : auth);
  if (!m) return reply.code(401).send({ error: 'invalid_authorization' });
  const publicKey = m[1];

  const merchant = await getMerchantByPublicKey(publicKey);
  if (!merchant) return reply.code(401).send({ error: 'unknown_merchant' });

  const ts = Array.isArray(timestamp) ? timestamp[0] : timestamp;
  const nonceStr = Array.isArray(nonce) ? nonce[0] : nonce;
  const sigRaw = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const sigMatch = /^sha256=(.+)$/.exec(sigRaw);
  if (!sigMatch) return reply.code(401).send({ error: 'invalid_signature_format' });

  const tsMs = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts);
  if (!Number.isFinite(tsMs)) return reply.code(401).send({ error: 'invalid_timestamp' });
  const now = Date.now();
  const maxSkewMs = 10 * 60 * 1000;
  if (Math.abs(now - tsMs) > maxSkewMs) return reply.code(401).send({ error: 'timestamp_out_of_window' });

  const nonceKey = `nonce:${merchant.id}:${nonceStr}`;
  const wasSet = await redis.set(nonceKey, '1', 'PX', maxSkewMs, 'NX');
  if (wasSet !== 'OK') return reply.code(401).send({ error: 'replayed_nonce' });

  const expected = computeSignature({
    secret: merchant.secret_api_key,
    method: req.method,
    path: req.url,
    timestamp: ts,
    nonce: nonceStr,
    body: canonicalBody(req.body)
  });

  if (!timingSafeEqualHex(expected, sigMatch[1])) {
    const enabled = (process.env.DEV_SIGNING_ENABLED ?? 'false') === 'true';
    if (enabled) {
      const canonical = canonicalBody(req.body);
      return reply.code(401).send({
        error: 'invalid_signature',
        debug: {
          method: req.method,
          url: req.url,
          timestamp: ts,
          nonce: nonceStr,
          canonicalBody: canonical,
          expected: `sha256=${expected}`,
          received: `sha256=${sigMatch[1]}`
        }
      });
    }
    return reply.code(401).send({ error: 'invalid_signature' });
  }

  (req as any).merchantId = merchant.id;
});

app.get('/health', async () => ({ ok: true }));

app.post('/dev/sign', async (req: FastifyRequest, reply: FastifyReply) => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') return reply.code(404).send({ error: 'not_found' });
  const enabled = (process.env.DEV_SIGNING_ENABLED ?? 'false') === 'true';
  if (!enabled) return reply.code(404).send({ error: 'not_found' });

  const body = req.body as any;
  const publicKey = body?.publicKey ?? 'pk_demo_123';
  const method = String(body?.method ?? 'GET').toUpperCase();
  const path = String(body?.path ?? '/health');
  const requestBody = body?.body ?? null;

  const merchant = await getMerchantByPublicKey(publicKey);
  if (!merchant) return reply.code(404).send({ error: 'unknown_merchant' });

  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const sig = computeSignature({
    secret: merchant.secret_api_key,
    method,
    path,
    timestamp,
    nonce,
    body: canonicalBody(requestBody)
  });

  return reply.send({
    headers: {
      Authorization: `Bearer ${publicKey}`,
      'X-Request-Timestamp': timestamp,
      'X-Request-Nonce': nonce,
      'X-Signature': `sha256=${sig}`
    }
  });
});

async function proxy(req: FastifyRequest & { merchantId?: string }, reply: FastifyReply, upstreamBase: string, upstreamPath: string) {
  const url = new URL(upstreamPath, upstreamBase);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-merchant-id': req.merchantId ?? ''
  };

  const idempotencyKey = req.headers['idempotency-key'];
  if (idempotencyKey) headers['idempotency-key'] = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;

  const body = req.body ? JSON.stringify(req.body) : undefined;

  const upstreamRes = await undiciRequest(url, {
    method: req.method as any,
    headers,
    body
  });

  reply.code(upstreamRes.statusCode);
  const text = await upstreamRes.body.text();
  try {
    return reply.send(JSON.parse(text));
  } catch {
    return reply.send(text);
  }
}

app.post('/payment-intents', async (req, reply) => proxy(req, reply, PAYMENT_INTENT_SERVICE_URL, '/payment-intents'));
app.get('/payment-intents/:paymentIntentId', async (req, reply) => {
  const { paymentIntentId } = req.params as any;
  return proxy(req, reply, PAYMENT_INTENT_SERVICE_URL, `/payment-intents/${paymentIntentId}`);
});
app.post('/payment-intents/:paymentIntentId/transactions', async (req, reply) => {
  const { paymentIntentId } = req.params as any;
  return proxy(req, reply, TRANSACTION_SERVICE_URL, `/payment-intents/${paymentIntentId}/transactions`);
});

app.post('/webhook-subscriptions', async (req, reply) => proxy(req, reply, WEBHOOK_SERVICE_URL, '/webhook-subscriptions'));
app.get('/webhook-deliveries', async (req, reply) => {
  const qs = (req as any).raw?.url?.split('?')[1];
  const path = qs ? `/webhook-deliveries?${qs}` : '/webhook-deliveries';
  return proxy(req, reply, WEBHOOK_SERVICE_URL, path);
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
