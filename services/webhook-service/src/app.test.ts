import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mPool, mConsumer, mKafka, mRequest } = vi.hoisted(() => {
  const mPool = { query: vi.fn() };
  const mConsumer = { connect: vi.fn(), subscribe: vi.fn(), run: vi.fn() };
  const mKafka = { consumer: vi.fn(function() { return mConsumer; }) };
  const mRequest = vi.fn();
  return { mPool, mConsumer, mKafka, mRequest };
});

vi.mock('pg', () => {
  const Pool = vi.fn(function() { return mPool; });
  return { default: { Pool }, Pool };
});

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(function() { return mKafka; })
}));

vi.mock('undici', () => ({
  request: mRequest
}));

import { app, startConsumer, startDeliveryWorker } from './app.js';

describe('Webhook Service', () => {
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

  describe('POST /webhook-subscriptions', () => {
    it('requires merchant header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhook-subscriptions',
        payload: { callbackUrl: 'http://cb', events: ['payment.succeeded'], secret: 'sec' }
      });
      expect(res.statusCode).toBe(401);
    });

    it('creates a subscription', async () => {
      mPool.query.mockResolvedValueOnce({ rows: [{ id: 'sub_1' }] });
      const res = await app.inject({
        method: 'POST',
        url: '/webhook-subscriptions',
        headers: { 'x-merchant-id': 'm1' },
        payload: { callbackUrl: 'http://cb', events: ['payment.succeeded'], secret: 'sec' }
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe('sub_1');
    });
  });

  describe('GET /webhook-deliveries', () => {
    it('requires merchant header', async () => {
      const res = await app.inject({ method: 'GET', url: '/webhook-deliveries' });
      expect(res.statusCode).toBe(401);
    });

    it('returns deliveries', async () => {
      mPool.query.mockResolvedValueOnce({
        rows: [{ id: 'del_1', event_type: 'payment.succeeded' }]
      });
      const res = await app.inject({
        method: 'GET',
        url: '/webhook-deliveries',
        headers: { 'x-merchant-id': 'm1' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().deliveries).toHaveLength(1);
    });
  });

  describe('Workers', () => {
    it('runs consumer and processes message', async () => {
      await startConsumer();
      const runCall = mConsumer.run.mock.calls[0][0];
      
      // Simulate successful payment intent message
      mPool.query.mockResolvedValueOnce({ rows: [{ id: 's_1', target_url: 'http://foo' }] }); // subscriptions
      mPool.query.mockResolvedValueOnce({}); // INSERT delivery
      
      await expect(runCall.eachMessage({
        topic: 'payment-events',
        partition: 0,
        message: { value: Buffer.from(JSON.stringify({ type: 'payment_intent.succeeded', data: { id: 'pi_123' } })) }
      })).resolves.not.toThrow();
    });
    it('runs delivery worker', async () => {
      // Provide one successful delivery
      mPool.query.mockResolvedValueOnce({
        rows: []
      });
      await expect(startDeliveryWorker()).resolves.not.toThrow();
    });
  });
});
