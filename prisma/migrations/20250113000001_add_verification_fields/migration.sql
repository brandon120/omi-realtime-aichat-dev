-- AlterTable
ALTER TABLE "public"."OmiUserLink" ADD COLUMN "verificationExpiresAt" TIMESTAMP(3),
ADD COLUMN "verificationAttempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_omiSessionId_openaiConversationId_key" UNIQUE ("omiSessionId", "openaiConversationId");
