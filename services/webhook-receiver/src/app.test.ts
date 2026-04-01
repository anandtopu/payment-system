import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from './app.js';

describe('Webhook Receiver Service', () => {
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

  describe('POST /webhooks', () => {
    it('processes webhook and succeeds', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks',
        headers: {
          'x-webhook-signature': 'sig123'
        },
        payload: {
          event: 'payment.succeeded'
        }
      });
      // because FAIL_FIRST_N is default 0, the first request succeeds!
      expect(res.statusCode).toBe(204);
    });
  });
});
