ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS callback_url TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS secret TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS last_status_code INT;

UPDATE webhook_deliveries SET callback_url = '' WHERE callback_url IS NULL;
UPDATE webhook_deliveries SET secret = '' WHERE secret IS NULL;

DO $$ BEGIN
  ALTER TABLE webhook_deliveries ALTER COLUMN callback_url SET NOT NULL;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE webhook_deliveries ALTER COLUMN secret SET NOT NULL;
EXCEPTION
  WHEN others THEN NULL;
END $$;
