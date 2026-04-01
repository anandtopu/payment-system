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

describe('Transaction Service', () => {
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

  describe('POST /payment-intents/:id/transactions', () => {
    it('requires x-merchant-id header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents/pi_123/transactions',
        payload: { type: 'charge', card: { number: '1234' } }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'missing_merchant' });
    });

    it('requires valid type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents/pi_123/transactions',
        headers: { 'x-merchant-id': 'm1' },
         payload: { type: 'refund', card: { number: '1234' } }
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 if payment intent not found', async () => {
      mPool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents/pi_123/transactions',
        headers: { 'x-merchant-id': 'm1' },
        payload: { type: 'charge', card: { number: '1234' } }
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 if already succeeded', async () => {
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'pi_123', amount_in_cents: 1000, currency: 'USD', status: 'succeeded' }]
      });
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents/pi_123/transactions',
        headers: { 'x-merchant-id': 'm1' },
        payload: { type: 'charge', card: { number: '1234' } }
      });
      expect(res.statusCode).toBe(409);
    });

    it('succeeds transaction normally', async () => {
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'pi_123', amount_in_cents: 1000, currency: 'USD', status: 'created' }]
      }); // SELECT pi
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'tx_123', status: 'pending', created_at: '2023-01-01' }]
      }); // INSERT tx
      mPool.query.mockResolvedValueOnce({}); // UPDATE pi processing
      mPool.query.mockResolvedValueOnce({}); // UPDATE tx final
      mPool.query.mockResolvedValueOnce({}); // UPDATE pi final

      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents/pi_123/transactions',
        headers: { 'x-merchant-id': 'm1' },
        payload: { type: 'charge', card: { number: '1234123412341234' } }
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('succeeded');
    });

    it('fails transaction on insufficient funds', async () => {
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'pi_123', amount_in_cents: 1000, currency: 'USD', status: 'created' }]
      });
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'tx_123', status: 'pending', created_at: '2023-01-01' }]
      });
      mPool.query.mockResolvedValueOnce({});
      mPool.query.mockResolvedValueOnce({});
      mPool.query.mockResolvedValueOnce({});

      // 0000 ends trigger failure
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents/pi_123/transactions',
        headers: { 'x-merchant-id': 'm1' },
        payload: { type: 'charge', card: { number: '4111111111110000' } }
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('failed');
      expect(res.json().failureReason).toBe('insufficient_funds');
    });

    it('handles timeout simulation', async () => {
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'pi_123', amount_in_cents: 1000, currency: 'USD', status: 'created' }]
      });
      mPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'tx_123', status: 'pending', created_at: '2023-01-01' }]
      });
      mPool.query.mockResolvedValueOnce({});
      mPool.query.mockResolvedValueOnce({});

      // 9999 ends trigger timeout
      const res = await app.inject({
        method: 'POST',
        url: '/payment-intents/pi_123/transactions',
        headers: { 'x-merchant-id': 'm1' },
        payload: { type: 'charge', card: { number: '4111111111119999' } }
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('timeout');
      expect(res.json().failureReason).toBe('network_timeout');
    });
  });
});
