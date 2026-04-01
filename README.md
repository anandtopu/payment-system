# Payment System (Stripe-like) - Production-Style Demo

This repository is a production-style payment processing system built for system design practice and as a deployable GitHub portfolio project.

## System Architecture

```mermaid
graph TD
    subgraph External
        Sim[Payment Simulator]
        Merc[Merchant Webhook Receiver]
        User[Dashboard User]
    end

    subgraph API Layer
        GW[API Gateway]
    end

    subgraph Core Services
        PIS[Payment Intent Service]
        TXS[Transaction Service]
        WHS[Webhook Service]
        Recon[Reconciliation Worker]
    end

    subgraph AI Ops & UI
        AIOps[AI Ops Service]
        Dash[Dashboard Service]
    end

    subgraph Storage & Messaging
        PG[(PostgreSQL)]
        Redis[(Redis)]
        Kafka[Kafka]
        Debezium[Debezium Kafka Connect]
    end

    %% External Interactions
    Sim -- HTTP Requests --> GW
    User -- Browser --> Dash
    WHS -- HTTP Post --> Merc

    %% API Routing
    GW -- HTTP --> PIS
    GW -- HTTP --> TXS
    GW -- HTTP --> WHS
    
    %% Service to storage
    GW -- Cache/Rate Limit --> Redis
    PIS -- Read/Write --> PG
    TXS -- Read/Write --> PG
    WHS -- Read/Write --> PG
    Recon -- Poll/Update --> PG

    %% CDC Pipeline
    PG -- WAL --> Debezium
    Debezium -- CDC Events --> Kafka

    %% Kafka Consumers
    TXS -. Pub/Sub .-> Kafka
    WHS -. Consume CDC .-> Kafka
    AIOps -. Consume CDC .-> Kafka

    %% AI Ops and Dashboard
    AIOps -- Write Alerts --> PG
    Dash -- HTTP API --> AIOps
    Dash -- Read --> PG
```

## Capabilities (in-scope)
- Create `PaymentIntent`
- Create `charge` `Transaction` for a `PaymentIntent`
- Poll payment status
- Webhooks (server-to-server) for status changes
- Merchant authentication via API key + HMAC request signing + nonce replay protection
- Durable audit trail via Postgres WAL -> Debezium CDC -> Kafka topics
- **Agentic AI Ops**: True LLM-driven inference powered by the `@google/genai` (Gemini) SDK for anomaly triage and executive reporting
- **Conversational Debugger**: Embedded natural-language chatbot in the dashboard to analyze transaction flow joined state
- **Smart Reconciliation**: LLM-aided transaction healing deciding on failure states vs potential recovery
- End-to-end Adversarial traffic simulator driven by LLM generative payment payloads

## Local Development
### Prereqs
- Docker Desktop

### Start
```bash
docker compose up --build
```

## Service URLs (local)

Gateway: http://localhost:3005

AI Ops API: http://localhost:6000

Dashboard UI: http://localhost:7000

### Demo merchant credentials
- `public_api_key`: `pk_demo_123`
- `secret_api_key`: `sk_demo_123`

## New: LLM-Driven Agentic AI Workflows

This repo includes a deeply integrated **Agentic AI workflow** powered by the `@google/genai` SDK. It replaces legacy hardcoded heuristics with autonomous reasoning loops across four distinct service pillars:

1. **Auto-Triage Fraud Agent** (`ai-ops-service`)
2. **Conversational Support Debugger** (`dashboard-service`)
3. **Smart Healing Agent** (`reconciliation-worker`)
4. **Adversarial Flow Simulator** (`payment-simulator`)

> **Note**: These services are built with graceful degradation. If you do not provide a `GEMINI_API_KEY` in the environment, the system falls back to static math heuristics and deterministic mock functionality.

To unlock the AI models, configure the `.env` file before booting the cluster:
```env
GEMINI_API_KEY=your-gemini-api-key-here
```

### Data pipeline (CDC)

- **Source of truth**: Postgres
- **CDC**: Debezium (Kafka Connect) streams Postgres WAL changes into Kafka topics
- **Topics** (default):
  - `paymentdb.public.payment_intents`
  - `paymentdb.public.transactions`
  - `paymentdb.public.webhook_deliveries`

Connector registration is handled by the `debezium-init` compose service and is idempotent.

### DB migrations

Migrations are applied via the `db-migrate` service:

- `infra/db-migrate/migrations/003_ai_ops.sql`
  - Adds `fraud_alerts`
  - Adds `intelligence_reports`

### AI Ops Service (`ai-ops-service`)

Runs a Kafka consumer over CDC topics and maintains per-merchant rolling windows.

Key behaviors:

- Computes a dynamic risk score using failure/timeout distributions.
- **LLM Triage**: Feeds high-risk anomaly signatures to Gemini to produce a contextual **Root Cause Analysis** instead of just a raw number, inserted directly into the `fraud_alerts` database.
- **Executive Summaries**: Periodically passes aggregated network statistics to the LLM to generate highly contextual, human-readable intelligence reports.

API endpoints (read/write):

- `GET /alerts?limit=...`
- `POST /alerts/:id/ack`
- `POST /alerts/:id/close`
- `GET /reports?limit=...`

Environment variables (compose defaults):

- `PORT` (default `6000`)
- `DATABASE_URL`
- `KAFKA_BROKERS` (default `kafka:29092` in compose)
- `AIOPS_WINDOW_MS` (rolling window)
- `AIOPS_REPORT_EVERY_MS` (report interval)
- `AIOPS_TOPICS` (comma-separated override)

### Dashboard Service (`dashboard-service`)

Fastify web UI that calls `ai-ops-service` and renders:

- Overview
- Alerts (table)
- Intelligence reports
- Flow explorer (joins `payment_intents` + `transactions` + `webhook_deliveries` by `payment_intent_id`)
  - **Conversational AI Debugger**: A conversational panel asking natural-language questions about the queried `payment_intent_id`. The backend pulls the entire join state into context windows and gives a descriptive debug response.

Alert actions:

- Ack / Close buttons post back through the dashboard and proxy to `ai-ops-service`.

Environment variables:

- `PORT` (default `7000`)
- `DATABASE_URL`
- `AIOPS_URL` (default `http://ai-ops-service:6000` in compose)

### Payment Simulator (`payment-simulator`)

Generates realistic local traffic by creating payment intents + transactions. Rather than looping static conditions, the **Adversarial Simulator Agent** dynamically queries Gemini for bursty, malformed anomaly batch profiles to generate unpredictable, sophisticated edge-cases that stress-test the pipeline.

Run:

```bash
docker compose run --rm payment-simulator
```

Environment variables (compose defaults):

- `GATEWAY_URL` (default `http://api-gateway:3000` inside the compose network)
- `MERCHANT_PUBLIC_KEY` (default `pk_demo_123`)
- `SIM_TOTAL` (default `50`)
- `SIM_CONCURRENCY` (default `5`)

The simulator uses the gateway’s dev signing helper endpoint (see below) to generate valid HMAC headers for each request.

### Dev signing helper

For local demo convenience the gateway exposes a dev-only signing endpoint:

- `POST /dev/sign`

This endpoint is disabled in production.

## Notes
- This project includes a **mock payment network** for local testing. Real card handling/tokenization is explicitly out of scope.

## Common local port overrides

If you have local port conflicts, override via environment variables:

- `API_GATEWAY_HOST_PORT` (default `3005`)
- `DASHBOARD_HOST_PORT` (default `7000`)
- `AIOPS_HOST_PORT` (default `6000`)
- `REDIS_HOST_PORT` (default `6380`)

## Quick Demo Script (end-to-end)

This is a copy/paste-friendly runthrough to demonstrate:

- Kafka CDC events (Debezium)
- Agentic AI Ops alerts + intelligence reports
- Dashboard UI
- Webhook retry behavior (optional)

### 1) Start the full stack

```bash
docker compose up -d --build
```

Wait until services are healthy/running:

```bash
docker compose ps
```

Expected:

- `postgres` is `healthy`
- `kafka`, `kafka-connect` are `Up`
- `debezium-init` exits successfully (connector already exists is OK)
- `ai-ops-service`, `dashboard-service`, `api-gateway` are `Up`

### 2) Open the dashboard

- Dashboard UI: http://localhost:7000
- AI Ops API: http://localhost:6000
- Gateway: http://localhost:3005

### 3) Generate traffic (simulator)

```bash
docker compose run --rm payment-simulator
```

Expected simulator output includes a summary similar to:

- `"byTx":{"succeeded":40,"timeout":5,"failed":5}`

### 4) View alerts and reports

In the dashboard:

- Go to `/alerts`
  - You should see new alerts (demo heuristic-based risk)
  - Click **Ack** or **Close** to update the alert status
- Go to `/reports`
  - You should see periodic intelligence reports (mock summaries)

Alternatively via API:

```bash
curl http://localhost:6000/alerts?limit=20
curl http://localhost:6000/reports?limit=5
```

### 5) (Optional) Webhook retry demo

The stack includes a local webhook receiver that intentionally fails the first N webhook calls to demonstrate retries.

Receiver:

- http://localhost:4000

You can change how many initial deliveries fail by setting:

- `WEBHOOK_RECEIVER_FAIL_FIRST_N` (default `2`)

Then re-run:

```bash
docker compose up -d --build webhook-receiver webhook-service
docker compose run --rm payment-simulator
```

Expected:

- `webhook-service` enqueues deliveries
- failed deliveries are retried with backoff until success or max attempts
