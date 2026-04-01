import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import pg from 'pg';
import { request as undiciRequest } from 'undici';
import { GoogleGenAI } from '@google/genai';

const { Pool } = pg;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

export const app = Fastify({ logger: true });
await app.register(formbody);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const AIOPS_URL = process.env.AIOPS_URL ?? 'http://localhost:6000';

function htmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchJson(url: string) {
  const res = await undiciRequest(url);
  const text = await res.body.text();
  return JSON.parse(text);
}

async function postJson(url: string) {
  const res = await undiciRequest(url, { method: 'POST' });
  const text = await res.body.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

app.get('/health', async () => ({ ok: true }));

app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
  const [alerts, reports] = await Promise.all([
    fetchJson(`${AIOPS_URL}/alerts?limit=10`),
    fetchJson(`${AIOPS_URL}/reports?limit=5`)
  ]);

  const body = `
  <html>
    <head>
      <title>Payment System Dashboard</title>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; color: #0f172a; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; background: #fff; }
        h1 { margin: 0 0 12px 0; font-size: 20px; }
        h2 { margin: 0 0 12px 0; font-size: 16px; }
        a { color: #2563eb; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .muted { color: #64748b; }
        table { width: 100%; border-collapse: collapse; }
        td, th { border-bottom: 1px solid #e2e8f0; padding: 8px; text-align: left; font-size: 13px; }
        .pill { padding: 2px 8px; border-radius: 999px; font-size: 12px; display: inline-block; }
        .pill.low { background: #dcfce7; color: #166534; }
        .pill.medium { background: #fef9c3; color: #854d0e; }
        .pill.high { background: #fee2e2; color: #991b1b; }
        .row { display: flex; gap: 10px; align-items: center; }
        input { padding: 10px; border: 1px solid #cbd5e1; border-radius: 10px; width: 320px; }
        button { padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; background: #0f172a; color: white; cursor: pointer; }
        button.secondary { background: white; color: #0f172a; }
      </style>
    </head>
    <body>
      <h1>Payment System Dashboard</h1>
      <div class="row muted">
        <div><a href="/flow">Flow explorer</a></div>
        <div><a href="/alerts">Alerts</a></div>
        <div><a href="/reports">Reports</a></div>
        <div><a href="/kpis">KPIs</a></div>
      </div>
      <div style="height: 12px"></div>

      <div class="grid">
        <div class="card">
          <h2>Recent fraud/ops alerts</h2>
          <table>
            <thead><tr><th>Severity</th><th>Type</th><th>Score</th><th>Created</th></tr></thead>
            <tbody>
              ${(alerts.alerts ?? [])
                .map((a: any) => {
                  const sev = String(a.severity);
                  return `<tr><td><span class="pill ${sev}">${sev}</span></td><td>${htmlEscape(String(a.type))}</td><td>${Number(a.score).toFixed(1)}</td><td class="muted">${htmlEscape(String(a.created_at))}</td></tr>`;
                })
                .join('')}
            </tbody>
          </table>
          <div class="muted" style="margin-top: 8px"><a href="/alerts">View all alerts</a></div>
        </div>

        <div class="card">
          <h2>Latest intelligence reports</h2>
          <table>
            <thead><tr><th>Type</th><th>Window</th><th>Created</th></tr></thead>
            <tbody>
              ${(reports.reports ?? [])
                .map((r: any) => {
                  return `<tr><td>${htmlEscape(String(r.report_type))}</td><td class="muted">${htmlEscape(String(r.window_start))} → ${htmlEscape(String(r.window_end))}</td><td class="muted">${htmlEscape(String(r.created_at))}</td></tr>`;
                })
                .join('')}
            </tbody>
          </table>
          <div class="muted" style="margin-top: 8px"><a href="/reports">View reports</a></div>
        </div>
      </div>
    </body>
  </html>`;

  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(body);
});

app.get('/kpis', async (_req: FastifyRequest, reply: FastifyReply) => {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 10 * 60_000);

  const [pi, tx, wh, alerts] = await Promise.all([
    pool.query(
      `SELECT status, COUNT(*)::int AS c
       FROM payment_intents
       WHERE updated_at >= $1 AND updated_at < $2
       GROUP BY status`,
      [windowStart.toISOString(), windowEnd.toISOString()]
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS c
       FROM transactions
       WHERE updated_at >= $1 AND updated_at < $2
       GROUP BY status`,
      [windowStart.toISOString(), windowEnd.toISOString()]
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS c
       FROM webhook_deliveries
       WHERE updated_at >= $1 AND updated_at < $2
       GROUP BY status`,
      [windowStart.toISOString(), windowEnd.toISOString()]
    ),
    fetchJson(`${AIOPS_URL}/alerts?status=open&limit=200`)
  ]);

  const fmt = (rows: any[]) => rows.map((r) => `<tr><td>${htmlEscape(String(r.status))}</td><td>${Number(r.c)}</td></tr>`).join('');

  const body = `
  <html><head><title>KPIs</title><meta charset="utf-8" />
  <style>body{font-family:ui-sans-serif,system-ui;margin:24px} .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px} .card{border:1px solid #e2e8f0;border-radius:12px;padding:16px} table{width:100%;border-collapse:collapse} td,th{border-bottom:1px solid #e2e8f0;padding:8px;text-align:left;font-size:13px}</style>
  </head><body>
  <h1>KPIs (last 10 minutes)</h1>
  <div><a href="/">Back</a></div>
  <div style="height: 12px"></div>
  <div class="grid">
    <div class="card"><h2>PaymentIntents</h2><table><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>${fmt(pi.rows)}</tbody></table></div>
    <div class="card"><h2>Transactions</h2><table><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>${fmt(tx.rows)}</tbody></table></div>
    <div class="card"><h2>Webhooks</h2><table><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>${fmt(wh.rows)}</tbody></table></div>
  </div>
  <div style="height: 16px"></div>
  <div class="card" style="max-width: 900px;">
    <h2>Open alerts</h2>
    <pre style="white-space:pre-wrap;">${htmlEscape(JSON.stringify((alerts.alerts ?? []).slice(0, 20), null, 2))}</pre>
  </div>
  </body></html>`;

  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(body);
});

app.get('/alerts', async (_req: FastifyRequest, reply: FastifyReply) => {
  const alerts = await fetchJson(`${AIOPS_URL}/alerts?limit=200`);
  const rows = alerts.alerts ?? [];
  const body = `
  <html><head><title>Alerts</title><meta charset="utf-8" />
  <style>
    body{font-family:ui-sans-serif,system-ui;margin:24px}
    .card{border:1px solid #e2e8f0;border-radius:12px;padding:16px}
    table{width:100%;border-collapse:collapse}
    td,th{border-bottom:1px solid #e2e8f0;padding:8px;text-align:left;font-size:13px;vertical-align:top}
    a{color:#2563eb;text-decoration:none}
    .pill{padding:2px 8px;border-radius:999px;font-size:12px;display:inline-block}
    .pill.low{background:#dcfce7;color:#166534}
    .pill.medium{background:#fef9c3;color:#854d0e}
    .pill.high{background:#fee2e2;color:#991b1b}
    button{padding:6px 10px;border:1px solid #cbd5e1;border-radius:10px;background:#0f172a;color:#fff;cursor:pointer}
    button.secondary{background:#fff;color:#0f172a}
    form{display:inline}
    .muted{color:#64748b}
  </style>
  </head><body>
  <h1>Alerts</h1><div><a href="/">Back</a></div><div style="height: 12px"></div>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Severity</th>
          <th>Status</th>
          <th>Type</th>
          <th>Score</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((a: any) => {
            const sev = String(a.severity);
            const st = String(a.status);
            const id = String(a.id);
            return `
              <tr>
                <td><span class="pill ${sev}">${htmlEscape(sev)}</span></td>
                <td class="muted">${htmlEscape(st)}</td>
                <td>${htmlEscape(String(a.type))}</td>
                <td>${Number(a.score).toFixed(1)}</td>
                <td class="muted">${htmlEscape(String(a.created_at))}</td>
                <td>
                  <form method="POST" action="/alerts/${id}/ack"><button class="secondary" type="submit">Ack</button></form>
                  <span style="display:inline-block;width:6px"></span>
                  <form method="POST" action="/alerts/${id}/close"><button type="submit">Close</button></form>
                </td>
              </tr>
            `;
          })
          .join('')}
      </tbody>
    </table>
  </div>
  </body></html>`;
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(body);
});

app.post('/alerts/:id/ack', async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as any;
  await postJson(`${AIOPS_URL}/alerts/${id}/ack`);
  return reply.redirect('/alerts');
});

app.post('/alerts/:id/close', async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as any;
  await postJson(`${AIOPS_URL}/alerts/${id}/close`);
  return reply.redirect('/alerts');
});

app.get('/reports', async (_req: FastifyRequest, reply: FastifyReply) => {
  const reports = await fetchJson(`${AIOPS_URL}/reports?limit=50`);
  const body = `
  <html><head><title>Reports</title><meta charset="utf-8" />
  <style>body{font-family:ui-sans-serif,system-ui;margin:24px} .card{border:1px solid #e2e8f0;border-radius:12px;padding:16px} a{color:#2563eb;text-decoration:none}</style>
  </head><body>
  <h1>Intelligence reports</h1><div><a href="/">Back</a></div><div style="height: 12px"></div>
  <div class="card"><pre style="white-space:pre-wrap;">${htmlEscape(JSON.stringify(reports.reports ?? [], null, 2))}</pre></div>
  </body></html>`;
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(body);
});

app.get('/flow', async (_req: FastifyRequest, reply: FastifyReply) => {
  const body = `
  <html><head><title>Flow explorer</title><meta charset="utf-8" />
  <style>body{font-family:ui-sans-serif,system-ui;margin:24px} input{padding:10px;border:1px solid #cbd5e1;border-radius:10px;width:360px} button{padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;background:#0f172a;color:#fff;cursor:pointer} .card{border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-top:12px}</style>
  </head><body>
  <h1>Flow explorer</h1><div><a href="/">Back</a></div>
  <div style="height: 12px"></div>
  <form method="GET" action="/flow/view">
    <input name="payment_intent_id" placeholder="payment_intent_id" />
    <button type="submit">View flow</button>
  </form>
  <div class="card">Enter a PaymentIntent ID to see joined records (intent + transactions + webhooks).</div>
  </body></html>`;
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(body);
});

app.get('/flow/view', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as any;
  const id = String(q?.payment_intent_id ?? '');
  if (!id) return reply.redirect('/flow');

  const [pi, tx, wh] = await Promise.all([
    pool.query(
      `SELECT id, merchant_id, amount_in_cents, currency, status, error_message, created_at, updated_at
       FROM payment_intents WHERE id = $1`,
      [id]
    ),
    pool.query(
      `SELECT id, status, failure_reason, created_at, updated_at
       FROM transactions WHERE payment_intent_id = $1 ORDER BY created_at ASC`,
      [id]
    ),
    pool.query(
      `SELECT id, event_type, status, attempt_count, next_attempt_at, last_error, last_status_code, created_at, updated_at
       FROM webhook_deliveries
       WHERE event_payload->>'id' = $1
       ORDER BY created_at ASC`,
      [id]
    )
  ]);

  const payload = {
    payment_intent: pi.rows[0] ?? null,
    transactions: tx.rows,
    webhook_deliveries: wh.rows
  };

  const body = `
  <html><head><title>Flow ${htmlEscape(id)}</title><meta charset="utf-8" />
  <style>
    body{font-family:ui-sans-serif,system-ui;margin:24px} 
    .card{border:1px solid #e2e8f0;border-radius:12px;padding:16px} 
    pre{white-space:pre-wrap}
    .chat-box { border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px; margin-top: 16px; background: #f8fafc; }
    input.chat-input { padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; width: 400px; }
    button { padding: 10px 16px; background: #0f172a; color: white; border: none; border-radius: 8px; cursor: pointer; }
    .chat-msg { background: #e2e8f0; padding: 10px; border-radius: 8px; margin-bottom: 8px; }
    .ai-msg { background: #dbeafe; }
  </style>
  </head><body>
  <h1>Flow view</h1>
  <div><a href="/flow">Back</a></div>
  <div style="height: 12px"></div>
  
  <div class="chat-box">
    <h2>Agentic Support Debugger</h2>
    <div id="chat-log"></div>
    <form id="chat-form" style="margin-top: 12px; display: flex; gap: 8px;">
      <input class="chat-input" id="chat-input" placeholder="e.g., Why did this transaction fail?" required />
      <button type="submit" id="chat-btn">Ask AI</button>
    </form>
    <script>
      const form = document.getElementById('chat-form');
      const input = document.getElementById('chat-input');
      const btn = document.getElementById('chat-btn');
      const log = document.getElementById('chat-log');
      
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = input.value;
        if(!q) return;
        
        log.innerHTML += '<div class="chat-msg"><b>You:</b> ' + q + '</div>';
        input.value = '';
        btn.disabled = true;
        btn.textContent = 'Thinking...';
        
        try {
          const res = await fetch('/flow/debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: q, payment_intent_id: '${id}' })
          });
          const data = await res.json();
          log.innerHTML += '<div class="chat-msg ai-msg"><b>AI:</b> ' + data.answer + '</div>';
        } catch(err) {
          log.innerHTML += '<div class="chat-msg" style="color:red"><b>Error:</b> ' + err.message + '</div>';
        }
        
        btn.disabled = false;
        btn.textContent = 'Ask AI';
      });
    </script>
  </div>

  <div class="card" style="margin-top: 24px;"><pre>${htmlEscape(JSON.stringify(payload, null, 2))}</pre></div>
  </body></html>`;

  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(body);
});

app.post('/flow/debug', async (req: FastifyRequest, reply: FastifyReply) => {
  const { question, payment_intent_id } = req.body as any;
  if (!ai) {
    return reply.send({ answer: "Agentic features are currently disabled. (GEMINI_API_KEY missing)" });
  }

  try {
    const [pi, tx, wh] = await Promise.all([
      pool.query(
        'SELECT id, amount_in_cents, currency, status, error_message, updated_at FROM payment_intents WHERE id = $1',
        [payment_intent_id]
      ),
      pool.query(
        'SELECT status, failure_reason, created_at, updated_at FROM transactions WHERE payment_intent_id = $1 ORDER BY created_at ASC',
        [payment_intent_id]
      ),
      pool.query(
        "SELECT event_type, status, last_error, last_status_code, updated_at FROM webhook_deliveries WHERE event_payload->>'id' = $1",
        [payment_intent_id]
      )
    ]);

    const context = JSON.stringify({
      payment_intent: pi.rows[0],
      transactions: tx.rows,
      webhooks: wh.rows
    });

    const prompt = `You are an expert payment debugger agent. You help engineers and merchants figure out why a payment failed or timed out.
The user is asking: "${question}"
Here is the raw database joined state for payment_intent_id ${payment_intent_id}:
${context}

Explain what happened in a short, conversational, easy-to-understand 2-3 sentence response. DO NOT mention that you are an AI, or raw JSON keys. Just act as a senior engineer diagnosing the database row states.`;

    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });

    return reply.send({ answer: res.text });
  } catch (err: any) {
    app.log.error(err, 'llm_chat_fail');
    return reply.send({ answer: "I'm sorry, I encountered an error pulling data or contacting my brain." });
  }
});



