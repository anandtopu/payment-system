import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { Kafka } from 'kafkajs';
import { GoogleGenAI } from '@google/genai';

const { Pool } = pg;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

type MerchantWindow = {
  windowStartMs: number;
  paymentSucceeded: number;
  paymentFailed: number;
  paymentCreated: number;
  txTimeout: number;
  txFailed: number;
  txSucceeded: number;
  webhookFailed: number;
  webhookSucceeded: number;
};

type RiskSnapshot = {
  merchantId: string;
  score: number;
  severity: 'low' | 'medium' | 'high';
  factors: Record<string, any>;
};

export const app = Fastify({ logger: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const kafka = new Kafka({ clientId: 'ai-ops-service', brokers: kafkaBrokers });

const nodeEnv = process.env.NODE_ENV ?? 'development';
const groupId =
  process.env.KAFKA_CONSUMER_GROUP_ID ?? (nodeEnv === 'production' ? 'ai-ops-service' : `ai-ops-service-${crypto.randomUUID()}`);

const windowMs = Number(process.env.AIOPS_WINDOW_MS ?? 60_000);
const reportEveryMs = Number(process.env.AIOPS_REPORT_EVERY_MS ?? 60_000);

const perMerchant = new Map<string, MerchantWindow>();

function nowMs() {
  return Date.now();
}

function getWindow(merchantId: string): MerchantWindow {
  const existing = perMerchant.get(merchantId);
  const now = nowMs();
  if (!existing || now - existing.windowStartMs > windowMs) {
    const w: MerchantWindow = {
      windowStartMs: now,
      paymentSucceeded: 0,
      paymentFailed: 0,
      paymentCreated: 0,
      txTimeout: 0,
      txFailed: 0,
      txSucceeded: 0,
      webhookFailed: 0,
      webhookSucceeded: 0
    };
    perMerchant.set(merchantId, w);
    return w;
  }
  return existing;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function computeRisk(merchantId: string, w: MerchantWindow): RiskSnapshot {
  const totalPayments = w.paymentSucceeded + w.paymentFailed;
  const failRate = totalPayments > 0 ? w.paymentFailed / totalPayments : 0;
  const timeoutRate = (w.txSucceeded + w.txFailed + w.txTimeout) > 0 ? w.txTimeout / (w.txSucceeded + w.txFailed + w.txTimeout) : 0;
  const webhookFailRate = (w.webhookSucceeded + w.webhookFailed) > 0 ? w.webhookFailed / (w.webhookSucceeded + w.webhookFailed) : 0;

  const velocity = w.paymentCreated / Math.max(1, windowMs / 1000);

  // Demo-friendly, interpretable score: 0..100.
  // We weight failure/timeout more heavily and include a velocity component so a small simulation can create alerts.
  const score = clamp(100 * (0.65 * failRate + 0.25 * timeoutRate + 0.1 * webhookFailRate) + clamp(velocity * 20, 0, 30), 0, 100);

  let severity: RiskSnapshot['severity'] = 'low';
  if (score >= 45) severity = 'high';
  else if (score >= 20) severity = 'medium';

  return {
    merchantId,
    score,
    severity,
    factors: {
      totalPayments,
      failRate,
      timeoutRate,
      webhookFailRate,
      velocity,
      paymentCreated: w.paymentCreated,
      windowStartMs: w.windowStartMs
    }
  };
}

async function maybeEmitAlert(snapshot: RiskSnapshot) {
  if (snapshot.severity === 'low') return;

  app.log.info(
    { merchantId: snapshot.merchantId, severity: snapshot.severity, score: snapshot.score, factors: snapshot.factors },
    'alert_candidate'
  );

  // Dedupe: don’t spam alerts. Only one open alert per merchant+type per 5 minutes.
  const res = await pool.query(
    `SELECT id
     FROM fraud_alerts
     WHERE merchant_id = $1
       AND type = $2
       AND status = 'open'
       AND created_at >= now() - interval '5 minutes'
     ORDER BY created_at DESC
     LIMIT 1`,
    [snapshot.merchantId, 'merchant_risk']
  );
  if (res.rowCount) return;

  let agentReasoning = '';
  if (ai) {
    try {
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `You are an AI Fraud Agent evaluating merchant ${snapshot.merchantId}.
The heuristic risk score is ${snapshot.score}. Factors: ${JSON.stringify(snapshot.factors)}.
Please write a concise 2-sentence autonomous triage report detailing the probable root cause of this anomaly.`
      });
      if (res.text) agentReasoning = res.text;
    } catch (err: any) {
      app.log.error({ err: err.message }, 'llm_alert_generation_failed');
    }
  }

  await pool.query(
    `INSERT INTO fraud_alerts (merchant_id, severity, type, score, evidence)
     VALUES ($1,$2,$3,$4,$5)`,
    [snapshot.merchantId, snapshot.severity, 'merchant_risk', snapshot.score, { ...snapshot.factors, agentReasoning }]
  );

  app.log.warn({ merchantId: snapshot.merchantId, score: snapshot.score, severity: snapshot.severity }, 'fraud_alert_created');
}

function summarizeTemplate(params: {
  windowStart: Date;
  windowEnd: Date;
  totals: {
    paymentsSucceeded: number;
    paymentsFailed: number;
    txTimeout: number;
    webhookFailed: number;
    openAlerts: number;
  };
  topMerchants: Array<{ merchant_id: string; alerts: number }>; 
}) {
  const durationSec = Math.round((params.windowEnd.getTime() - params.windowStart.getTime()) / 1000);
  return (
    `Intelligence report (mock) for last ${durationSec}s\n` +
    `Window: ${params.windowStart.toISOString()} -> ${params.windowEnd.toISOString()}\n` +
    `Payments succeeded: ${params.totals.paymentsSucceeded}\n` +
    `Payments failed: ${params.totals.paymentsFailed}\n` +
    `Transactions timeout: ${params.totals.txTimeout}\n` +
    `Webhook failed: ${params.totals.webhookFailed}\n` +
    `Open alerts: ${params.totals.openAlerts}\n` +
    `Top merchants by alerts: ${params.topMerchants.map((m) => `${m.merchant_id.slice(0, 8)}(${m.alerts})`).join(', ') || 'none'}`
  );
}

async function generateReportOnce() {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 5 * 60_000);

  const [piAgg, txAgg, whAgg, openAlerts, topMerchants] = await Promise.all([
    pool.query(
      `SELECT
         SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END)::int AS succeeded,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failed
       FROM payment_intents
       WHERE updated_at >= $1 AND updated_at < $2`,
      [windowStart.toISOString(), windowEnd.toISOString()]
    ),
    pool.query(
      `SELECT
         SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END)::int AS timeout
       FROM transactions
       WHERE updated_at >= $1 AND updated_at < $2`,
      [windowStart.toISOString(), windowEnd.toISOString()]
    ),
    pool.query(
      `SELECT
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failed
       FROM webhook_deliveries
       WHERE updated_at >= $1 AND updated_at < $2`,
      [windowStart.toISOString(), windowEnd.toISOString()]
    ),
    pool.query(`SELECT COUNT(*)::int AS c FROM fraud_alerts WHERE status = 'open'`),
    pool.query(
      `SELECT merchant_id, COUNT(*)::int AS alerts
       FROM fraud_alerts
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY merchant_id
       ORDER BY alerts DESC
       LIMIT 5`,
      [windowStart.toISOString(), windowEnd.toISOString()]
    )
  ]);

  const totals = {
    paymentsSucceeded: Number(piAgg.rows[0]?.succeeded ?? 0),
    paymentsFailed: Number(piAgg.rows[0]?.failed ?? 0),
    txTimeout: Number(txAgg.rows[0]?.timeout ?? 0),
    webhookFailed: Number(whAgg.rows[0]?.failed ?? 0),
    openAlerts: Number(openAlerts.rows[0]?.c ?? 0)
  };

  let summary = summarizeTemplate({
    windowStart,
    windowEnd,
    totals,
    topMerchants: topMerchants.rows as any
  });

  let details: any = {
    totals,
    topMerchants: topMerchants.rows
  };

  if (ai) {
    try {
      const prompt = `You are an AI Ops Agent for a critical payment gateway.
Write a high-level executive intelligence report analyzing the system health over the last 5 minutes.
Raw system data summary: \n${summary}\n
Provide actionable insights and highlight any worrying trends in a professional operational tone.`;
      
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });

      if (res.text) {
        summary = res.text;
        details.agent_driven = true;
      }
    } catch (err: any) {
      app.log.error({ err: err.message }, 'llm_report_generation_failed');
    }
  }

  await pool.query(
    `INSERT INTO intelligence_reports (merchant_id, report_type, window_start, window_end, summary, details)
     VALUES (NULL, $1, $2, $3, $4, $5)`,
    [
      'system_ops',
      windowStart.toISOString(),
      windowEnd.toISOString(),
      summary,
      {
        totals,
        topMerchants: topMerchants.rows
      }
    ]
  );

  app.log.info({ totals }, 'intelligence_report_created');
}

function extractAfter(evt: any): { after: any; op: 'c' | 'u' | 'r' } | null {
  const payload = evt?.payload ?? evt;
  const after = payload?.after;
  const op = payload?.op;
  if (!after || (op !== 'c' && op !== 'u' && op !== 'r')) return null;
  return { after, op };
}

async function startConsumer() {
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();

  const topics = (process.env.AIOPS_TOPICS ?? 'paymentdb.public.payment_intents,paymentdb.public.transactions,paymentdb.public.webhook_deliveries')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

  for (const t of topics) {
    await consumer.subscribe({ topic: t, fromBeginning: nodeEnv !== 'production' });
  }

  await consumer.run({
    eachMessage: async ({ topic, message }: { topic: string; message: { value: Buffer | null } }) => {
      if (!message.value) return;
      const evt = JSON.parse(message.value.toString('utf8'));
      const extracted = extractAfter(evt);
      if (!extracted) return;
      const { after, op } = extracted;

      const merchantId = after.merchant_id;
      if (!merchantId) return;
      const w = getWindow(merchantId);

      if (topic.endsWith('payment_intents')) {
        if (op === 'c') w.paymentCreated++;
        if (after.status === 'succeeded') w.paymentSucceeded++;
        if (after.status === 'failed') w.paymentFailed++;
      } else if (topic.endsWith('transactions')) {
        if (after.status === 'timeout') w.txTimeout++;
        if (after.status === 'failed') w.txFailed++;
        if (after.status === 'succeeded') w.txSucceeded++;
      } else if (topic.endsWith('webhook_deliveries')) {
        if (after.status === 'failed') w.webhookFailed++;
        if (after.status === 'succeeded') w.webhookSucceeded++;
      }

      const snapshot = computeRisk(merchantId, w);
      await maybeEmitAlert(snapshot);

      app.log.debug({ merchantId, score: snapshot.score, severity: snapshot.severity }, 'risk_snapshot');
    }
  });
}

app.get('/health', async () => ({ ok: true }));

app.get('/alerts', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as any;
  const limit = Math.min(Number(q?.limit ?? 50), 200);
  const status = q?.status as string | undefined;

  const args: any[] = [];
  let where = '';
  if (status) {
    args.push(status);
    where = `WHERE status = $${args.length}`;
  }

  args.push(limit);
  const res = await pool.query(
    `SELECT id, merchant_id, severity, type, score, status, evidence, created_at, updated_at
     FROM fraud_alerts
     ${where}
     ORDER BY created_at DESC
     LIMIT $${args.length}`,
    args
  );

  return reply.send({ alerts: res.rows });
});

app.post('/alerts/:id/ack', async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as any;
  await pool.query(`UPDATE fraud_alerts SET status = 'acknowledged' WHERE id = $1`, [id]);
  return reply.send({ ok: true });
});

app.post('/alerts/:id/close', async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as any;
  await pool.query(`UPDATE fraud_alerts SET status = 'closed' WHERE id = $1`, [id]);
  return reply.send({ ok: true });
});

app.get('/reports', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as any;
  const limit = Math.min(Number(q?.limit ?? 20), 100);
  const res = await pool.query(
    `SELECT id, merchant_id, report_type, window_start, window_end, summary, details, created_at
     FROM intelligence_reports
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return reply.send({ reports: res.rows });
});

app.post('/reports/generate', async () => {
  await generateReportOnce();
  return { ok: true };
});

export async function main() {
  setInterval(async () => {
    try {
      await generateReportOnce();
    } catch (e: any) {
      app.log.error({ err: e?.message ?? String(e) }, 'report_loop_error');
    }
  }, reportEveryMs);

  await startConsumer();

  const port = Number(process.env.PORT ?? 6000);
  await app.listen({ port, host: '0.0.0.0' });
}

export { startConsumer, generateReportOnce };

