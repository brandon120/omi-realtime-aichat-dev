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
  
  // GET /memories - Get user memories
  app.get('/memories', requireAuth, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search;
    
    const where = { userId: req.user.id };
    if (search) {
      where.text = { contains: search, mode: 'insensitive' };
    }
    
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
  
  // GET /conversations - Get user conversations
  app.get('/conversations', requireAuth, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    
    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where: {
          OR: [
            { userId: req.user.id },
            { omiSession: { userId: req.user.id } }
          ]
        },
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1
          },
          _count: {
            select: { messages: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset
      }),
      prisma.conversation.count({
        where: {
          OR: [
            { userId: req.user.id },
            { omiSession: { userId: req.user.id } }
          ]
        }
      })
    ]);
    
    res.json({
      conversations: conversations.map(c => ({
        id: c.id,
        createdAt: c.createdAt,
        messageCount: c._count.messages,
        lastMessage: c.messages[0] || null
      })),
      total,
      limit,
      offset,
      hasMore: offset + conversations.length < total
    });
  }));
  
  // GET /conversations/:id - Get conversation details
  app.get('/conversations/:id', requireAuth, asyncHandler(async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: parseInt(req.params.id),
        OR: [
          { userId: req.user.id },
          { omiSession: { userId: req.user.id } }
        ]
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    
    if (!conversation) {
      throw new NotFoundError('Conversation', req.params.id);
    }
    
    res.json(conversation);
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