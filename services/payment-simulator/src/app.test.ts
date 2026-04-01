import { describe, it, expect, vi, beforeEach } from 'vitest';

const mResponse = {
  statusCode: 200,
  body: {
    text: vi.fn().mockResolvedValue('{"status":"succeeded","id":"123","headers":{"sig":"123"}}')
  }
};
vi.mock('undici', () => ({
  request: vi.fn(() => Promise.resolve(mResponse))
}));

import { main } from './app.js';

describe('Payment Simulator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SIM_TOTAL = '2';
    process.env.SIM_CONCURRENCY = '1';
  });

  it('runs simulation successfully', async () => {
    mResponse.statusCode = 200;
    
    // sign endpoint
    mResponse.body.text
      .mockResolvedValueOnce('{"headers":{"Authorization":"Bearer ok"}}') // sign PI
      .mockResolvedValueOnce('{"status":"created","id":"pi_1"}') // create PI
      .mockResolvedValueOnce('{"headers":{"Authorization":"Bearer ok"}}') // sign TX
      .mockResolvedValueOnce('{"status":"succeeded"}') // create TX
      .mockResolvedValueOnce('{"headers":{"Authorization":"Bearer ok"}}') // sign PI 2
      .mockResolvedValueOnce('{"status":"created","id":"pi_2"}') // create PI 2
      .mockResolvedValueOnce('{"headers":{"Authorization":"Bearer ok"}}') // sign TX 2
      .mockResolvedValueOnce('{"status":"timeout","failureReason":"network_timeout"}'); // create TX 2
      
    await expect(main()).resolves.not.toThrow();
  });

  it('handles errors gracefully in worker', async () => {
    process.env.SIM_TOTAL = '1';
    mResponse.body.text
      .mockResolvedValueOnce('{"headers":{"Authorization":"Bearer ok"}}')
      .mockResolvedValueOnce('{"status":"failed_creation"}');
    
    mResponse.statusCode = 500;
    
    // worker catches the error and logs it, so main shouldn't throw.
    await expect(main()).resolves.not.toThrow();
  });
});
