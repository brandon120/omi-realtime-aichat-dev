'use strict';

const { ENABLE_USER_SYSTEM } = require('../featureFlags');
const { logger } = require('./logger');
const { QueueError } = require('../utils/errors');

class BackgroundQueue {
  constructor({ prisma }) {
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
    const jobWithId = {
      ...job,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now()
    };
    this.jobs.push(jobWithId);
    this.logger.logQueue('enqueue', job.type, jobWithId.id, { 
      queueLength: this.jobs.length 
    });
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
      this.logger.error('Batch processing error', { 
        error: error.message,
        batchSize: batch.length 
      });
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
      this.logger.logQueue('process', job.type, job.id, { 
        success: true,
        attempt: retryCount + 1 
      });
    } catch (error) {
      this.logger.logQueue('failed', job.type, job.id, {
        attempt: retryCount + 1,
        willRetry: retryCount < this.maxRetries
      }, error);
      
      if (retryCount < this.maxRetries) {
        this.jobRetries.set(job.id, retryCount + 1);
        // Re-queue with exponential backoff
        setTimeout(() => {
          this.jobs.push(job);
        }, Math.min(1000 * Math.pow(2, retryCount), 30000));
      } else {
        this.logger.error(`Job permanently failed after ${this.maxRetries} retries`, {
          jobId: job.id,
          jobType: job.type,
          retries: this.maxRetries
        });
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
          this.logger.warn('Unknown job type', { jobType: job.type, jobId: job.id });
      }
      
      const duration = Date.now() - startTime;
      if (duration > 1000) {
        this.logger.warn('Slow job execution', {
          jobType: job.type,
          jobId: job.id,
          duration: `${duration}ms`,
          threshold: '1000ms'
        });
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
      this.logger.debug('Memory deduplicated', { 
        memoryId: dupe.id,
        userId,
        textLength: text.length 
      });
      return;
    }
    
    const saved = await this.prisma.memory.create({ 
      data: { userId, text } 
    });
    this.logger.info('Memory saved', { 
      memoryId: saved.id,
      userId,
      textLength: text.length 
    });
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
    
    this.logger.debug('Session updated', { 
      sessionId: sessionRow.id,
      omiSessionId: sessionId,
      hasUser: !!userId,
      hasConversation: !!conversationId 
    });
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
      this.logger.warn('Session not found for transcript batch', { 
        sessionId,
        segmentCount: segments?.length || 0 
      });
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
        this.logger.error('Transcript chunk upsert failed', {
          sessionId,
          chunkRange: `${i}-${i + chunkSize}`,
          error: err.message
        });
        throw err; // Re-throw for retry logic
      });
    }
    
    this.logger.info('Batch transcript upserts completed', {
      sessionId,
      segmentCount: segments.length,
      chunksProcessed: Math.ceil(segments.length / chunkSize)
    });
  }

  // Conversation save job
  async saveConversation({ sessionId, conversationId, question, aiResponse }) {
    if (!this.prisma || !ENABLE_USER_SYSTEM) return;
    
    const sessionRow = await this.prisma.omiSession.findUnique({
      where: { omiSessionId: sessionId }
    });
    
    if (!sessionRow) {
      this.logger.warn('Session not found for conversation save', { 
        sessionId,
        conversationId 
      });
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
    
    this.logger.info('Conversation saved', { 
      conversationId: conversationRow.id,
      sessionId: sessionRow.id,
      hasQuestion: !!question,
      hasResponse: !!aiResponse 
    });
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
      this.logger.warn('Conversation not accessible', { 
        conversationId,
        userId 
      });
      return;
    }
    
    // Update the conversation to ensure it has the userId set
    if (!conversation.userId) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { userId: userId }
      });
      this.logger.debug('Linked conversation to user', { 
        conversationId,
        userId 
      });
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
    
    this.logger.debug('Context window updated', { 
      userId,
      conversationId,
      slot: active?.slot || 1 
    });
  }

  // Start processing loop
  start() {
    setInterval(() => this.processJobs(), this.processingInterval);
    this.logger.info('Background queue started', {
      batchSize: this.batchSize,
      processingInterval: `${this.processingInterval}ms`,
      maxConcurrentJobs: this.maxConcurrentJobs,
      maxRetries: this.maxRetries
    });
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