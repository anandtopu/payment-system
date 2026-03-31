CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  public_api_key TEXT UNIQUE NOT NULL,
  secret_api_key TEXT NOT NULL,
  webhook_url TEXT,
  webhook_secret TEXT,
  subscribed_events TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE payment_intent_status AS ENUM ('created','processing','succeeded','failed');

CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  amount_in_cents BIGINT NOT NULL CHECK (amount_in_cents > 0),
  currency TEXT NOT NULL,
  description TEXT,
  status payment_intent_status NOT NULL DEFAULT 'created',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, idem_key)
);

CREATE TYPE transaction_type AS ENUM ('charge');
CREATE TYPE transaction_status AS ENUM ('pending','succeeded','failed','timeout');

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  type transaction_type NOT NULL,
  amount_in_cents BIGINT NOT NULL CHECK (amount_in_cents > 0),
  currency TEXT NOT NULL,
  status transaction_status NOT NULL DEFAULT 'pending',
  network_ref TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  callback_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE webhook_delivery_status AS ENUM ('pending','succeeded','failed');

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  callback_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_payload JSONB NOT NULL,
  status webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  last_status_code INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_intents_updated ON payment_intents;
CREATE TRIGGER trg_payment_intents_updated
BEFORE UPDATE ON payment_intents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_transactions_updated ON transactions;
CREATE TRIGGER trg_transactions_updated
BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_webhook_deliveries_updated ON webhook_deliveries;
CREATE TRIGGER trg_webhook_deliveries_updated
BEFORE UPDATE ON webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO merchants (name, public_api_key, secret_api_key, webhook_secret, subscribed_events)
VALUES (
  'Demo Merchant',
  'pk_demo_123',
  'sk_demo_123',
  'whsec_demo_123',
  ARRAY['payment.succeeded','payment.failed']
)
ON CONFLICT (public_api_key) DO NOTHING;
