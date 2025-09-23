'use strict';

const argon2 = require('argon2');
const crypto = require('crypto');
const { 
  ValidationError, 
  AuthenticationError, 
  NotFoundError,
  ConflictError,
  asyncHandler 
} = require('../utils/errors');
const { logger } = require('../services/logger');

/**
 * User management routes
 * Handles authentication, registration, and user preferences
 */
module.exports = function createUserRoutes({ app, prisma, config }) {
  if (!app) throw new Error('app is required');
  if (!prisma) throw new Error('prisma is required for user routes');
  
  const sessionSecret = config.getValue('server.sessionSecret');
  const cookieSecure = config.getValue('server.cookieSecure');
  const bcryptRounds = config.getValue('security.bcryptRounds');
  
  // Helper: Get cookie options
  function getCookieOptions() {
    return {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSecure ? 'none' : 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      signed: true
    };
  }
  
  // Helper: Get session ID from request
  function getSidFromRequest(req) {
    // Prefer Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const match = authHeader.match(/^(Bearer|Sid)\s+(.+)$/i);
      if (match) return match[2];
    }
    
    // Fallback to signed cookie
    if (req.signedCookies?.sid) {
      return req.signedCookies.sid;
    }
    
    // Query parameter (for testing only)
    if (config.getValue('env') === 'development' && req.query?.sid) {
      return req.query.sid;
    }
    
    return null;
  }
  
  // Middleware: Require authentication
  async function requireAuth(req, res, next) {
    try {
      const sid = getSidFromRequest(req);
      if (!sid) {
        throw new AuthenticationError('No session token provided');
      }
      
      const session = await prisma.authSession.findUnique({
        where: { sessionToken: sid },
        include: { user: true }
      });
      
      if (!session) {
        throw new AuthenticationError('Invalid session');
      }
      
      if (session.expiresAt && session.expiresAt < new Date()) {
        await prisma.authSession.delete({ where: { sessionToken: sid } });
        throw new AuthenticationError('Session expired');
      }
      
      req.user = session.user;
      req.sessionId = session.sessionToken;
      
      // Log authenticated request
      logger.debug('Authenticated request', {
        userId: req.user.id,
        email: req.user.email,
        path: req.path
      });
      
      next();
    } catch (error) {
      next(error);
    }
  }
  
  // POST /auth/register - User registration
  app.post('/auth/register', asyncHandler(async (req, res) => {
    const { email, password, name, display_name } = req.body;
    const displayName = display_name || name; // Support both field names
    
    // Validation
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }
    
    if (password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters');
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new ValidationError('Invalid email format');
    }
    
    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });
    
    if (existingUser) {
      throw new ConflictError('User with this email already exists');
    }
    
    // Hash password
    const hashedPassword = await argon2.hash(password);
    
    // Create user
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: hashedPassword,
        displayName: displayName || null
      }
    });
    
    // Create session
    const sid = crypto.randomBytes(32).toString('hex');
    const session = await prisma.authSession.create({
      data: {
        sessionToken: sid,
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
    
    // Set cookie
    res.cookie('sid', sid, getCookieOptions());
    
    logger.info('User registered', {
      userId: user.id,
      email: user.email
    });
    
    res.status(201).json({
      ok: true,
      session_token: sid,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt
      }
    });
  }));
  
  // POST /auth/login - User login
  app.post('/auth/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }
    
    // Find user
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });
    
    if (!user) {
      throw new AuthenticationError('Invalid credentials');
    }
    
    // Verify password
    const validPassword = await argon2.verify(user.passwordHash, password);
    if (!validPassword) {
      throw new AuthenticationError('Invalid credentials');
    }
    
    // Clean up old sessions
    await prisma.authSession.deleteMany({
      where: {
        userId: user.id,
        expiresAt: { lt: new Date() }
      }
    });
    
    // Create new session
    const sid = crypto.randomBytes(32).toString('hex');
    const session = await prisma.authSession.create({
      data: {
        sessionToken: sid,
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
    
    // Set cookie
    res.cookie('sid', sid, getCookieOptions());
    
    logger.info('User logged in', {
      userId: user.id,
      email: user.email
    });
    
    res.json({
      ok: true,
      session_token: sid,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt
      }
    });
  }));
  
  // POST /auth/logout - User logout
  app.post('/auth/logout', requireAuth, asyncHandler(async (req, res) => {
    await prisma.authSession.delete({
      where: { sessionToken: req.sessionId }
    });
    
    res.clearCookie('sid');
    
    logger.info('User logged out', {
      userId: req.user.id,
      email: req.user.email
    });
    
    res.json({ message: 'Logged out successfully' });
  }));
  
  // GET /auth/me - Get current user
  app.get('/auth/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        preferences: true,
        _count: {
          select: {
            memories: true,
            conversations: true,
            sessions: true
          }
        }
      }
    });
    
    if (!user) {
      throw new NotFoundError('User', req.user.id);
    }
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt,
        preferences: user.preferences,
        stats: user._count
      }
    });
  }));
  
  // GET /me - Get current user (Expo app compatibility)
  app.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const [user, links] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.id }
      }),
      prisma.omiUserLink.findMany({
        where: { userId: req.user.id },
        select: { omiUserId: true, isVerified: true, verifiedAt: true }
      }).catch(() => []) // Gracefully handle if table doesn't exist
    ]);
    
    if (!user) {
      throw new NotFoundError('User', req.user.id);
    }
    
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName
      },
      omi_links: links
    });
  }));
  
  // GET /preferences - Get user preferences
  app.get('/preferences', requireAuth, asyncHandler(async (req, res) => {
    const preferences = await prisma.userPreference.findUnique({
      where: { userId: req.user.id }
    });
    
    const defaults = {
      listenMode: config.getValue('userDefaults.listenMode'),
      followupWindowMs: config.getValue('userDefaults.followupWindowMs'),
      meetingTranscribe: false,
      injectMemories: false,
      quietHoursEnabled: config.getValue('features.quietHours'),
      quietHoursStart: config.getValue('userDefaults.quietHoursStart'),
      quietHoursEnd: config.getValue('userDefaults.quietHoursEnd'),
      activationRegex: config.getValue('userDefaults.activationRegex')
    };
    
    res.json({
      ok: true,
      preferences: preferences || defaults
    });
  }));
  
  // PATCH /preferences - Update user preferences (Expo app uses PATCH with snake_case)
  app.patch('/preferences', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const updates = {};
    
    // Map snake_case fields from Expo app to camelCase for database
    if (typeof body.listen_mode === 'string') updates.listenMode = body.listen_mode.toUpperCase();
    if (typeof body.followup_window_ms === 'number') updates.followupWindowMs = body.followup_window_ms;
    if (typeof body.meeting_transcribe === 'boolean') updates.meetingTranscribe = body.meeting_transcribe;
    if (typeof body.inject_memories === 'boolean') updates.injectMemories = body.inject_memories;
    if (typeof body.activation_regex === 'string') updates.activationRegex = body.activation_regex;
    if (typeof body.activation_sensitivity === 'number') updates.activationSensitivity = body.activation_sensitivity;
    if (typeof body.mute === 'boolean') updates.mute = body.mute;
    if (typeof body.dnd_quiet_hours_start === 'string') updates.quietHoursStart = parseInt(body.dnd_quiet_hours_start);
    if (typeof body.dnd_quiet_hours_end === 'string') updates.quietHoursEnd = parseInt(body.dnd_quiet_hours_end);
    if ('default_conversation_id' in body) updates.defaultConversationId = body.default_conversation_id;
    
    // Validation
    if (updates.listenMode && !['TRIGGER', 'FOLLOWUP', 'ALWAYS'].includes(updates.listenMode)) {
      throw new ValidationError('Invalid listen mode', { field: 'listenMode' });
    }
    
    if (updates.followupWindowMs && (updates.followupWindowMs < 1000 || updates.followupWindowMs > 60000)) {
      throw new ValidationError('Followup window must be between 1-60 seconds', { field: 'followupWindowMs' });
    }
    
    if (updates.quietHoursStart !== undefined && (updates.quietHoursStart < 0 || updates.quietHoursStart > 23)) {
      throw new ValidationError('Quiet hours start must be 0-23', { field: 'quietHoursStart' });
    }
    
    if (updates.quietHoursEnd !== undefined && (updates.quietHoursEnd < 0 || updates.quietHoursEnd > 23)) {
      throw new ValidationError('Quiet hours end must be 0-23', { field: 'quietHoursEnd' });
    }
    
    const preferences = await prisma.userPreference.upsert({
      where: { userId: req.user.id },
      update: updates,
      create: {
        userId: req.user.id,
        ...updates
      }
    });
    
    logger.info('User preferences updated', {
      userId: req.user.id,
      updates: Object.keys(updates)
    });
    
    res.json({
      ok: true,
      preferences
    });
  }));
  
  // PUT /preferences - Also support PUT for compatibility
  app.put('/preferences', requireAuth, asyncHandler(async (req, res) => {
    // Delegate to PATCH handler
    req.app._router.handle(Object.assign(req, { method: 'PATCH' }), res, () => {});
  }));
  
  // GET /memories - Get user memories (supports both cursor and offset pagination)
  app.get('/memories', requireAuth, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const cursor = req.query.cursor ? new Date(String(req.query.cursor)) : null;
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search;
    
    const where = { userId: req.user.id };
    if (search) {
      where.text = { contains: search, mode: 'insensitive' };
    }
    
    // Use cursor-based pagination if cursor is provided OR if no offset (Expo app format)
    if (cursor || (!cursor && !offset && !req.query.offset)) {
      const memories = await prisma.memory.findMany({
        where: cursor ? { AND: [where, { createdAt: { lt: cursor } }] } : where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1
      });
      
      const hasMore = memories.length > limit;
      const page = hasMore ? memories.slice(0, limit) : memories;
      const nextCursor = hasMore ? page[page.length - 1].createdAt.toISOString() : null;
      
      const items = page.map(m => ({
        id: m.id,
        text: m.text,
        createdAt: m.createdAt.toISOString()
      }));
      
      return res.json({
        ok: true,
        items,
        nextCursor
      });
    }
    
    // Use offset-based pagination (legacy)
    const [memories, total] = await Promise.all([
      prisma.memory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset
      }),
      prisma.memory.count({ where })
    ]);
    
    res.json({
      memories,
      total,
      limit,
      offset,
      hasMore: offset + memories.length < total
    });
  }));
  
  // POST /memories - Create a memory
  app.post('/memories', requireAuth, asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    if (!text) {
      throw new ValidationError('text is required');
    }
    
    const memory = await prisma.memory.create({
      data: {
        userId: req.user.id,
        text: text.trim()
      }
    });
    
    res.json({
      ok: true,
      memory: {
        id: memory.id,
        text: memory.text,
        createdAt: memory.createdAt
      }
    });
  }));
  
  // POST /memories/import/omi - Import memories from OMI
  app.post('/memories/import/omi', requireAuth, asyncHandler(async (req, res) => {
    // Find verified OMI links for this user
    const links = await prisma.omiUserLink.findMany({
      where: { 
        userId: req.user.id, 
        isVerified: true 
      },
      select: { omiUserId: true }
    });
    
    if (!links.length) {
      return res.status(404).json({ 
        error: 'No verified OMI link found. Please link your OMI device first.' 
      });
    }
    
    const pageLimit = Math.min(Number(req.body?.limit) || 1000, 1000);
    const maxTotal = Math.max(0, Math.min(Number(req.body?.max_total) || 0, 100000));
    
    let processed = 0;
    let imported = 0;
    let skipped = 0;
    
    // Helper function to call OMI API
    async function omiReadMemories({ uid, limit, offset }) {
      const axios = require('axios');
      const appId = config.getValue('omi.appId');
      const appSecret = config.getValue('omi.appSecret');
      
      if (!appId || !appSecret) {
        throw new Error('OMI API credentials not configured');
      }
      
      try {
        const response = await axios.get(`https://api.omi.me/memories`, {
          params: { uid, limit, offset },
          headers: {
            'X-App-Id': appId,
            'X-App-Secret': appSecret
          }
        });
        return response.data;
      } catch (error) {
        throw new Error(error.response?.data?.error || 'Failed to read memories from OMI');
      }
    }
    
    // Process each linked OMI device
    for (const link of links) {
      let offset = 0;
      let safetyCounter = 0;
      let done = false;
      
      // Paginate until fewer than pageLimit returned or safety cap reached
      while (safetyCounter < 100) {
        safetyCounter++;
        let result;
        
        try {
          result = await omiReadMemories({ 
            uid: link.omiUserId, 
            limit: pageLimit, 
            offset 
          });
        } catch (e) {
          logger.error('OMI memory import failed', {
            userId: req.user.id,
            omiUserId: link.omiUserId,
            error: e.message
          });
          return res.status(400).json({ 
            error: `OMI read failed: ${e.message}` 
          });
        }
        
        const items = (result && (result.memories || result.items)) || [];
        if (!items.length) break;
        
        for (const m of items) {
          if (maxTotal > 0 && processed >= maxTotal) {
            done = true;
            break;
          }
          processed++;
          
          try {
            const text = String(m?.content ?? m?.text ?? '').trim();
            if (!text) {
              skipped++;
              continue;
            }
            
            // Deduplicate on exact text per user
            const dupe = await prisma.memory.findFirst({
              where: { userId: req.user.id, text }
            });
            
            if (dupe) {
              skipped++;
              continue;
            }
            
            const createdAt = m?.created_at ? new Date(String(m.created_at)) : undefined;
            await prisma.memory.create({
              data: {
                userId: req.user.id,
                text,
                ...(createdAt ? { createdAt } : {})
              }
            });
            imported++;
          } catch (error) {
            logger.debug('Failed to import memory', {
              error: error.message,
              memory: m
            });
            skipped++;
          }
        }
        
        if (done) break;
        if (items.length < pageLimit) break;
        offset += items.length;
      }
      
      if (done) break;
    }
    
    logger.info('OMI memories imported', {
      userId: req.user.id,
      imported,
      skipped,
      processed
    });
    
    res.json({ 
      ok: true, 
      imported, 
      skipped 
    });
  }));
  
  // DELETE /memories/:id - Delete a memory
  app.delete('/memories/:id', requireAuth, asyncHandler(async (req, res) => {
    const memory = await prisma.memory.findFirst({
      where: {
        id: parseInt(req.params.id),
        userId: req.user.id
      }
    });
    
    if (!memory) {
      throw new NotFoundError('Memory', req.params.id);
    }
    
    await prisma.memory.delete({
      where: { id: memory.id }
    });
    
    logger.info('Memory deleted', {
      userId: req.user.id,
      memoryId: memory.id
    });
    
    res.json({ message: 'Memory deleted successfully' });
  }));
  
  // POST /sessions/link - Link an OMI session to the current user
  app.post('/sessions/link', requireAuth, asyncHandler(async (req, res) => {
    const { session_id } = req.body;
    
    if (!session_id) {
      return res.status(400).json({
        error: 'Validation failed',
        message: 'session_id is required'
      });
    }
    
    // Create or update the session to link it to this user
    const session = await prisma.omiSession.upsert({
      where: { omiSessionId: String(session_id) },
      update: {
        userId: req.user.id,
        lastSeenAt: new Date()
      },
      create: {
        omiSessionId: String(session_id),
        userId: req.user.id,
        lastSeenAt: new Date()
      }
    });
    
    logger.info('Session linked to user', {
      sessionId: session_id,
      userId: req.user.id
    });
    
    // Find any existing conversations for this session
    const conversations = await prisma.conversation.findMany({
      where: { omiSessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 1
    });
    
    res.json({
      ok: true,
      session: {
        id: session.omiSessionId,
        linked: true,
        hasConversations: conversations.length > 0
      }
    });
  }));
  
  // GET /conversations/current/stream - Server-Sent Events for live chat updates
  app.get('/conversations/current/stream', asyncHandler(async (req, res) => {
    // Handle auth from query param for EventSource compatibility
    const sid = req.query.sid || req.cookies.sid;
    if (!sid) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Verify session
    const session = await prisma.authSession.findUnique({
      where: { sessionToken: sid },
      include: { user: true }
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    
    const userId = session.userId;
    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable Nginx buffering
    });
    
    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    
    let lastMessageId = null;
    let currentConversationId = null;
    
    // Function to check for updates
    const checkForUpdates = async () => {
      try {
        // Find the most recent OMI session for this user
        const recentSession = await prisma.omiSession.findFirst({
          where: { userId: userId },
          orderBy: { lastSeenAt: 'desc' },
          include: {
            conversations: {
              orderBy: { createdAt: 'desc' },
              take: 1
            }
          }
        });
        
        const conversation = recentSession?.conversations?.[0];
        
        if (conversation) {
          // Check if conversation changed
          if (currentConversationId !== conversation.id) {
            currentConversationId = conversation.id;
            res.write(`data: ${JSON.stringify({ 
              type: 'conversation_changed', 
              conversationId: conversation.id 
            })}\n\n`);
          }
          
          // Get latest messages
          const messages = await prisma.message.findMany({
            where: { conversationId: conversation.id },
            orderBy: { createdAt: 'desc' },
            take: 5
          });
          
          if (messages.length > 0 && messages[0].id !== lastMessageId) {
            // New messages detected
            const newMessages = [];
            for (const msg of messages) {
              if (msg.id === lastMessageId) break;
              newMessages.push({
                id: msg.id,
                role: msg.role,
                text: msg.text,
                source: msg.source,
                createdAt: msg.createdAt.toISOString()
              });
            }
            
            if (newMessages.length > 0) {
              lastMessageId = messages[0].id;
              res.write(`data: ${JSON.stringify({ 
                type: 'new_messages', 
                messages: newMessages.reverse() 
              })}\n\n`);
            }
          }
        }
      } catch (error) {
        logger.error('SSE update check failed', { error: error.message });
      }
    };
    
    // Check for updates every 2 seconds
    const interval = setInterval(checkForUpdates, 2000);
    
    // Initial check
    checkForUpdates();
    
    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(interval);
      logger.debug('SSE connection closed', { userId: userId });
    });
  }));
  
  // GET /conversations/current - Get the current active conversation
  app.get('/conversations/current', requireAuth, asyncHandler(async (req, res) => {
    // First check if user has any linked OMI devices
    const omiLinks = await prisma.omiUserLink.findMany({
      where: { 
        userId: req.user.id,
        isVerified: true 
      },
      select: { omiUserId: true }
    });
    
    // Find the most recent conversation from any source
    let currentConversation = null;
    let sessionId = null;
    
    // Method 1: Find conversations directly linked to user
    currentConversation = await prisma.conversation.findFirst({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        omiSession: {
          select: { omiSessionId: true }
        }
      }
    });
    
    // Method 2: Find conversations from OMI sessions linked to user
    if (!currentConversation) {
      const recentSession = await prisma.omiSession.findFirst({
        where: { userId: req.user.id },
        orderBy: { lastSeenAt: 'desc' },
        include: {
          conversations: {
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      });
      
      if (recentSession?.conversations?.[0]) {
        currentConversation = recentSession.conversations[0];
        sessionId = recentSession.omiSessionId;
      }
    }
    
    // Method 3: Find conversations from linked OMI devices (via uid)
    if (!currentConversation && omiLinks.length > 0) {
      // Look for sessions that might be from linked devices
      const omiUserIds = omiLinks.map(l => l.omiUserId);
      
      // This would require tracking uid in conversations or sessions
      // For now, we'll look for any recent conversation activity
      const recentConversation = await prisma.conversation.findFirst({
        where: {
          omiSession: {
            userId: req.user.id
          }
        },
        orderBy: { createdAt: 'desc' },
        include: {
          omiSession: {
            select: { omiSessionId: true }
          }
        }
      });
      
      if (recentConversation) {
        currentConversation = recentConversation;
        sessionId = recentConversation.omiSession?.omiSessionId;
      }
    }
    
    if (!currentConversation) {
      // No conversation found, return empty
      return res.json({
        ok: true,
        conversation: null,
        sessionId: recentSession?.omiSessionId || null
      });
    }
    
    // Get recent messages for this conversation
    const messages = await prisma.message.findMany({
      where: { conversationId: currentConversation.id },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    
    res.json({
      ok: true,
      conversation: {
        id: currentConversation.id,
        title: currentConversation.title,
        summary: currentConversation.summary,
        createdAt: currentConversation.createdAt.toISOString(),
        openaiConversationId: currentConversation.openaiConversationId || null,
        omiSessionKey: currentConversation.omiSession?.omiSessionId || recentSession?.omiSessionId || null
      },
      messages: messages.reverse().map(msg => ({
        id: msg.id,
        role: msg.role,
        text: msg.text,
        source: msg.source,
        createdAt: msg.createdAt.toISOString()
      })),
      sessionId: recentSession?.omiSessionId || null
    });
  }));
  
  // GET /conversations - Get user conversations (Expo app format with cursor)
  app.get('/conversations', requireAuth, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const cursor = req.query.cursor ? new Date(String(req.query.cursor)) : null;
    
    const where = {
      OR: [
        { userId: req.user.id },
        { omiSession: { userId: req.user.id } }
      ]
    };
    
    const items = await prisma.conversation.findMany({
      where: cursor ? { AND: [where, { createdAt: { lt: cursor } }] } : where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        title: true,
        summary: true,
        createdAt: true,
        openaiConversationId: true,
        omiSession: { 
          select: { omiSessionId: true } 
        }
      }
    });
    
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? page[page.length - 1].createdAt.toISOString() : null;
    
    const mapped = page.map((item) => ({
      id: item.id, // Already a string UUID
      title: item.title,
      summary: item.summary,
      createdAt: item.createdAt.toISOString(),
      openaiConversationId: item.openaiConversationId || null,
      omiSessionKey: item.omiSession ? item.omiSession.omiSessionId : null
    }));
    
    res.json({
      ok: true,
      items: mapped,
      nextCursor
    });
  }));
  
  // GET /conversations/:id - Get conversation details
  app.get('/conversations/:id', requireAuth, asyncHandler(async (req, res) => {
    const conversationId = req.params.id; // Always use as string since IDs are UUIDs
    
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [
          { userId: req.user.id },
          { omiSession: { userId: req.user.id } }
        ]
      },
      include: {
        omiSession: {
          select: { omiSessionId: true }
        }
      }
    });
    
    if (!conversation) {
      throw new NotFoundError('Conversation', req.params.id);
    }
    
    res.json({
      ok: true,
      conversation: {
        id: conversation.id, // Already a string UUID
        title: conversation.title,
        summary: conversation.summary,
        createdAt: conversation.createdAt.toISOString(),
        openaiConversationId: conversation.openaiConversationId || null,
        omiSessionKey: conversation.omiSession ? conversation.omiSession.omiSessionId : null
      }
    });
  }));
  
  // GET /conversations/:id/messages - Get conversation messages
  app.get('/conversations/:id/messages', requireAuth, asyncHandler(async (req, res) => {
    const conversationId = req.params.id; // Always use as string since IDs are UUIDs
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const cursor = req.query.cursor || null; // Cursor is also a string (message ID)
    
    // Verify conversation belongs to user
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [
          { userId: req.user.id },
          { omiSession: { userId: req.user.id } }
        ]
      }
    });
    
    if (!conversation) {
      throw new NotFoundError('Conversation', req.params.id);
    }
    
    const where = { conversationId: conversation.id };
    const messages = await prisma.message.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      orderBy: { id: 'asc' }, // Order by ID for cursor pagination
      take: limit + 1
    });
    
    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? page[page.length - 1].id : null; // Already a string UUID
    
    const items = page.map(msg => ({
      id: msg.id, // Already a string UUID
      role: msg.role,
      text: msg.text,
      source: msg.source,
      createdAt: msg.createdAt.toISOString()
    }));
    
    res.json({
      ok: true,
      items,
      nextCursor
    });
  }));
  
  // POST /messages/send - Send a message
  app.post('/messages/send', requireAuth, asyncHandler(async (req, res) => {
    const { conversation_id, slot, text } = req.body;
    
    if (!text) {
      throw new ValidationError('text is required');
    }
    
    let conversationId = conversation_id; // Already a string UUID
    
    // If slot is provided, get conversation from that window
    if (slot && !conversationId) {
      const window = await prisma.userContextWindow.findUnique({
        where: {
          userId_slot: {
            userId: req.user.id,
            slot: parseInt(slot)
          }
        }
      });
      
      if (window) {
        conversationId = window.conversationId;
      }
    }
    
    // Create new conversation if needed
    if (!conversationId) {
      const newConv = await prisma.conversation.create({
        data: {
          userId: req.user.id,
          openaiConversationId: ''
        }
      });
      conversationId = newConv.id;
    }
    
    // Save user message
    await prisma.message.create({
      data: {
        conversationId,
        role: 'USER',
        text,
        source: 'FRONTEND'
      }
    });
    
    // TODO: Call OpenAI for response
    const assistantText = 'I received your message. The AI response feature is being implemented.';
    
    // Save assistant response
    await prisma.message.create({
      data: {
        conversationId,
        role: 'ASSISTANT',
        text: assistantText,
        source: 'SYSTEM'
      }
    });
    
    res.json({
      ok: true,
      conversation_id: conversationId, // Already a string
      assistant_text: assistantText
    });
  }));
  
  // GET /stats - Get user statistics
  app.get('/stats', requireAuth, asyncHandler(async (req, res) => {
    const [stats, recentActivity] = await Promise.all([
      // Overall stats
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          _count: {
            select: {
              memories: true,
              conversations: true,
              sessions: true,
              messages: true
            }
          }
        }
      }),
      // Recent activity
      prisma.message.findMany({
        where: {
          conversation: {
            OR: [
              { userId: req.user.id },
              { omiSession: { userId: req.user.id } }
            ]
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          role: true,
          createdAt: true,
          text: true
        }
      })
    ]);
    
    // Calculate daily stats for the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const dailyStats = await prisma.message.groupBy({
      by: ['createdAt'],
      where: {
        createdAt: { gte: sevenDaysAgo },
        conversation: {
          OR: [
            { userId: req.user.id },
            { omiSession: { userId: req.user.id } }
          ]
        }
      },
      _count: true
    });
    
    res.json({
      overall: stats._count,
      recentActivity,
      dailyStats: dailyStats.map(d => ({
        date: d.createdAt.toISOString().split('T')[0],
        count: d._count
      }))
    });
  }));
  
  logger.info('User routes initialized');
};