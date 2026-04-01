import { request as undiciRequest } from 'undici';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const MERCHANT_PUBLIC_KEY = process.env.MERCHANT_PUBLIC_KEY ?? 'pk_demo_123';

const total = Number(process.env.SIM_TOTAL ?? 50);
const concurrency = Math.max(1, Number(process.env.SIM_CONCURRENCY ?? 5));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function jsonRequest(url: string, init: { method: string; headers?: Record<string, string>; body?: any }) {
  const res = await undiciRequest(url, {
    method: init.method as any,
    headers: { ...(init.headers ?? {}), 'content-type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const text = await res.body.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.statusCode, data };
}

async function sign(method: string, path: string, body: any) {
  const { status, data } = await jsonRequest(`${GATEWAY_URL}/dev/sign`, {
    method: 'POST',
    body: { publicKey: MERCHANT_PUBLIC_KEY, method, path, body }
  });
  if (status !== 200) throw new Error(`dev_sign_failed status=${status} body=${JSON.stringify(data)}`);
  return data.headers as Record<string, string>;
}

async function callGateway(method: string, path: string, body: any) {
  const headers = await sign(method, path, body);
  const res = await jsonRequest(`${GATEWAY_URL}${path}`, { method, headers, body });
  return res;
}

function pickCard(i: number): string {
  // Mix outcomes:
  // - succeeds: random
  // - fails: ends with 0000
  // - timeout: ends with 9999 (reconciliation will later fail the PI)
  const mod = i % 10;
  if (mod === 0) return '4242424242420000';
  if (mod === 1) return '4242424242429999';
  return '4242424242424242';
}

async function runOne(i: number) {
  const idem = `sim-${Date.now()}-${i}`;
  const piBody = { amountInCents: 1000 + (i % 7) * 100, currency: 'USD', description: `sim-${i}` };

  const piRes = await callGateway('POST', '/payment-intents', piBody);
  if (piRes.status !== 201 && piRes.status !== 200) {
    throw new Error(`create_pi_failed status=${piRes.status} body=${JSON.stringify(piRes.data)}`);
  }

  const paymentIntentId = piRes.data?.id;
  if (!paymentIntentId) throw new Error('missing_payment_intent_id');

  const txBody = { type: 'charge', card: { number: pickCard(i) } };
  const txRes = await callGateway('POST', `/payment-intents/${paymentIntentId}/transactions`, txBody);

  return {
    i,
    paymentIntentId,
    piStatus: piRes.data?.status,
    txStatus: txRes.data?.status,
    txFailureReason: txRes.data?.failureReason ?? null
  };
}

async function worker(workerId: number, idxs: number[], out: any[]) {
  for (const i of idxs) {
    try {
      const r = await runOne(i);
      out.push(r);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ level: 'info', msg: 'sim_payment_done', workerId, ...r }));
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', msg: 'sim_payment_error', workerId, i, err: e?.message ?? String(e) }));
    }
    await sleep(100);
  }
}

export async function main() {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'sim_start', total, concurrency, gateway: GATEWAY_URL }));

  const items = Array.from({ length: total }, (_, i) => i);
  const buckets: number[][] = Array.from({ length: concurrency }, () => []);
  for (let i = 0; i < items.length; i++) buckets[i % concurrency].push(items[i]);

  const out: any[] = [];
  await Promise.all(buckets.map((b, idx) => worker(idx, b, out)));

  const byTx = out.reduce(
    (acc, r) => {
      const k = String(r.txStatus ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'sim_done', byTx }));
}
