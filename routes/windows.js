'use strict';

const crypto = require('crypto');
const { 
  ValidationError, 
  NotFoundError,
  asyncHandler 
} = require('../utils/errors');
const { logger } = require('../services/logger');

/**
 * Context Windows and OMI Linking Routes
 * Handles conversation windows management and OMI device linking
 */
module.exports = function createWindowsRoutes({ app, prisma, config }) {
  if (!app) throw new Error('app is required');
  if (!prisma) throw new Error('prisma is required for windows routes');
  
  // Helper: Get session ID from request
  function getSidFromRequest(req) {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const match = authHeader.match(/^(Bearer|Sid)\s+(.+)$/i);
      if (match) return match[2];
    }
    if (req.signedCookies?.sid) {
      return req.signedCookies.sid;
    }
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
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      const session = await prisma.authSession.findUnique({
        where: { sessionToken: sid },
        include: { user: true }
      });
      
      if (!session) {
        return res.status(401).json({ error: 'Invalid session' });
      }
      
      if (session.expiresAt && session.expiresAt < new Date()) {
        await prisma.authSession.delete({ where: { sessionToken: sid } });
        return res.status(401).json({ error: 'Session expired' });
      }
      
      req.user = session.user;
      req.sessionId = session.sessionToken;
      next();
    } catch (error) {
      next(error);
    }
  }
  
  // Simple rate limiting for link endpoints
  const linkRateHistory = new Map();
  function linkThrottle(limit = 5, windowMs = 60 * 1000) {
    return (req, res, next) => {
      const key = req.user ? req.user.id : req.ip;
      const now = Date.now();
      const history = linkRateHistory.get(key) || [];
      const recent = history.filter(t => now - t < windowMs);
      
      if (recent.length >= limit) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      
      recent.push(now);
      linkRateHistory.set(key, recent);
      next();
    };
  }
  
  // GET /windows - List user's context windows
  app.get('/windows', requireAuth, asyncHandler(async (req, res) => {
    const windows = await prisma.userContextWindow.findMany({
      where: { userId: req.user.id },
      include: { 
        conversation: { 
          select: { 
            id: true,
            title: true, 
            summary: true, 
            createdAt: true 
          } 
        } 
      },
      orderBy: { slot: 'asc' }
    });
    
    // Ensure all 5 slots are represented
    const present = new Set(windows.map(w => w.slot));
    const list = [...windows];
    
    for (let slot = 1; slot <= 5; slot++) {
      if (!present.has(slot)) {
        list.push({
          slot,
          isActive: false,
          conversationId: null,
          conversation: null
        });
      }
    }
    
    // Sort by slot
    list.sort((a, b) => a.slot - b.slot);
    
    // Format response
    const items = list.map(w => ({
      slot: w.slot,
      isActive: w.isActive || false,
      conversationId: w.conversationId || null,
      title: w.conversation?.title || null,
      summary: w.conversation?.summary || null,
      createdAt: w.conversation?.createdAt || null
    }));
    
    logger.debug('Windows listed', {
      userId: req.user.id,
      windowCount: items.length
    });
    
    res.json({ ok: true, items });
  }));
  
  // POST /windows/activate - Activate a specific window slot
  app.post('/windows/activate', requireAuth, asyncHandler(async (req, res) => {
    const { slot } = req.body || {};
    const slotNum = Number(slot);
    
    if (!slotNum || slotNum < 1 || slotNum > 5) {
      throw new ValidationError('slot must be 1-5');
    }
    
    // Find or create window
    let contextWindow = await prisma.userContextWindow.findUnique({
      where: { 
        userId_slot: { 
          userId: req.user.id, 
          slot: slotNum 
        } 
      }
    });
    
    if (!contextWindow) {
      // Create new conversation for this window
      const conversation = await prisma.conversation.create({
        data: { 
          userId: req.user.id, 
          openaiConversationId: '' 
        }
      });
      
      contextWindow = await prisma.userContextWindow.create({
        data: { 
          userId: req.user.id, 
          slot: slotNum, 
          conversationId: conversation.id, 
          isActive: true 
        }
      });
    }
    
    // Deactivate all windows
    await prisma.userContextWindow.updateMany({
      where: { userId: req.user.id },
      data: { isActive: false }
    });
    
    // Activate the selected window
    await prisma.userContextWindow.update({
      where: { 
        userId_slot: { 
          userId: req.user.id, 
          slot: slotNum 
        } 
      },
      data: { isActive: true }
    });
    
    logger.info('Window activated', {
      userId: req.user.id,
      slot: slotNum
    });
    
    res.json({ ok: true, active_slot: slotNum });
  }));
  
  // POST /link/omi/start - Start OMI device linking
  app.post('/link/omi/start', requireAuth, linkThrottle(5, 60 * 1000), asyncHandler(async (req, res) => {
    const { omi_user_id } = req.body || {};
    const omiUserId = String(omi_user_id || '').trim();
    
    if (!omiUserId) {
      throw new ValidationError('omi_user_id is required');
    }
    
    // Check if already linked
    const existing = await prisma.omiUserLink.findUnique({
      where: { omiUserId }
    });
    
    if (existing && existing.isVerified) {
      if (existing.userId === req.user.id) {
        return res.json({ ok: true, already_linked: true });
      }
      return res.status(400).json({ error: 'This OMI device is already linked to another account' });
    }
    
    // Generate OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    // Upsert link record
    await prisma.omiUserLink.upsert({
      where: { omiUserId },
      update: {
        userId: req.user.id,
        otpCode,
        otpExpiry,
        otpAttempts: 0,
        isVerified: false
      },
      create: {
        omiUserId,
        userId: req.user.id,
        otpCode,
        otpExpiry,
        otpAttempts: 0,
        isVerified: false
      }
    });
    
    logger.info('OMI linking started', {
      userId: req.user.id,
      omiUserId
    });
    
    // In development, return the code for testing
    const response = { ok: true };
    if (config.getValue('env') === 'development') {
      response.dev_code = otpCode;
    }
    
    res.json(response);
  }));
  
  // POST /link/omi/confirm - Confirm OMI device linking with OTP
  app.post('/link/omi/confirm', requireAuth, linkThrottle(10, 60 * 1000), asyncHandler(async (req, res) => {
    const { omi_user_id, code } = req.body || {};
    const omiUserId = String(omi_user_id || '').trim();
    const inputCode = String(code || '').trim();
    
    if (!omiUserId || !inputCode) {
      throw new ValidationError('omi_user_id and code are required');
    }
    
    // Find link record
    const link = await prisma.omiUserLink.findUnique({
      where: { omiUserId }
    });
    
    if (!link) {
      return res.status(404).json({ error: 'No linking request found' });
    }
    
    if (link.userId !== req.user.id) {
      return res.status(403).json({ error: 'This linking request belongs to another user' });
    }
    
    if (link.isVerified) {
      return res.json({ ok: true, already_verified: true });
    }
    
    // Check OTP expiry
    if (link.otpExpiry && link.otpExpiry < new Date()) {
      return res.status(400).json({ error: 'OTP has expired' });
    }
    
    // Check attempts
    if (link.otpAttempts >= 5) {
      return res.status(429).json({ error: 'Too many attempts' });
    }
    
    // Increment attempts
    await prisma.omiUserLink.update({
      where: { omiUserId },
      data: { otpAttempts: link.otpAttempts + 1 }
    });
    
    // Verify code
    if (link.otpCode !== inputCode) {
      return res.status(400).json({ error: 'Invalid code' });
    }
    
    // Mark as verified
    await prisma.omiUserLink.update({
      where: { omiUserId },
      data: {
        isVerified: true,
        verifiedAt: new Date(),
        otpCode: null,
        otpExpiry: null
      }
    });
    
    logger.info('OMI device linked', {
      userId: req.user.id,
      omiUserId
    });
    
    res.json({ ok: true });
  }));
  
  // POST /link/omi/sync-conversations - Sync OMI conversations
  app.post('/link/omi/sync-conversations', requireAuth, asyncHandler(async (req, res) => {
    // Find verified OMI links for this user
    const links = await prisma.omiUserLink.findMany({
      where: { 
        userId: req.user.id, 
        isVerified: true 
      },
      select: { omiUserId: true }
    });
    
    if (links.length === 0) {
      return res.json({ 
        ok: true, 
        message: 'No verified OMI devices linked',
        synced: 0 
      });
    }
    
    // Find OMI sessions for these devices
    const omiUserIds = links.map(l => l.omiUserId);
    const sessions = await prisma.omiSession.findMany({
      where: {
        omiSessionId: { in: omiUserIds },
        userId: null // Not yet linked to user
      }
    });
    
    // Link sessions to user
    if (sessions.length > 0) {
      await prisma.omiSession.updateMany({
        where: {
          id: { in: sessions.map(s => s.id) }
        },
        data: { userId: req.user.id }
      });
    }
    
    // Also link any conversations
    const sessionIds = sessions.map(s => s.id);
    if (sessionIds.length > 0) {
      await prisma.conversation.updateMany({
        where: {
          omiSessionId: { in: sessionIds },
          userId: null
        },
        data: { userId: req.user.id }
      });
    }
    
    logger.info('OMI conversations synced', {
      userId: req.user.id,
      sessionCount: sessions.length
    });
    
    res.json({ 
      ok: true, 
      message: `Synced ${sessions.length} sessions`,
      synced: sessions.length 
    });
  }));
  
  // GET /spaces - Get available context spaces
  app.get('/spaces', requireAuth, asyncHandler(async (req, res) => {
    const spaces = ['default', 'todos', 'memories', 'tasks', 'agent', 'friends', 'notifications'];
    
    // Get active space from user preferences or default
    const pref = await prisma.userPreference.findUnique({
      where: { userId: req.user.id }
    });
    
    const activeSpace = pref?.activeSpace || 'default';
    
    res.json({
      ok: true,
      active: activeSpace,
      spaces
    });
  }));
  
  // POST /spaces/switch - Switch context space
  app.post('/spaces/switch', requireAuth, asyncHandler(async (req, res) => {
    const { space } = req.body || {};
    const validSpaces = ['default', 'todos', 'memories', 'tasks', 'agent', 'friends', 'notifications'];
    
    if (!space || !validSpaces.includes(space)) {
      throw new ValidationError(`Invalid space. Must be one of: ${validSpaces.join(', ')}`);
    }
    
    // Update user preference
    await prisma.userPreference.upsert({
      where: { userId: req.user.id },
      update: { activeSpace: space },
      create: { 
        userId: req.user.id, 
        activeSpace: space,
        listenMode: 'TRIGGER',
        followupWindowMs: 8000
      }
    });
    
    logger.info('Context space switched', {
      userId: req.user.id,
      space
    });
    
    res.json({ ok: true, active: space });
  }));
  
  logger.info('Windows and linking routes initialized');
};