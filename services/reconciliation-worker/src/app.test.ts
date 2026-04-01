import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mPool, mockClient } = vi.hoisted(() => {
  const mockClient = { query: vi.fn(), release: vi.fn() };
  const mPool = { query: vi.fn(), connect: vi.fn(() => mockClient) };
  return { mPool, mockClient };
});

vi.mock('pg', () => {
  const Pool = vi.fn(function() { return mPool; });
  return { default: { Pool }, Pool };
});

import { main } from './app.js';

describe('Reconciliation Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs reconciliation manually', async () => {
    // We mock pool.query for the initial fetch to return items, then we exit by making setInterval/while loop stop or just testing logic by allowing one pass if we throw error.
    // Instead of letting it loop forever, we can just reject the second `pool.query` in while loop to break out, or we can use fakeTimers and just let the test timeout handle it?
    // Wait, the while loop will block forever. Let's make `pool.query` throw an error to break it or just use setTimeout with fakeTimers... wait, error is caught, it loops!
    // Since `reconcileOnce` is not exported, we must test via `main()`. We can break the while(true) by mocking `global.setTimeout` to throw!
    
    vi.stubGlobal('setTimeout', () => { throw new Error('break'); });
    
    mPool.query.mockResolvedValueOnce({
      rows: [{ id: 'tx_1', payment_intent_id: 'pi_1' }]
    });
    
    // updatedTx query
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ payment_intent_id: 'pi_1' }] }) // UPDATE tx
      .mockResolvedValueOnce({}) // UPDATE pi
      .mockResolvedValueOnce({}); // COMMIT
      
    await expect(main()).rejects.toThrow('break');
    
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    vi.unstubAllGlobals();
  });
});
