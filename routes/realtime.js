'use strict';

const { 
  ValidationError,
  ExternalServiceError,
  asyncHandler 
} = require('../utils/errors');
const { logger } = require('../services/logger');

/**
 * Real-time chat routes
 * Handles real-time conversations and OpenAI interactions
 */
module.exports = function createRealtimeRoutes({ app, prisma, openai, config }) {
  if (!app) throw new Error('app is required');
  
  const OPENAI_MODEL = config.getValue('openai.model');
  const ENABLE_USER_SYSTEM = config.getValue('database.enableUserSystem');
  
  // In-memory session state (will be replaced with Redis in production)
  const sessionTranscripts = new Map();
  const sessionConversations = new Map();
  const sessionContextState = new Map();
  const lastProcessedQuestion = new Map();
  
  // Context spaces
  const ALLOWED_SPACES = ['default', 'todos', 'memories', 'tasks', 'agent', 'friends', 'notifications'];
  
  // Helper: Initialize session state
  function getOrInitSessionState(sessionId) {
    if (!sessionContextState.has(sessionId)) {
      sessionContextState.set(sessionId, { space: 'default', pending: null });
    }
    return sessionContextState.get(sessionId);
  }
  
  // Helper: Format message with context labels
  function formatMessageWithLabels(sessionId, content) {
    try {
      const state = getOrInitSessionState(sessionId);
      if (!state.space || state.space === 'default') return content;
      
      const spaceLabel = state.space.charAt(0).toUpperCase() + state.space.slice(1);
      return `[${spaceLabel}] ${content}`;
    } catch (error) {
      logger.error('Error formatting message with labels', {
        sessionId,
        error: error.message
      });
      return content;
    }
  }
  
  // Helper: Normalize text for deduplication
  function normalizeText(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  // Helper: Check for near duplicates
  function isNearDuplicate(a, b) {
    if (!a || !b) return false;
    const similarity = calculateSimilarity(a, b);
    return similarity > 0.85;
  }
  
  function calculateSimilarity(a, b) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1.0;
    const editDistance = levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }
  
  function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }
  
  // POST /chat - Main chat endpoint
  app.post('/chat', asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { session_id, message, context } = req.body;
    
    if (!session_id || !message) {
      throw new ValidationError('session_id and message are required');
    }
    
    logger.info('Chat request received', {
      sessionId: session_id,
      messageLength: message.length,
      hasContext: !!context
    });
    
    try {
      // Get or create conversation
      let conversationId = sessionConversations.get(session_id);
      
      if (!conversationId && openai) {
        try {
          const conversation = await openai.conversations.create({
            metadata: { session_id }
          });
          conversationId = conversation.id;
          sessionConversations.set(session_id, conversationId);
        } catch (error) {
          logger.warn('Failed to create OpenAI conversation', {
            sessionId: session_id,
            error: error.message
          });
        }
      }
      
      // Check for duplicates
      const normalized = normalizeText(message);
      const lastQuestion = lastProcessedQuestion.get(session_id);
      const COOLDOWN_MS = 5000;
      
      if (lastQuestion && Date.now() - lastQuestion.ts < COOLDOWN_MS && isNearDuplicate(lastQuestion.normalized, normalized)) {
        logger.debug('Duplicate message detected', {
          sessionId: session_id,
          cooldownRemaining: COOLDOWN_MS - (Date.now() - lastQuestion.ts)
        });
        
        return res.json({
          response: 'I just answered that question. Is there something else I can help with?',
          duplicate: true
        });
      }
      
      lastProcessedQuestion.set(session_id, {
        normalized,
        ts: Date.now()
      });
      
      // Format message with context labels
      const formattedMessage = formatMessageWithLabels(session_id, message);
      
      // Build system instructions
      const systemInstructions = [
        'You are Omi, a helpful AI assistant.',
        'Keep responses concise and practical.',
        context ? `Context: ${context}` : ''
      ].filter(Boolean).join('\n');
      
      // Call OpenAI
      let response = '';
      
      if (openai) {
        try {
          const openaiResponse = await Promise.race([
            openai.responses.create({
              model: OPENAI_MODEL,
              input: formattedMessage,
              conversation: conversationId,
              instructions: systemInstructions,
              max_tokens: config.getValue('openai.maxTokens'),
              temperature: config.getValue('openai.temperature')
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('OpenAI timeout')), config.getValue('openai.timeout'))
            )
          ]);
          
          response = openaiResponse.output_text;
        } catch (error) {
          if (error.message === 'OpenAI timeout') {
            logger.warn('OpenAI request timed out', {
              sessionId: session_id,
              duration: Date.now() - startTime
            });
            response = "I'm taking a bit longer to think. Please try again.";
          } else {
            throw new ExternalServiceError('OpenAI', error);
          }
        }
      } else {
        // Fallback response when OpenAI is not configured
        response = "I'm currently unavailable. Please check back later.";
      }
      
      // Store in database if enabled
      if (ENABLE_USER_SYSTEM && prisma) {
        try {
          const sessionRow = await prisma.omiSession.findUnique({
            where: { omiSessionId: session_id }
          });
          
          if (sessionRow) {
            const conversationRow = await prisma.conversation.upsert({
              where: {
                omiSessionId_openaiConversationId: {
                  omiSessionId: sessionRow.id,
                  openaiConversationId: conversationId || 'fallback'
                }
              },
              update: {},
              create: {
                omiSessionId: sessionRow.id,
                openaiConversationId: conversationId || 'fallback'
              }
            });
            
            // Save messages
            await prisma.message.createMany({
              data: [
                {
                  conversationId: conversationRow.id,
                  role: 'USER',
                  text: message,
                  source: 'TYPED'
                },
                {
                  conversationId: conversationRow.id,
                  role: 'ASSISTANT',
                  text: response,
                  source: 'SYSTEM'
                }
              ]
            });
          }
        } catch (error) {
          logger.error('Failed to save conversation', {
            sessionId: session_id,
            error: error.message
          });
        }
      }
      
      const duration = Date.now() - startTime;
      logger.info('Chat response sent', {
        sessionId: session_id,
        duration: `${duration}ms`,
        responseLength: response.length
      });
      
      res.json({
        response,
        conversationId,
        duration
      });
    } catch (error) {
      logger.error('Chat error', {
        sessionId: session_id,
        error: error.message,
        duration: Date.now() - startTime
      });
      throw error;
    }
  }));
  
  // POST /context/switch - Switch context space
  app.post('/context/switch', asyncHandler(async (req, res) => {
    const { session_id, space } = req.body;
    
    if (!session_id) {
      throw new ValidationError('session_id is required');
    }
    
    if (space && !ALLOWED_SPACES.includes(space)) {
      throw new ValidationError(`Invalid space. Allowed: ${ALLOWED_SPACES.join(', ')}`);
    }
    
    const state = getOrInitSessionState(session_id);
    const oldSpace = state.space;
    state.space = space || 'default';
    state.pending = null;
    
    logger.info('Context space switched', {
      sessionId: session_id,
      oldSpace,
      newSpace: state.space
    });
    
    res.json({
      success: true,
      previousSpace: oldSpace,
      currentSpace: state.space,
      message: `Switched to ${state.space} space`
    });
  }));
  
  // GET /context/status/:sessionId - Get context status
  app.get('/context/status/:sessionId', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const state = sessionContextState.get(sessionId);
    
    if (!state) {
      return res.json({
        space: 'default',
        pending: null,
        initialized: false
      });
    }
    
    res.json({
      space: state.space,
      pending: state.pending,
      initialized: true
    });
  }));
  
  // GET /sessions - Get active sessions
  app.get('/sessions', asyncHandler(async (req, res) => {
    const sessions = [];
    
    for (const [sessionId, state] of sessionContextState.entries()) {
      const lastQuestion = lastProcessedQuestion.get(sessionId);
      sessions.push({
        sessionId,
        space: state.space,
        hasPending: !!state.pending,
        lastActivity: lastQuestion?.ts || null,
        conversationId: sessionConversations.get(sessionId) || null
      });
    }
    
    // Sort by last activity
    sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    
    res.json({
      total: sessions.length,
      sessions: sessions.slice(0, 100) // Limit to 100 most recent
    });
  }));
  
  // POST /sessions/clear - Clear old sessions
  app.post('/sessions/clear', asyncHandler(async (req, res) => {
    const { olderThan = 3600000 } = req.body; // Default 1 hour
    const now = Date.now();
    let cleared = 0;
    
    for (const [sessionId, lastQuestion] of lastProcessedQuestion.entries()) {
      if (now - lastQuestion.ts > olderThan) {
        sessionTranscripts.delete(sessionId);
        sessionConversations.delete(sessionId);
        sessionContextState.delete(sessionId);
        lastProcessedQuestion.delete(sessionId);
        cleared++;
      }
    }
    
    logger.info('Sessions cleared', {
      cleared,
      olderThan: `${olderThan}ms`
    });
    
    res.json({
      cleared,
      remaining: sessionContextState.size
    });
  }));
  
  // GET /transcript/:sessionId - Get session transcript
  app.get('/transcript/:sessionId', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    
    if (ENABLE_USER_SYSTEM && prisma) {
      const sessionRow = await prisma.omiSession.findUnique({
        where: { omiSessionId: sessionId },
        include: {
          transcripts: {
            orderBy: { createdAt: 'asc' }
          }
        }
      });
      
      if (sessionRow && sessionRow.transcripts.length > 0) {
        return res.json({
          sessionId,
          transcripts: sessionRow.transcripts
        });
      }
    }
    
    // Fallback to in-memory
    const transcript = sessionTranscripts.get(sessionId);
    
    res.json({
      sessionId,
      transcript: transcript || [],
      source: transcript ? 'memory' : 'none'
    });
  }));
  
  logger.info('Realtime routes initialized');
};