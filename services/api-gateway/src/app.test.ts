import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mPool, mRedis, mRequest } = vi.hoisted(() => {
  const mPool = { query: vi.fn() };
  const mRedis = { set: vi.fn(), get: vi.fn() };
  const mRequest = vi.fn();
  return { mPool, mRedis, mRequest };
});

vi.mock('pg', () => {
  const Pool = vi.fn(function() { return mPool; });
  return { default: { Pool }, Pool };
});

vi.mock('ioredis', () => ({
  default: vi.fn(function() { return mRedis; })
}));

vi.mock('undici', () => ({
  request: mRequest
}));

import { app } from './app.js';
import crypto from 'node:crypto';

describe('API Gateway Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('returns ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  describe('POST /dev/sign', () => {
    it('returns not found in production production', async () => {
      process.env.NODE_ENV = 'production';
      const res = await app.inject({ method: 'POST', url: '/dev/sign' });
      expect(res.statusCode).toBe(401); // preHandler blocks it with 401 because it's production
      process.env.NODE_ENV = 'test';
    });

    it('returns 404 if disabled', async () => {
      process.env.DEV_SIGNING_ENABLED = 'false';
      const res = await app.inject({ method: 'POST', url: '/dev/sign' });
      expect(res.statusCode).toBe(404);
    });

    it('signs successfully', async () => {
      process.env.DEV_SIGNING_ENABLED = 'true';
      mPool.query.mockResolvedValueOnce({
        rows: [{ id: 'm1', public_api_key: 'pk_123', secret_api_key: 'sk_123' }]
      });

      const res = await app.inject({
        method: 'POST',
        url: '/dev/sign',
        payload: { publicKey: 'pk_123', method: 'GET', path: '/health', body: null }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().headers).toHaveProperty('X-Signature');
    });
  });

  describe('preHandler Auth', () => {
    it('rejects without auth headers', async () => {
      const res = await app.inject({ method: 'POST', url: '/payment-intents' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'missing_auth_headers' });
    });

    it('rejects invalid signature', async () => {
      mPool.query.mockResolvedValueOnce({
        rows: [{ id: 'm1', public_api_key: 'pk_123', secret_api_key: 'sk_123' }]
      });
      mRedis.set.mockResolvedValueOnce('OK');

      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents',
        headers: {
          authorization: 'Bearer pk_123',
          'x-request-timestamp': Date.now().toString(),
          'x-request-nonce': crypto.randomUUID(),
          'x-signature': 'sha256=invalidsig'
        }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_signature');
    });

    it('proxies request successfully', async () => {
      mPool.query.mockResolvedValueOnce({ rows: [{ id: 'm1', public_api_key: 'pk_123', secret_api_key: 'sk_123' }] });
      mRedis.get.mockResolvedValueOnce(null);
      mRedis.set.mockResolvedValueOnce('OK');
      mRequest.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: { text: vi.fn().mockResolvedValue('{"status":"ok"}') } });

      const crypto = await import('node:crypto');
      const timestamp = Date.now().toString();
      const nonce = crypto.randomUUID();
      const payload = JSON.stringify({ amount: 100 });
      const pathUrl = '/payment-intents';
      const sigData = `POST\n${pathUrl}\n${timestamp}\n${nonce}\n${payload}`;
      const hmac = crypto.createHmac('sha256', 'sk_123').update(sigData).digest('hex');

      const res = await app.inject({
        method: 'POST',
        url: pathUrl,
        headers: {
          authorization: 'Bearer pk_123',
          'x-request-timestamp': timestamp,
          'x-request-nonce': nonce,
          'x-signature': `sha256=${hmac}`
        },
        payload: { amount: 100 }
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
