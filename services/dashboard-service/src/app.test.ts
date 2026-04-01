import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mPool, mRequest } = vi.hoisted(() => {
  const mPool = { query: vi.fn() };
  const mRequest = vi.fn();
  return { mPool, mRequest };
});

vi.mock('pg', () => {
  const Pool = vi.fn(function() { return mPool; });
  return { default: { Pool }, Pool };
});

vi.mock('undici', () => ({
  request: mRequest
}));

import { app } from './app.js';

describe('Dashboard Service', () => {
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

  describe('GET /', () => {
    it('renders dashboard HTML', async () => {
      mRequest.mockResolvedValueOnce({ body: { text: vi.fn().mockResolvedValue('{"alerts":[]}') } }); // /alerts
      mRequest.mockResolvedValueOnce({ body: { text: vi.fn().mockResolvedValue('{"reports":[]}') } }); // /reports

      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Payment System Dashboard');
    });
  });

  describe('GET /kpis', () => {
    it('renders KPIs HTML', async () => {
      mPool.query.mockResolvedValueOnce({ rows: [] }); // PI
      mPool.query.mockResolvedValueOnce({ rows: [] }); // TX
      mPool.query.mockResolvedValueOnce({ rows: [] }); // WH
      mRequest.mockResolvedValueOnce({ body: { text: vi.fn().mockResolvedValue('{"alerts":[]}') } });

      const res = await app.inject({ method: 'GET', url: '/kpis' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('KPIs');
    });
  });

  describe('GET /alerts', () => {
    it('renders Alerts list HTML', async () => {
      mRequest.mockResolvedValueOnce({ body: { text: vi.fn().mockResolvedValue('{"alerts":[]}') } });
      const res = await app.inject({ method: 'GET', url: '/alerts' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Alerts');
    });
  });

  describe('POST /alerts/:id/ack', () => {
    it('acks alert and redirects', async () => {
      mRequest.mockResolvedValueOnce({ body: { text: vi.fn().mockResolvedValue('{"ok":true}') } });
      const res = await app.inject({ method: 'POST', url: '/alerts/123/ack' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/alerts');
    });
  });

  describe('POST /alerts/:id/close', () => {
    it('closes alert and redirects', async () => {
      mRequest.mockResolvedValueOnce({ body: { text: vi.fn().mockResolvedValue('{"ok":true}') } });
      const res = await app.inject({ method: 'POST', url: '/alerts/123/close' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/alerts');
    });
  });

  describe('GET /reports', () => {
    it('renders Reports HTML', async () => {
      mRequest.mockResolvedValueOnce({ body: { text: vi.fn().mockResolvedValue('{"reports":[]}') } });
      const res = await app.inject({ method: 'GET', url: '/reports' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Intelligence reports');
    });
  });

  describe('GET /flow', () => {
    it('renders flow explorer form', async () => {
      const res = await app.inject({ method: 'GET', url: '/flow' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Flow explorer');
    });
  });

  describe('GET /flow/view', () => {
    it('redirects if missing id', async () => {
      const res = await app.inject({ method: 'GET', url: '/flow/view' });
      expect(res.statusCode).toBe(302);
    });

    it('renders flow given an id', async () => {
      mPool.query.mockResolvedValueOnce({ rows: [{ id: 'pi_123' }] }); // PI
      mPool.query.mockResolvedValueOnce({ rows: [{ id: 'tx_123' }] }); // TX
      mPool.query.mockResolvedValueOnce({ rows: [{ id: 'wh_123' }] }); // Webhook

      const res = await app.inject({ method: 'GET', url: '/flow/view?payment_intent_id=pi_123' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('pi_123');
    });
  });
});
