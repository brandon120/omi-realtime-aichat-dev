-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "public"."MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "public"."MessageSource" AS ENUM ('FRONTEND', 'OMI_TRANSCRIPT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "public"."NotificationChannel" AS ENUM ('OMI', 'EMAIL', 'PUSH');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "role" "public"."Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuthSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OmiUserLink" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "omiUserId" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verificationCode" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OmiUserLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OmiSession" (
    "id" UUID NOT NULL,
    "omiSessionId" TEXT NOT NULL,
    "userId" UUID,
    "openaiConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OmiSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Conversation" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "omiSessionId" UUID,
    "openaiConversationId" TEXT NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" "public"."MessageRole" NOT NULL,
    "text" TEXT NOT NULL,
    "rawPayload" JSONB,
    "source" "public"."MessageSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TranscriptSegment" (
    "id" UUID NOT NULL,
    "omiSessionId" UUID NOT NULL,
    "omiSegmentId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "speaker" TEXT,
    "speakerId" INTEGER,
    "isUser" BOOLEAN,
    "start" DOUBLE PRECISION,
    "end" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserContextWindow" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "conversationId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserContextWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentEvent" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "conversationId" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotificationEvent" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "channel" "public"."NotificationChannel" NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Memory" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_sessionToken_key" ON "public"."AuthSession"("sessionToken");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "public"."AuthSession"("userId");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "public"."AuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OmiUserLink_omiUserId_key" ON "public"."OmiUserLink"("omiUserId");

-- CreateIndex
CREATE INDEX "OmiUserLink_userId_idx" ON "public"."OmiUserLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OmiSession_omiSessionId_key" ON "public"."OmiSession"("omiSessionId");

-- CreateIndex
CREATE INDEX "OmiSession_userId_idx" ON "public"."OmiSession"("userId");

-- CreateIndex
CREATE INDEX "Conversation_userId_idx" ON "public"."Conversation"("userId");

-- CreateIndex
CREATE INDEX "Conversation_omiSessionId_idx" ON "public"."Conversation"("omiSessionId");

-- CreateIndex
CREATE INDEX "Conversation_openaiConversationId_idx" ON "public"."Conversation"("openaiConversationId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "public"."Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_role_idx" ON "public"."Message"("role");

-- CreateIndex
CREATE INDEX "Message_source_idx" ON "public"."Message"("source");

-- CreateIndex
CREATE INDEX "TranscriptSegment_omiSessionId_idx" ON "public"."TranscriptSegment"("omiSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_omiSessionId_omiSegmentId_key" ON "public"."TranscriptSegment"("omiSessionId", "omiSegmentId");

-- CreateIndex
CREATE INDEX "UserContextWindow_userId_isActive_idx" ON "public"."UserContextWindow"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "UserContextWindow_userId_slot_key" ON "public"."UserContextWindow"("userId", "slot");

-- CreateIndex
CREATE INDEX "AgentEvent_userId_idx" ON "public"."AgentEvent"("userId");

-- CreateIndex
CREATE INDEX "AgentEvent_conversationId_idx" ON "public"."AgentEvent"("conversationId");

-- CreateIndex
CREATE INDEX "NotificationEvent_userId_idx" ON "public"."NotificationEvent"("userId");

-- CreateIndex
CREATE INDEX "NotificationEvent_channel_idx" ON "public"."NotificationEvent"("channel");

-- CreateIndex
CREATE INDEX "NotificationEvent_createdAt_idx" ON "public"."NotificationEvent"("createdAt");

-- CreateIndex
CREATE INDEX "Memory_userId_idx" ON "public"."Memory"("userId");

-- AddForeignKey
ALTER TABLE "public"."AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OmiUserLink" ADD CONSTRAINT "OmiUserLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OmiSession" ADD CONSTRAINT "OmiSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_omiSessionId_fkey" FOREIGN KEY ("omiSessionId") REFERENCES "public"."OmiSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_omiSessionId_fkey" FOREIGN KEY ("omiSessionId") REFERENCES "public"."OmiSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserContextWindow" ADD CONSTRAINT "UserContextWindow_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserContextWindow" ADD CONSTRAINT "UserContextWindow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentEvent" ADD CONSTRAINT "AgentEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentEvent" ADD CONSTRAINT "AgentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotificationEvent" ADD CONSTRAINT "NotificationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
