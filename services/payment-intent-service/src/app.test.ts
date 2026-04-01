import { describe, it, expect, vi, beforeEach } from 'vitest';
import pg from 'pg';

const { mPool } = vi.hoisted(() => ({
  mPool: { query: vi.fn() }
}));

vi.mock('pg', () => {
  const Pool = vi.fn(function() { return mPool; });
  return { default: { Pool }, Pool };
});


import { app } from './app.js';

describe('Payment Intent Service', () => {
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

  describe('POST /payment-intents', () => {
    it('requires x-merchant-id header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents',
        payload: { amountInCents: 1000, currency: 'USD' }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'missing_merchant' });
    });

    it('requires valid amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents',
        headers: { 'x-merchant-id': 'm1' },
        payload: { amountInCents: -100, currency: 'USD' }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_amount' });
    });

    it('requires valid currency', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents',
        headers: { 'x-merchant-id': 'm1' },
        payload: { amountInCents: 1000 }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_currency' });
    });

    it('creates a payment intent without idempotency key', async () => {
      mPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'pi_123',
          amount_in_cents: '1000',
          currency: 'USD',
          description: null,
          status: 'created',
          created_at: '2023-01-01T00:00:00.000Z'
        }],
        rowCount: 1
      });

      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents',
        headers: { 'x-merchant-id': 'm1' },
        payload: { amountInCents: 1000, currency: 'USD' }
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: 'pi_123',
        amountInCents: 1000,
        currency: 'USD',
        description: null,
        status: 'created',
        createdAt: '2023-01-01T00:00:00.000Z'
      });
      expect(mPool.query).toHaveBeenCalledTimes(1);
    });

    it('returns existing response with idempotency key', async () => {
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ response_body: { id: 'pi_idem', status: 'created' } }]
      });

      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents',
        headers: { 'x-merchant-id': 'm1', 'idempotency-key': 'key1' },
        payload: { amountInCents: 1000, currency: 'USD' }
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe('pi_idem');
      expect(mPool.query).toHaveBeenCalledTimes(1); // SELECT
    });

    it('creates new response with idempotency key and saves it', async () => {
      // 1. SELECT returns nothing
      mPool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // 2. INSERT into payment_intents
      mPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'pi_new_idem',
          amount_in_cents: '2000',
          currency: 'EUR',
          description: 'test',
          status: 'created',
          created_at: '2023-01-01T00:00:00.000Z'
        }],
        rowCount: 1
      });
      // 3. INSERT into idempotency_keys
      mPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents',
        headers: { 'x-merchant-id': 'm1', 'idempotency-key': 'key2' },
        payload: { amountInCents: 2000, currency: 'EUR', description: 'test' }
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe('pi_new_idem');
      expect(mPool.query).toHaveBeenCalledTimes(3);
    });
  });

  describe('GET /payment-intents/:id', () => {
    it('requires merchant header', async () => {
      const res = await app.inject({ method: 'GET', url: '/payment-intents/pi_123' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 if not found', async () => {
      mPool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      const res = await app.inject({ method: 'GET', url: '/payment-intents/pi_123', headers: { 'x-merchant-id': 'm1' } });
      expect(res.statusCode).toBe(404);
    });

    it('returns payment intent', async () => {
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'pi_123',
          amount_in_cents: '1000',
          currency: 'USD',
          description: null,
          status: 'created',
          error_message: null,
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z'
        }]
      });
      const res = await app.inject({ method: 'GET', url: '/payment-intents/pi_123', headers: { 'x-merchant-id': 'm1' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe('pi_123');
    });
  });
});
