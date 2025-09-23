'use strict';

const { ENABLE_USER_SYSTEM } = require('../featureFlags');

class BackgroundQueue {
  constructor({ prisma, logger = console }) {
    this.prisma = prisma;
    this.logger = logger;
    this.jobs = [];
    this.processing = false;
    this.batchSize = 50; // Increased batch size for better throughput
    this.processingInterval = 50; // Reduced interval for faster processing
    this.maxConcurrentJobs = 10; // Process multiple jobs in parallel
    this.jobRetries = new Map(); // Track retries for failed jobs
    this.maxRetries = 3;
  }

  // Add job to queue
  enqueue(job) {
    this.jobs.push({
      ...job,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now()
    });
    this.logger.log(`Job enqueued: ${job.type} (${this.jobs.length} jobs in queue)`);
  }

  // Process jobs in batches with parallel execution
  async processJobs() {
    if (this.processing || this.jobs.length === 0) return;
    
    this.processing = true;
    const batch = this.jobs.splice(0, this.batchSize);
    
    try {
      // Process jobs in parallel chunks to avoid overwhelming the database
      const chunks = [];
      for (let i = 0; i < batch.length; i += this.maxConcurrentJobs) {
        chunks.push(batch.slice(i, i + this.maxConcurrentJobs));
      }
      
      for (const chunk of chunks) {
        await Promise.allSettled(
          chunk.map(job => this.executeJobWithRetry(job))
        );
      }
    } catch (error) {
      this.logger.error('Batch processing error:', error);
    } finally {
      this.processing = false;
    }
  }

  // Execute job with retry logic
  async executeJobWithRetry(job) {
    const retryCount = this.jobRetries.get(job.id) || 0;
    
    try {
      await this.executeJob(job);
      this.jobRetries.delete(job.id); // Clear on success
    } catch (error) {
      this.logger.error(`Job execution failed (${job.type}, attempt ${retryCount + 1}):`, error);
      
      if (retryCount < this.maxRetries) {
        this.jobRetries.set(job.id, retryCount + 1);
        // Re-queue with exponential backoff
        setTimeout(() => {
          this.jobs.push(job);
        }, Math.min(1000 * Math.pow(2, retryCount), 30000));
      } else {
        this.logger.error(`Job ${job.id} failed after ${this.maxRetries} retries`);
        this.jobRetries.delete(job.id);
      }
    }
  }

  // Execute individual job
  async executeJob(job) {
    const startTime = Date.now();
    
    try {
      switch (job.type) {
        case 'MEMORY_SAVE':
          await this.saveMemory(job.data);
          break;
        case 'SESSION_UPDATE':
          await this.updateSession(job.data);
          break;
        case 'TRANSCRIPT_BATCH':
          await this.batchTranscriptUpserts(job.data);
          break;
        case 'CONVERSATION_SAVE':
          await this.saveConversation(job.data);
          break;
        case 'CONTEXT_WINDOW_UPDATE':
          await this.updateContextWindow(job.data);
          break;
        default:
          this.logger.warn(`Unknown job type: ${job.type}`);
      }
      
      const duration = Date.now() - startTime;
      if (duration > 1000) {
        this.logger.warn(`Slow job execution (${job.type}): ${duration}ms`);
      }
    } catch (error) {
      throw error; // Re-throw for retry logic
    }
  }

  // Memory save job
  async saveMemory({ userId, text, dedupeWindow = 12 * 60 * 60 * 1000 }) {
    if (!this.prisma || !ENABLE_USER_SYSTEM) return;
    
    // Deduplicate within recent window
    const since = new Date(Date.now() - dedupeWindow);
    const dupe = await this.prisma.memory.findFirst({ 
      where: { userId, text, createdAt: { gt: since } } 
    });
    
    if (dupe) {
      this.logger.log(`Memory deduplicated: ${dupe.id}`);
      return;
    }
    
    const saved = await this.prisma.memory.create({ 
      data: { userId, text } 
    });
    this.logger.log(`Memory saved: ${saved.id}`);
  }

  // Session update job
  async updateSession({ sessionId, userId, conversationId, lastSeenAt }) {
    if (!this.prisma || !ENABLE_USER_SYSTEM) return;
    
    const sessionUpdate = { lastSeenAt: lastSeenAt || new Date() };
    const sessionCreate = { omiSessionId: sessionId };
    
    if (userId) {
      sessionUpdate.userId = userId;
      sessionCreate.userId = userId;
    }
    if (conversationId) {
      sessionUpdate.openaiConversationId = conversationId;
      sessionCreate.openaiConversationId = conversationId;
    }
    
    const sessionRow = await this.prisma.omiSession.upsert({
      where: { omiSessionId: sessionId },
      update: sessionUpdate,
      create: sessionCreate
    });
    
    this.logger.log(`Session updated: ${sessionRow.id}`);
    return sessionRow;
  }

  // Batch transcript upserts - optimized with transaction
  async batchTranscriptUpserts({ sessionId, segments }) {
    if (!this.prisma || !ENABLE_USER_SYSTEM || !segments?.length) return;
    
    // Get session row ID
    const sessionRow = await this.prisma.omiSession.findUnique({
      where: { omiSessionId: sessionId }
    });
    
    if (!sessionRow) {
      this.logger.warn(`Session not found for transcript batch: ${sessionId}`);
      return;
    }
    
    // Process segments in smaller chunks to avoid overwhelming the database
    const chunkSize = 10;
    for (let i = 0; i < segments.length; i += chunkSize) {
      const chunk = segments.slice(i, i + chunkSize);
      
      // Use transaction for atomic operations
      await this.prisma.$transaction(async (tx) => {
        const operations = chunk.map((seg) => {
          if (!seg) return null;
          const text = String(seg.text || '');
          const omiSegmentId = String(seg.id || seg.segment_id || require('crypto').createHash('sha1').update(text).digest('hex'));
          
          return tx.transcriptSegment.upsert({
            where: { omiSessionId_omiSegmentId: { omiSessionId: sessionRow.id, omiSegmentId } },
            update: { 
              text, 
              speaker: seg.speaker || null, 
              speakerId: (seg.speaker_id ?? seg.speakerId ?? null), 
              isUser: seg.is_user ?? null, 
              start: seg.start ?? null, 
              end: seg.end ?? null 
            },
            create: { 
              omiSessionId: sessionRow.id, 
              omiSegmentId, 
              text, 
              speaker: seg.speaker || null, 
              speakerId: (seg.speaker_id ?? seg.speakerId ?? null), 
              isUser: seg.is_user ?? null, 
              start: seg.start ?? null, 
              end: seg.end ?? null 
            }
          });
        }).filter(Boolean);
        
        await Promise.all(operations);
      }).catch((err) => {
        this.logger.error(`Transcript chunk upsert failed (${i}-${i + chunkSize}):`, err);
        throw err; // Re-throw for retry logic
      });
    }
    
    this.logger.log(`Batch transcript upserts completed: ${segments.length} segments`);
  }

  // Conversation save job
  async saveConversation({ sessionId, conversationId, question, aiResponse }) {
    if (!this.prisma || !ENABLE_USER_SYSTEM) return;
    
    const sessionRow = await this.prisma.omiSession.findUnique({
      where: { omiSessionId: sessionId }
    });
    
    if (!sessionRow) {
      this.logger.warn(`Session not found for conversation save: ${sessionId}`);
      return;
    }
    
    const conversationRow = await this.prisma.conversation.upsert({
      where: { omiSessionId_openaiConversationId: { omiSessionId: sessionRow.id, openaiConversationId: conversationId } },
      update: {},
      create: { omiSessionId: sessionRow.id, openaiConversationId: conversationId }
    });
    
    if (question) {
      await this.prisma.message.create({ 
        data: { 
          conversationId: conversationRow.id, 
          role: 'USER', 
          text: question, 
          source: 'OMI_TRANSCRIPT' 
        } 
      });
    }
    
    if (aiResponse) {
      await this.prisma.message.create({ 
        data: { 
          conversationId: conversationRow.id, 
          role: 'ASSISTANT', 
          text: aiResponse, 
          source: 'SYSTEM' 
        } 
      });
    }
    
    this.logger.log(`Conversation saved: ${conversationRow.id}`);
    return conversationRow;
  }

  // Context window update job
  async updateContextWindow({ userId, conversationId }) {
    if (!this.prisma || !ENABLE_USER_SYSTEM || !userId || !conversationId) return;
    
    // First, ensure the conversation exists and is properly linked to the user
    const conversation = await this.prisma.conversation.findFirst({
      where: { 
        id: conversationId,
        OR: [
          { userId: userId },
          { omiSession: { userId: userId } }
        ]
      }
    });
    
    if (!conversation) {
      this.logger.warn(`Conversation ${conversationId} not found or not accessible by user ${userId}`);
      return;
    }
    
    // Update the conversation to ensure it has the userId set
    if (!conversation.userId) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { userId: userId }
      });
      this.logger.log(`Linked conversation ${conversationId} to user ${userId}`);
    }
    
    let active = await this.prisma.userContextWindow.findFirst({ 
      where: { userId, isActive: true } 
    });
    
    if (!active) {
      const existingSlot1 = await this.prisma.userContextWindow.findUnique({ 
        where: { userId_slot: { userId, slot: 1 } } 
      });
      
      if (!existingSlot1) {
        await this.prisma.userContextWindow.create({ 
          data: { userId, slot: 1, conversationId, isActive: true } 
        });
      } else {
        await this.prisma.userContextWindow.update({ 
          where: { userId_slot: { userId, slot: 1 } }, 
          data: { conversationId, isActive: true } 
        });
      }
    } else {
      await this.prisma.userContextWindow.update({ 
        where: { userId_slot: { userId, slot: active.slot } }, 
        data: { conversationId } 
      });
    }
    
    this.logger.log(`Context window updated for user: ${userId}`);
  }

  // Start processing loop
  start() {
    setInterval(() => this.processJobs(), this.processingInterval);
    this.logger.log('Background queue started');
  }

  // Get queue status
  getStatus() {
    const jobTypeCounts = {};
    this.jobs.forEach(job => {
      jobTypeCounts[job.type] = (jobTypeCounts[job.type] || 0) + 1;
    });
    
    return {
      queueLength: this.jobs.length,
      processing: this.processing,
      batchSize: this.batchSize,
      processingInterval: this.processingInterval,
      maxConcurrentJobs: this.maxConcurrentJobs,
      retryQueueSize: this.jobRetries.size,
      jobTypeCounts
    };
  }
}

module.exports = { BackgroundQueue };