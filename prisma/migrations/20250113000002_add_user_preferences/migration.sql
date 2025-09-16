-- CreateEnum if not exists for ListenMode
DO $$ BEGIN
  CREATE TYPE "public"."ListenMode" AS ENUM ('TRIGGER', 'FOLLOWUP', 'ALWAYS');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable UserPreference (if not exists)
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "public"."UserPreference" (
    "userId" UUID NOT NULL,
    "listenMode" "public"."ListenMode" NOT NULL DEFAULT 'TRIGGER',
    "followupWindowMs" INTEGER NOT NULL DEFAULT 8000,
    "meetingTranscribe" BOOLEAN NOT NULL DEFAULT false,
    "injectMemories" BOOLEAN NOT NULL DEFAULT false,
    "defaultConversationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId")
  );
EXCEPTION
  WHEN duplicate_table THEN null;
END $$;

-- Add foreign key constraints for UserPreference (if not already present)
DO $$ BEGIN
  ALTER TABLE "public"."UserPreference"
    ADD CONSTRAINT "UserPreference_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "UserPreference_defaultConversationId_idx"
    ON "public"."UserPreference"("defaultConversationId");
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."UserPreference"
    ADD CONSTRAINT "UserPreference_defaultConversationId_fkey"
      FOREIGN KEY ("defaultConversationId") REFERENCES "public"."Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable OmiSessionPreference (if not exists)
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "public"."OmiSessionPreference" (
    "omiSessionId" UUID NOT NULL,
    "listenMode" "public"."ListenMode" NOT NULL DEFAULT 'TRIGGER',
    "followupWindowMs" INTEGER NOT NULL DEFAULT 8000,
    "meetingTranscribe" BOOLEAN NOT NULL DEFAULT false,
    "injectMemories" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OmiSessionPreference_pkey" PRIMARY KEY ("omiSessionId")
  );
EXCEPTION
  WHEN duplicate_table THEN null;
END $$;

-- Add foreign key constraints for OmiSessionPreference
DO $$ BEGIN
  ALTER TABLE "public"."OmiSessionPreference"
    ADD CONSTRAINT "OmiSessionPreference_omiSessionId_fkey"
      FOREIGN KEY ("omiSessionId") REFERENCES "public"."OmiSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

