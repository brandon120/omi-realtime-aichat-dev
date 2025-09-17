-- Add new activation & quiet hours fields to preferences tables (idempotent)

DO $$ BEGIN
  ALTER TABLE "public"."UserPreference"
    ADD COLUMN IF NOT EXISTS "activationRegex" TEXT,
    ADD COLUMN IF NOT EXISTS "activationSensitivity" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "mute" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "dndQuietHoursStart" TEXT,
    ADD COLUMN IF NOT EXISTS "dndQuietHoursEnd" TEXT;
EXCEPTION WHEN undefined_table THEN
  -- Table might not exist in older deployments; skip
  NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."OmiSessionPreference"
    ADD COLUMN IF NOT EXISTS "activationRegex" TEXT,
    ADD COLUMN IF NOT EXISTS "activationSensitivity" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "mute" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "dndQuietHoursStart" TEXT,
    ADD COLUMN IF NOT EXISTS "dndQuietHoursEnd" TEXT;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

