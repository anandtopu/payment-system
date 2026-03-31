DO $$ BEGIN
  CREATE TYPE alert_severity AS ENUM ('low','medium','high');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE alert_status AS ENUM ('open','acknowledged','closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  severity alert_severity NOT NULL,
  type TEXT NOT NULL,
  score NUMERIC NOT NULL,
  status alert_status NOT NULL DEFAULT 'open',
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_merchant_created ON fraud_alerts (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_status_created ON fraud_alerts (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_fraud_alerts_updated ON fraud_alerts;
CREATE TRIGGER trg_fraud_alerts_updated
BEFORE UPDATE ON fraud_alerts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS intelligence_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id),
  report_type TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  summary TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intelligence_reports_created ON intelligence_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_reports_merchant_created ON intelligence_reports (merchant_id, created_at DESC);
