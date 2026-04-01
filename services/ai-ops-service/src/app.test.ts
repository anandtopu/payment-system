import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mPool, mConsumer, mKafka } = vi.hoisted(() => {
  const mPool = { query: vi.fn() };
  const mConsumer = { connect: vi.fn(), subscribe: vi.fn(), run: vi.fn() };
  const mKafka = { consumer: vi.fn(function() { return mConsumer; }) };
  return { mPool, mConsumer, mKafka };
});

vi.mock('pg', () => {
  const Pool = vi.fn(function() { return mPool; });
  return { default: { Pool }, Pool };
});

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(function() { return mKafka; })
}));

import { app, startConsumer, generateReportOnce } from './app.js';

describe('AI Ops Service', () => {
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

  describe('GET /alerts', () => {
    it('returns alerts without status filter', async () => {
      mPool.query.mockResolvedValueOnce({
        rows: [{ id: 'a1', status: 'open', score: 90 }]
      });
      const res = await app.inject({ method: 'GET', url: '/alerts' });
      expect(res.statusCode).toBe(200);
      expect(res.json().alerts).toHaveLength(1);
    });

    it('returns alerts with status filter', async () => {
      mPool.query.mockResolvedValueOnce({
        rows: []
      });
      const res = await app.inject({ method: 'GET', url: '/alerts?status=closed' });
      expect(res.statusCode).toBe(200);
      expect(res.json().alerts).toHaveLength(0);
    });
  });

  describe('POST /alerts/:id/ack', () => {
    it('updates alert status to acknowledged', async () => {
      mPool.query.mockResolvedValueOnce({ rowCount: 1 });
      const res = await app.inject({ method: 'POST', url: '/alerts/a1/ack' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });

  describe('POST /alerts/:id/close', () => {
    it('updates alert status to closed', async () => {
      mPool.query.mockResolvedValueOnce({ rowCount: 1 });
      const res = await app.inject({ method: 'POST', url: '/alerts/a1/close' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });

  describe('GET /reports', () => {
    it('returns intelligence reports', async () => {
      mPool.query.mockResolvedValueOnce({
        rows: [{ id: 'r1', summary: 'test report' }]
      });
      const res = await app.inject({ method: 'GET', url: '/reports' });
      expect(res.statusCode).toBe(200);
      expect(res.json().reports).toHaveLength(1);
    });
  });

  describe('POST /reports/generate', () => {
    it('generates a report manually', async () => {
      // It makes 5 aggregates + 1 insert
      mPool.query.mockResolvedValueOnce({ rows: [{ succeeded: 10, failed: 1 }] });
      mPool.query.mockResolvedValueOnce({ rows: [{ timeout: 2 }] });
      mPool.query.mockResolvedValueOnce({ rows: [{ failed: 0 }] });
      mPool.query.mockResolvedValueOnce({ rows: [{ c: 0 }] });
      mPool.query.mockResolvedValueOnce({ rows: [] });
      mPool.query.mockResolvedValueOnce({ rowCount: 1 });

      const res = await app.inject({ method: 'POST', url: '/reports/generate' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });

  describe('Workers', () => {
    it('runs consumer and processes transaction messages', async () => {
      await startConsumer();
      const runCall = mConsumer.run.mock.calls[0][0];
      
      // We simulate transaction events
      mPool.query.mockResolvedValueOnce({ rows: [{ score: 0 }] }); // SELECT risk score
      mPool.query.mockResolvedValueOnce({}); // INSERT record (maybe failed)
      
      await expect(runCall.eachMessage({
        topic: 'payment-events',
        partition: 0,
        message: { value: Buffer.from(JSON.stringify({ type: 'transaction.timeout', data: { id: 'tx_123' } })) }
      })).resolves.not.toThrow();
    });
    it('generates report', async () => {
      mPool.query.mockResolvedValueOnce({ rows: [{ c: 10 }] }); // succeeded
      mPool.query.mockResolvedValueOnce({ rows: [{ c: 1 }] }); // failed
      mPool.query.mockResolvedValueOnce({ rows: [{ c: 2 }] }); // timeout
      mPool.query.mockResolvedValueOnce({ rows: [{ c: 5 }] }); // openAlerts
      mPool.query.mockResolvedValueOnce({ rows: [{ c: 3 }] }); // newAlerts
      mPool.query.mockResolvedValueOnce({ rowCount: 1 }); // INSERT report

      await expect(generateReportOnce()).resolves.not.toThrow();
    });
  });
});
