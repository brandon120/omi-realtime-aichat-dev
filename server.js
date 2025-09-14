const express = require('express');
const https = require('https');
const OpenAI = require('openai');
require('dotenv').config();
const cookieParser = require('cookie-parser');
const argon2 = require('argon2');
const crypto = require('crypto');
 
const ENABLE_USER_SYSTEM = String(process.env.ENABLE_USER_SYSTEM || 'false').toLowerCase() === 'true';
let prisma = null;
if (ENABLE_USER_SYSTEM) {
  try {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    console.log('✅ Prisma initialized');
  } catch (e) {
    console.error('❌ Failed to initialize Prisma (user system disabled):', e.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Global middleware (must be registered before routes)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// CORS (allow Expo/web and configured origins)
const allowedOrigins = String(process.env.CORS_ORIGINS || 'http://localhost:8081')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Allow credentials so cookie-based auth works when enabled
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
if (ENABLE_USER_SYSTEM) {
  app.use(cookieParser(process.env.SESSION_SECRET || ''));
}

// --------- Typed messaging + read APIs (feature-flagged) ---------
if (ENABLE_USER_SYSTEM) {
  // Send a user message; create/use conversation by id or by slot
  app.post('/messages/send', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { conversation_id, slot, text } = req.body || {};
      const messageText = (text || '').toString().trim();
      if (!messageText) return res.status(400).json({ error: 'text is required' });

      let conversation = null;

      if (conversation_id) {
        // Ensure the conversation belongs to this user (directly or via linked OMI session)
        conversation = await prisma.conversation.findFirst({
          where: {
            id: String(conversation_id),
            OR: [
              { userId: req.user.id },
              { omiSession: { userId: req.user.id } }
            ]
          }
        });
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
      } else {
        const slotNum = Number(slot);
        if (!slotNum || slotNum < 1 || slotNum > 5) {
          return res.status(400).json({ error: 'Provide conversation_id or slot (1-5)' });
        }
        // Find or create a context window for this slot
        let context = await prisma.userContextWindow.findUnique({ where: { userId_slot: { userId: req.user.id, slot: slotNum } } });
        if (!context) {
          // Create a new conversation for this slot
          conversation = await prisma.conversation.create({ data: { userId: req.user.id, openaiConversationId: '' } });
          context = await prisma.userContextWindow.create({ data: { userId: req.user.id, slot: slotNum, conversationId: conversation.id, isActive: true } });
        } else {
          conversation = await prisma.conversation.findUnique({ where: { id: context.conversationId } });
          if (!conversation) {
            conversation = await prisma.conversation.create({ data: { userId: req.user.id, openaiConversationId: '' } });
            await prisma.userContextWindow.update({ where: { userId_slot: { userId: req.user.id, slot: slotNum } }, data: { conversationId: conversation.id } });
          }
        }
      }

      // Ensure an OpenAI conversation id exists for typed threads
      let openaiConvId = conversation.openaiConversationId;
      if (!openaiConvId) {
        try {
          const conv = await openai.conversations.create({ metadata: { typed_user_id: String(req.user.id), source: 'frontend' } });
          openaiConvId = conv.id;
          await prisma.conversation.update({ where: { id: conversation.id }, data: { openaiConversationId: openaiConvId } });
        } catch (e) {
          console.warn('Failed to create OpenAI conversation for typed flow:', e?.message || e);
        }
      }

      // Persist the user message first
      let userMessageRow = null;
      try {
        userMessageRow = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: 'USER',
            text: messageText,
            source: 'FRONTEND'
          }
        });
      } catch (err) {
        console.warn('Failed to persist user message:', err?.message || err);
      }

      // Call OpenAI; prefer Responses API with conversation
      let assistantText = '';
      try {
        const payload = { model: OPENAI_MODEL, input: messageText };
        if (openaiConvId) payload.conversation = openaiConvId;
        const response = await openai.responses.create(payload);
        assistantText = response.output_text;
      } catch (err) {
        console.warn('Responses API failed, fallback to chat:', err?.message || err);
        try {
          const chat = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: messageText }
            ],
            max_tokens: 600,
            temperature: 0.7
          });
          assistantText = chat.choices?.[0]?.message?.content || '';
        } catch (e2) {
          console.error('Fallback chat failed:', e2);
          assistantText = "I'm sorry, I'm having trouble responding right now.";
        }
      }

      // Persist assistant message
      try {
        const formatted = await formatTypedMessageWithLabelsAndFooter(req.user.id, assistantText);
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: 'ASSISTANT',
            text: formatted,
            source: 'SYSTEM'
          }
        });
      } catch (err) {
        console.warn('Failed to persist assistant message:', err?.message || err);
      }

      const responseText = await formatTypedMessageWithLabelsAndFooter(req.user.id, assistantText);
      res.status(200).json({ ok: true, conversation_id: conversation.id, assistant_text: responseText });
    } catch (e) {
      console.error('Send message error:', e);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // List conversations for the current user (includes those linked via OMI session)
  app.get('/conversations', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const limit = Math.min(Number(req.query.limit) || 20, 100);
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
        select: { id: true, title: true, summary: true, createdAt: true }
      });
      const hasMore = items.length > limit;
      const page = hasMore ? items.slice(0, limit) : items;
      const nextCursor = hasMore ? page[page.length - 1].createdAt.toISOString() : null;
      res.status(200).json({ ok: true, items: page, nextCursor });
    } catch (e) {
      console.error('List conversations error:', e);
      res.status(500).json({ error: 'Failed to list conversations' });
    }
  });

  // Get a single conversation (ownership enforced)
  app.get('/conversations/:id', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const id = String(req.params.id);
      const convo = await prisma.conversation.findFirst({
        where: { id, OR: [ { userId: req.user.id }, { omiSession: { userId: req.user.id } } ] },
        select: { id: true, title: true, summary: true, createdAt: true }
      });
      if (!convo) return res.status(404).json({ error: 'Not found' });
      res.status(200).json({ ok: true, conversation: convo });
    } catch (e) {
      console.error('Get conversation error:', e);
      res.status(500).json({ error: 'Failed to get conversation' });
    }
  });

  // List messages in a conversation
  app.get('/conversations/:id/messages', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const id = String(req.params.id);
      const owner = await prisma.conversation.findFirst({ where: { id, OR: [ { userId: req.user.id }, { omiSession: { userId: req.user.id } } ] }, select: { id: true } });
      if (!owner) return res.status(404).json({ error: 'Not found' });
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const cursor = req.query.cursor ? new Date(String(req.query.cursor)) : null;
      const where = { conversationId: id };
      const items = await prisma.message.findMany({
        where: cursor ? { AND: [where, { createdAt: { lt: cursor } }] } : where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        select: { id: true, role: true, text: true, source: true, createdAt: true }
      });
      const hasMore = items.length > limit;
      const page = hasMore ? items.slice(0, limit) : items;
      const nextCursor = hasMore ? page[page.length - 1].createdAt.toISOString() : null;
      res.status(200).json({ ok: true, items: page, nextCursor });
    } catch (e) {
      console.error('List messages error:', e);
      res.status(500).json({ error: 'Failed to list messages' });
    }
  });

  // Create follow-up item and send as notification to the user
  app.post('/followups', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { conversation_id, message } = req.body || {};
      const text = String(message || '').trim();
      if (!text) return res.status(400).json({ error: 'message is required' });

      let convo = null;
      if (conversation_id) {
        convo = await prisma.conversation.findFirst({
          where: { id: String(conversation_id), OR: [ { userId: req.user.id }, { omiSession: { userId: req.user.id } } ] },
          select: { id: true }
        });
        if (!convo) return res.status(404).json({ error: 'Conversation not found' });
      }

      // Persist notification event
      const event = await prisma.notificationEvent.create({
        data: {
          userId: req.user.id,
          channel: 'OMI',
          message: text,
          status: 'queued'
        }
      });

      // Attempt to send via OMI if linked
      let delivered = false;
      let errorMessage = null;
      try {
        const links = await prisma.omiUserLink.findMany({ where: { userId: req.user.id, isVerified: true }, select: { omiUserId: true } });
        if (links.length > 0) {
          for (const link of links) {
            try {
              await sendOmiNotification(link.omiUserId, text);
              delivered = true;
              break;
            } catch (e) {
              errorMessage = e?.message || String(e);
            }
          }
        } else {
          errorMessage = 'No verified OMI link';
        }
      } catch (e) {
        errorMessage = e?.message || String(e);
      }

      // Update event status
      try {
        await prisma.notificationEvent.update({ where: { id: event.id }, data: { status: delivered ? 'sent' : 'error', error: delivered ? null : errorMessage } });
      } catch {}

      res.status(200).json({ ok: true, delivered, followup_id: event.id, error: delivered ? null : errorMessage });
    } catch (e) {
      console.error('Followups API error:', e);
      res.status(500).json({ error: 'Failed to create follow-up' });
    }
  });
}
/**
 * Omi AI Chat Plugin Server
 * 
 * TRIGGER PHRASES: Users must start their message with one of these to activate the AI:
 * - "Hey Omi" (most common)
 * - "Hey, Omi" (with comma)
 * - "Hey Omi," (with trailing comma)
 * - "Hey, Omi," (with both commas)
 * - "Hey Jarvis" (Iron Man style)
 * - "Hey, Jarvis" (with comma)
 * - "Hey Jarvis," (with trailing comma)
 * - "Hey, Jarvis," (with both commas)
 * - "Hey Echo" (Amazon Alexa style)
 * - "Hey, Echo" (with comma)
 * - "Hey Echo," (with trailing comma)
 * - "Hey, Echo," (with both commas)
 * - "Hey Assistant" (Google Assistant style)
 * - "Hey, Assistant" (with comma)
 * - "Hey Assistant," (with trailing comma)
 * - "Hey, Assistant," (with both commas)
 * - "hey" (simple trigger)
 * 
 * HELP KEYWORDS: Users can ask for help using these words:
 * - "help", "what can you do", "how to use", "instructions", "guide"
 * - "what do you do", "how does this work", "what are the commands"
 * - "keywords", "trigger words", "how to talk to you"
 */

// duplicate initialization removed

// Session storage to accumulate transcript segments
const sessionTranscripts = new Map();
// Conversation state per Omi session (OpenAI conversation id)
const sessionConversations = new Map();
// Last processed question per session to prevent duplicate triggers
const lastProcessedQuestion = new Map();

// Context/state per Omi session
// space: default | todos | memories | tasks | agent | friends | notifications
// pending: { type: 'window_switch', options: Array<{num:number, slot:number, conversationId?:string, title?:string|null, summary?:string|null, createdAt?:string}> } | { type: 'space_switch' } | null
const sessionContextState = new Map();
const ALLOWED_SPACES = ['default', 'todos', 'memories', 'tasks', 'agent', 'friends', 'notifications'];

// Lightweight activation metrics
const activationCounters = {
  explicitTriggers: 0,
  suppressedDuplicates: 0,
  helpRequests: 0,
  menuOpens: 0,
  aiResponses: 0
};

function getOrInitSessionState(sessionId) {
  if (!sessionContextState.has(sessionId)) {
    sessionContextState.set(sessionId, { space: 'default', pending: null });
  }
  return sessionContextState.get(sessionId);
}

function formatMessageWithLabels(sessionId, content) {
  try {
    const now = new Date();
    const state = getOrInitSessionState(sessionId);
    const header = `[${now.toLocaleString()} • Space: ${state.space}]`;
    return `${header}\n${content}`;
  } catch {
    return content;
  }
}

async function findLinkedUserIdForSession(sessionId) {
  if (!ENABLE_USER_SYSTEM || !prisma) return null;
  try {
    const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(sessionId) } });
    return sessionRow && sessionRow.userId ? sessionRow.userId : null;
  } catch {
    return null;
  }
}

async function buildSpaceFooterForUser(userId, spaceName) {
  if (!ENABLE_USER_SYSTEM || !prisma || !userId) return '';
  const safeSpace = (spaceName || 'default');
  try {
    if (safeSpace === 'default') {
      const active = await prisma.userContextWindow.findFirst({
        where: { userId, isActive: true },
        include: { conversation: { select: { title: true, summary: true, createdAt: true } } }
      });
      if (!active) return 'Active window: none';
      const title = active.conversation?.title || 'Untitled';
      const summary = active.conversation?.summary ? ` — ${active.conversation.summary}` : '';
      return `Active window ${active.slot}: ${title}${summary}`.trim();
    }

    if (safeSpace === 'memories') {
      const memories = await prisma.memory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 3 });
      if (!memories.length) return 'No memories yet';
      return memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
    }

    if (safeSpace === 'notifications') {
      const events = await prisma.notificationEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 3 });
      if (!events.length) return 'No notifications';
      return events.map((e, i) => `${i + 1}. [${e.channel}] ${e.message} — ${e.status}`).join('\n');
    }

    if (safeSpace === 'tasks' || safeSpace === 'todos') {
      // Without a dedicated table, show recent agent events as tasks
      const events = await prisma.agentEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 3 });
      if (!events.length) return 'No tasks yet';
      return events.map((e, i) => `${i + 1}. ${e.type}${e.payload ? ' — ' + JSON.stringify(e.payload).slice(0, 80) : ''}`).join('\n');
    }

    if (safeSpace === 'agent') {
      const last = await prisma.agentEvent.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
      if (!last) return 'Agent idle';
      return `Last agent event: ${last.type}${last.payload ? ' — ' + JSON.stringify(last.payload).slice(0, 120) : ''}`;
    }

    if (safeSpace === 'friends') {
      // Not implemented: show OMI links as connected identities
      const links = await prisma.omiUserLink.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 3 });
      if (!links.length) return 'No friends connected';
      return links.map((l, i) => `${i + 1}. OMI:${l.omiUserId} — ${l.isVerified ? 'verified' : 'unverified'}`).join('\n');
    }

    return '';
  } catch {
    return '';
  }
}

async function buildSpaceFooterForSession(sessionId) {
  const userId = await findLinkedUserIdForSession(sessionId);
  const state = getOrInitSessionState(sessionId);
  if (!userId) return '';
  return buildSpaceFooterForUser(userId, state.space);
}

async function formatMessageWithFooter(sessionId, content, { includeHeader = true } = {}) {
  try {
    const headerWrapped = includeHeader ? formatMessageWithLabels(sessionId, content) : content;
    const footer = await buildSpaceFooterForSession(sessionId);
    if (footer && footer.length) {
      return `${headerWrapped}\n\n— Space Context (${getOrInitSessionState(sessionId).space}) —\n${footer}`;
    }
    return headerWrapped;
  } catch {
    return content;
  }
}

// User-level context space for typed flows
const userContextSpace = new Map(); // userId -> space
function getOrInitUserSpace(userId) {
  if (!userContextSpace.has(userId)) {
    userContextSpace.set(userId, 'default');
  }
  return userContextSpace.get(userId);
}
function formatTypedMessageWithLabels(userId, content) {
  try {
    const now = new Date();
    const space = getOrInitUserSpace(userId);
    const header = `[${now.toLocaleString()} • Space: ${space}]`;
    return `${header}\n${content}`;
  } catch {
    return content;
  }
}

async function formatTypedMessageWithLabelsAndFooter(userId, content) {
  try {
    const headerWrapped = formatTypedMessageWithLabels(userId, content);
    const space = getOrInitUserSpace(userId);
    const footer = await buildSpaceFooterForUser(userId, space);
    if (footer && footer.length) {
      return `${headerWrapped}\n\n— Space Context (${space}) —\n${footer}`;
    }
    return headerWrapped;
  } catch {
    return content;
  }
}

// Helpers for duplicate detection
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNearDuplicate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (longer.includes(shorter)) {
    return shorter.length / longer.length >= 0.9;
  }
  return false;
}

// Rate limiting for Omi notifications (max 10 per hour)
const notificationQueue = [];
const notificationHistory = new Map(); // Track notifications per user
const MAX_NOTIFICATIONS_PER_HOUR = 10;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

// Initialize OpenAI client (prefer OPENAI_API_KEY per latest SDK docs)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY,
});

// OpenAI Responses API configuration
const OPENAI_MODEL = "gpt-5-mini-2025-08-07"; // Smaller/cheaper, supports conversation state

// No need to create an assistant - Responses API handles everything
console.log('✅ Using OpenAI Responses API with Conversations');

/**
 * Sends a direct notification to an Omi user with rate limiting.
 * @param {string} userId - The Omi user's unique ID
 * @param {string} message - The notification text
 * @returns {Promise<object>} Response data or error
 */
async function sendOmiNotification(userId, message) {
    const appId = process.env.OMI_APP_ID;
    const appSecret = process.env.OMI_APP_SECRET;

    if (!appId) throw new Error("OMI_APP_ID not set");
    if (!appSecret) throw new Error("OMI_APP_SECRET not set");

    // Check rate limit for this user
    const now = Date.now();
    const userHistory = notificationHistory.get(userId) || [];
    
    // Remove notifications older than 1 hour
    const recentNotifications = userHistory.filter(timestamp => 
        now - timestamp < RATE_LIMIT_WINDOW
    );
    
    if (recentNotifications.length >= MAX_NOTIFICATIONS_PER_HOUR) {
        const oldestNotification = recentNotifications[0];
        const timeUntilReset = RATE_LIMIT_WINDOW - (now - oldestNotification);
        const minutesUntilReset = Math.ceil(timeUntilReset / (60 * 1000));
        
        throw new Error(`Rate limit exceeded. Maximum ${MAX_NOTIFICATIONS_PER_HOUR} notifications per hour. Try again in ${minutesUntilReset} minutes.`);
    }

    const options = {
        hostname: 'api.omi.me',
        path: `/v2/integrations/${appId}/notification?uid=${encodeURIComponent(userId)}&message=${encodeURIComponent(message)}`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${appSecret}`,
            'Content-Type': 'application/json',
            'Content-Length': 0
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        // Update rate limit tracking
                        if (!notificationHistory.has(userId)) {
                            notificationHistory.set(userId, []);
                        }
                        notificationHistory.get(userId).push(now);
                        
                        resolve(data ? JSON.parse(data) : {});
                    } catch (e) {
                        resolve({ raw: data });
                    }
                } else if (res.statusCode === 429) {
                    // Rate limit exceeded - update tracking and reject
                    if (!notificationHistory.has(userId)) {
                        notificationHistory.set(userId, []);
                    }
                    notificationHistory.get(userId).push(now);
                    
                    reject(new Error(`Rate limit exceeded. Maximum ${MAX_NOTIFICATIONS_PER_HOUR} notifications per hour.`));
                } else {
                    reject(new Error(`API Error (${res.statusCode}): ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ---- OMI API generic helper ----
function omiApiRequest(method, path, { query = {}, body = null } = {}) {
  const appId = process.env.OMI_APP_ID;
  const appSecret = process.env.OMI_APP_SECRET;
  if (!appId) throw new Error("OMI_APP_ID not set");
  if (!appSecret) throw new Error("OMI_APP_SECRET not set");

  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const options = {
    hostname: 'api.omi.me',
    path: `/v2/integrations/${appId}${path}${qs ? `?${qs}` : ''}`,
    method,
    headers: {
      'Authorization': `Bearer ${appSecret}`,
      'Content-Type': 'application/json',
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : {});
        } else {
          reject(new Error(`OMI API ${res.statusCode}: ${data || 'No body'}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---- OMI Import wrappers ----

// 1) Create Conversation
async function omiCreateConversation({ uid, text, started_at, finished_at, language, geolocation, text_source, text_source_spec }) {
  if (!uid) throw new Error('uid is required');
  if (!text) throw new Error('text is required');

  const body = {
    text,
    ...(started_at && { started_at }),
    ...(finished_at && { finished_at }),
    ...(language && { language }),
    ...(geolocation && { geolocation }), // { latitude, longitude }
    ...(text_source && { text_source }), // "audio_transcript" | "message" | "other_text"
    ...(text_source_spec && { text_source_spec })
  };

  return omiApiRequest('POST', `/user/conversations`, { query: { uid }, body });
}

// 2) Create Memories
async function omiCreateMemories({ uid, text, text_source, text_source_spec, memories }) {
  if (!uid) throw new Error('uid is required');
  if (!text && (!memories || !memories.length)) {
    throw new Error('Either text or memories[] is required');
  }

  const body = {
    ...(text && { text }),
    ...(text_source && { text_source }),        // "email" | "social_post" | "other"
    ...(text_source_spec && { text_source_spec }),
    ...(memories && memories.length ? { memories } : {})
  };

  return omiApiRequest('POST', `/user/memories`, { query: { uid }, body });
}

// 3) Read Conversations
async function omiReadConversations({ uid, limit = 100, offset = 0, include_discarded = false, statuses }) {
  if (!uid) throw new Error('uid is required');
  return omiApiRequest('GET', `/conversations`, {
    query: { uid, limit, offset, include_discarded, ...(statuses ? { statuses } : {}) }
  });
}

// 4) Read Memories
async function omiReadMemories({ uid, limit = 100, offset = 0 }) {
  if (!uid) throw new Error('uid is required');
  return omiApiRequest('GET', `/memories`, { query: { uid, limit, offset } });
}

/**
 * Gets the current rate limit status for a user
 * @param {string} userId - The Omi user's unique ID
 * @returns {object} Rate limit information
 */
function getRateLimitStatus(userId) {
    const now = Date.now();
    const userHistory = notificationHistory.get(userId) || [];
    const recentNotifications = userHistory.filter(timestamp => 
        now - timestamp < RATE_LIMIT_WINDOW
    );
    
    const remainingNotifications = MAX_NOTIFICATIONS_PER_HOUR - recentNotifications.length;
    const timeUntilReset = recentNotifications.length > 0 ? 
        RATE_LIMIT_WINDOW - (now - recentNotifications[0]) : 0;
    
    return {
        remaining: Math.max(0, remainingNotifications),
        used: recentNotifications.length,
        limit: MAX_NOTIFICATIONS_PER_HOUR,
        timeUntilReset: Math.ceil(timeUntilReset / (60 * 1000)), // minutes
        isLimited: remainingNotifications <= 0
    };
}

// Conversation state is managed via OpenAI Conversations API per session

// (moved to top) Global middleware

// --------- Auth helpers (feature-flagged) ---------
function getCookieOptions() {
  const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  // 30 days
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    signed: !!(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length > 0)
  };
}

async function createSession(prismaClient, userId) {
  const { nanoid } = await import('nanoid');
  const token = nanoid(64);
  const expiresAt = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000));
  await prismaClient.authSession.create({
    data: {
      userId,
      sessionToken: token,
      expiresAt
    }
  });
  return { token, expiresAt };
}

async function getSession(prismaClient, token) {
  if (!token) return null;
  const session = await prismaClient.authSession.findUnique({ where: { sessionToken: token } });
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < new Date()) {
    // Expired: cleanup
    try { await prismaClient.authSession.delete({ where: { sessionToken: token } }); } catch {}
    return null;
  }
  return session;
}

function getSidFromRequest(req) {
  // Prefer Authorization header: "Bearer <sid>" or "Sid <sid>"
  try {
    const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (authHeader && typeof authHeader === 'string') {
      const parts = authHeader.split(' ');
      if (parts.length === 2) {
        const scheme = parts[0].toLowerCase();
        const token = parts[1];
        if ((scheme === 'bearer' || scheme === 'sid') && token) {
          return token;
        }
      }
    }
  } catch {}

  // Fallback to cookie
  const signedSid = req.signedCookies ? req.signedCookies.sid : undefined;
  const plainSid = req.cookies ? req.cookies.sid : undefined;
  return signedSid || plainSid;
}

// ---- Linking helpers (feature-flagged) ----
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OTP_ATTEMPTS = 5;

function generateOtpCode() {
  const num = Math.floor(Math.random() * 1000000);
  return String(num).padStart(6, '0');
}

// Simple in-memory throttle for /link/*
const linkRateHistory = new Map();
function linkThrottle(limit = 5, windowMs = 60 * 1000) {
  return (req, res, next) => {
    const keyBase = (req.user && req.user.id) ? `u:${req.user.id}` : `ip:${req.ip}`;
    const key = `${keyBase}:${req.path}`;
    const now = Date.now();
    const history = linkRateHistory.get(key) || [];
    const recent = history.filter((ts) => now - ts < windowMs);
    if (recent.length >= limit) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    recent.push(now);
    linkRateHistory.set(key, recent);
    next();
  };
}

function requireAuth(req, res, next) {
  if (!ENABLE_USER_SYSTEM || !prisma) return res.status(503).json({ error: 'User system disabled' });
  const sid = getSidFromRequest(req);
  if (!sid) return res.status(401).json({ error: 'Not authenticated' });
  getSession(prisma, sid)
    .then(async (session) => {
      if (!session) return res.status(401).json({ error: 'Session invalid' });
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) return res.status(401).json({ error: 'User not found' });
      req.user = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
      req.session = { token: session.sessionToken, expiresAt: session.expiresAt };
      next();
    })
    .catch((e) => {
      console.error('Auth middleware error:', e);
      res.status(500).json({ error: 'Auth middleware error' });
    });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Omi AI Chat Plugin is running',
    trigger_phrases: [
      'Hey Omi', 'Hey, Omi', 'Hey Omi,', 'Hey, Omi,'
    ],
    help_keywords: [
      'help', 'what can you do', 'how to use', 'instructions', 'guide',
      'what do you do', 'how does this work', 'what are the commands',
      'keywords', 'trigger words', 'how to talk to you'
    ],
    example_usage: 'Hey Omi, what is the weather like in Sydney, Australia?',
    rate_limiting: {
      max_notifications_per_hour: MAX_NOTIFICATIONS_PER_HOUR,
      active_users: notificationHistory.size,
      note: 'Check /rate-limit/:userId for specific user status'
    },
    api: {
      type: 'OpenAI Responses API',
      model: OPENAI_MODEL,
      conversation_state: 'enabled (server-managed conversation id per Omi session)',
      tools: ['web_search']
    }
  });
});

// DB health endpoint (feature-flagged)
if (ENABLE_USER_SYSTEM) {
  app.get('/health/db', async (req, res) => {
    try {
      if (!prisma) return res.status(500).json({ ok: false, error: 'Prisma not initialized' });
      await prisma.$queryRaw`SELECT 1 as ok`;
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

// Help endpoint
app.get('/help', (req, res) => {
  res.status(200).json({
    title: 'Omi AI Chat Plugin - How to Use',
    description: 'Learn how to interact with the Omi AI assistant',
    trigger_phrases: {
      description: 'Start your message with one of these phrases to activate the AI:',
      phrases: [
        'Hey Omi', 'Hey, Omi', 'Hey Omi,', 'Hey, Omi,'
      ]
    },
    examples: [
      'Hey Omi, what is the weather like in Sydney, Australia?',
      'Hey Omi, can you help me solve a math problem?',
      'Hey Omi, what are the latest news headlines?'
    ],
    help_keywords: {
      description: 'You can also ask for help using these words:',
      keywords: [
        'help', 'what can you do', 'how to use', 'instructions', 'guide',
        'what do you do', 'how does this work', 'what are the commands',
        'keywords', 'trigger words', 'how to talk to you'
      ]
    },
    note: 'The AI will only respond when you use the "Hey Omi" trigger phrases.',
    features: {
      web_search: 'Built-in web search for current information',
      natural_language: 'Understands natural conversation patterns',
      rate_limiting: 'Smart rate limiting to prevent API errors'
    }
  });
});

// --------- Auth routes (feature-flagged) ---------
if (ENABLE_USER_SYSTEM) {
  // Register
  app.post('/auth/register', async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { email, password, display_name } = req.body || {};
      const normalizedEmail = (email || '').toString().trim().toLowerCase();
      if (!normalizedEmail || !password || password.length < 8) {
        return res.status(400).json({ error: 'Invalid email or password too short' });
      }
      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) return res.status(400).json({ error: 'Email already in use' });
      const passwordHash = await argon2.hash(password);
      const user = await prisma.user.create({
        data: { email: normalizedEmail, passwordHash, displayName: display_name || null }
      });
      const { token } = await createSession(prisma, user.id);
      res.cookie('sid', token, getCookieOptions());
      res.status(201).json({ ok: true, session_token: token, user: { id: user.id, email: user.email, displayName: user.displayName } });
    } catch (e) {
      console.error('Register error:', e);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // Login
  app.post('/auth/login', async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { email, password } = req.body || {};
      const normalizedEmail = (email || '').toString().trim().toLowerCase();
      if (!normalizedEmail || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      const valid = await argon2.verify(user.passwordHash, password);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      const { token } = await createSession(prisma, user.id);
      res.cookie('sid', token, getCookieOptions());
      res.status(200).json({ ok: true, session_token: token, user: { id: user.id, email: user.email, displayName: user.displayName } });
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Logout
  app.post('/auth/logout', async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const sid = getSidFromRequest(req);
      if (sid) {
        try { await prisma.authSession.delete({ where: { sessionToken: sid } }); } catch {}
      }
      res.clearCookie('sid', getCookieOptions());
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Logout error:', e);
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  // Current user
  app.get('/me', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const links = await prisma.omiUserLink.findMany({
        where: { userId: req.user.id },
        select: { omiUserId: true, isVerified: true, verifiedAt: true }
      });
      res.status(200).json({ ok: true, user: req.user, omi_links: links });
    } catch (e) {
      console.error('Me endpoint error:', e);
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });
}

// --------- Account management routes (feature-flagged) ---------
if (ENABLE_USER_SYSTEM) {
  // Profile: read
  app.get('/account/profile', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, email: true, displayName: true, role: true, createdAt: true, updatedAt: true }
      });
      res.status(200).json({ ok: true, user });
    } catch (e) {
      console.error('Profile read error:', e);
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });

  // Profile: update display name and/or email (email change requires current password)
  app.patch('/account/profile', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { display_name, email, current_password } = req.body || {};
      const updates = {};

      if (typeof display_name !== 'undefined') {
        const trimmed = String(display_name || '').trim();
        updates.displayName = trimmed.length > 0 ? trimmed : null;
      }

      if (typeof email !== 'undefined') {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (!normalizedEmail) return res.status(400).json({ error: 'Email cannot be empty' });
        // Verify password before allowing email change
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!current_password) return res.status(400).json({ error: 'current_password is required to change email' });
        const ok = await argon2.verify(user.passwordHash, String(current_password));
        if (!ok) return res.status(401).json({ error: 'Invalid current password' });
        // Ensure the email is unique
        const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (existing && existing.id !== req.user.id) {
          return res.status(400).json({ error: 'Email already in use' });
        }
        updates.email = normalizedEmail;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No changes provided' });
      }

      const updated = await prisma.user.update({ where: { id: req.user.id }, data: updates, select: { id: true, email: true, displayName: true, role: true, createdAt: true, updatedAt: true } });
      res.status(200).json({ ok: true, user: updated });
    } catch (e) {
      console.error('Profile update error:', e);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  // Password change
  app.post('/account/password', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { current_password, new_password } = req.body || {};
      if (!current_password || !new_password) return res.status(400).json({ error: 'current_password and new_password are required' });
      if (String(new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user) return res.status(404).json({ error: 'User not found' });
      const valid = await argon2.verify(user.passwordHash, String(current_password));
      if (!valid) return res.status(401).json({ error: 'Invalid current password' });

      const newHash = await argon2.hash(String(new_password));
      await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: newHash } });

      // Revoke all other sessions optionally
      await prisma.authSession.deleteMany({ where: { userId: req.user.id, sessionToken: { not: req.session.token } } });
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Password change error:', e);
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  // Sessions: list
  app.get('/account/sessions', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const sessions = await prisma.authSession.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' }
      });
      const items = sessions.map((s) => ({
        session_token_masked: `${s.sessionToken.slice(0, 8)}...${s.sessionToken.slice(-4)}`,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        is_current: s.sessionToken === (req.session && req.session.token)
      }));
      res.status(200).json({ ok: true, sessions: items });
    } catch (e) {
      console.error('Sessions list error:', e);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // Sessions: revoke a specific session by token
  app.post('/account/sessions/revoke', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { session_token } = req.body || {};
      const token = String(session_token || '').trim();
      if (!token) return res.status(400).json({ error: 'session_token is required' });

      const session = await prisma.authSession.findUnique({ where: { sessionToken: token } });
      if (!session || session.userId !== req.user.id) return res.status(404).json({ error: 'Session not found' });
      await prisma.authSession.delete({ where: { sessionToken: token } });
      if (req.session && req.session.token === token) {
        res.clearCookie('sid', getCookieOptions());
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Session revoke error:', e);
      res.status(500).json({ error: 'Failed to revoke session' });
    }
  });

  // Sessions: revoke all except current
  app.post('/account/sessions/revoke-others', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const current = req.session ? req.session.token : null;
      await prisma.authSession.deleteMany({ where: { userId: req.user.id, ...(current ? { sessionToken: { not: current } } : {}) } });
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Revoke other sessions error:', e);
      res.status(500).json({ error: 'Failed to revoke sessions' });
    }
  });

  // Delete account
  app.delete('/account', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { current_password } = req.body || {};
      if (!current_password) return res.status(400).json({ error: 'current_password is required' });
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user) return res.status(404).json({ error: 'User not found' });
      const valid = await argon2.verify(user.passwordHash, String(current_password));
      if (!valid) return res.status(401).json({ error: 'Invalid current password' });

      // Delete cascades to related rows due to Prisma relations
      await prisma.user.delete({ where: { id: req.user.id } });
      res.clearCookie('sid', getCookieOptions());
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Account delete error:', e);
      res.status(500).json({ error: 'Failed to delete account' });
    }
  });
}

// --------- OMI linking routes (feature-flagged) ---------
if (ENABLE_USER_SYSTEM) {
  // Spaces & Windows management
  app.get('/spaces', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const currentSpace = getOrInitUserSpace(req.user.id);
      res.status(200).json({ ok: true, active: currentSpace, spaces: ALLOWED_SPACES });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read spaces' });
    }
  });

  app.post('/spaces/switch', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { space } = req.body || {};
      const name = String(space || '').toLowerCase().trim();
      if (!ALLOWED_SPACES.includes(name)) return res.status(400).json({ error: 'Invalid space' });
      userContextSpace.set(req.user.id, name);
      res.status(200).json({ ok: true, active: name });
    } catch (e) {
      res.status(500).json({ error: 'Failed to switch space' });
    }
  });

  app.get('/windows', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const windows = await prisma.userContextWindow.findMany({
        where: { userId: req.user.id },
        include: { conversation: { select: { title: true, summary: true, createdAt: true } } },
        orderBy: { slot: 'asc' }
      });
      const present = new Set(windows.map(w => w.slot));
      const list = [...windows];
      for (let s = 1; s <= 5; s++) {
        if (!present.has(s)) list.push({ slot: s, isActive: false, conversationId: '', userId: req.user.id, id: '', createdAt: new Date(), conversation: null });
      }
      list.sort((a, b) => a.slot - b.slot);
      const items = list.map(w => ({ slot: w.slot, isActive: !!w.isActive, title: w.conversation?.title || null, summary: w.conversation?.summary || null }));
      res.status(200).json({ ok: true, items });
    } catch (e) {
      res.status(500).json({ error: 'Failed to list windows' });
    }
  });

  app.post('/windows/activate', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { slot } = req.body || {};
      const s = Number(slot);
      if (!s || s < 1 || s > 5) return res.status(400).json({ error: 'slot must be 1-5' });
      let contextWindow = await prisma.userContextWindow.findUnique({ where: { userId_slot: { userId: req.user.id, slot: s } } });
      if (!contextWindow) {
        const conversation = await prisma.conversation.create({ data: { userId: req.user.id, openaiConversationId: '' } });
        contextWindow = await prisma.userContextWindow.create({ data: { userId: req.user.id, slot: s, conversationId: conversation.id, isActive: true } });
      }
      await prisma.userContextWindow.updateMany({ where: { userId: req.user.id }, data: { isActive: false } });
      await prisma.userContextWindow.update({ where: { userId_slot: { userId: req.user.id, slot: s } }, data: { isActive: true } });
      res.status(200).json({ ok: true, active_slot: s });
    } catch (e) {
      res.status(500).json({ error: 'Failed to activate window' });
    }
  });

  // Start linking: generate OTP and send notification
  app.post('/link/omi/start', requireAuth, linkThrottle(5, 60 * 1000), async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { omi_user_id } = req.body || {};
      const omiUserId = (omi_user_id || '').toString().trim();
      if (!omiUserId) return res.status(400).json({ error: 'omi_user_id is required' });

      const code = generateOtpCode();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);

      const link = await prisma.omiUserLink.upsert({
        where: { omiUserId },
        update: { userId: req.user.id, verificationCode: code, verificationExpiresAt: expiresAt, verificationAttempts: 0, isVerified: false },
        create: { userId: req.user.id, omiUserId, verificationCode: code, verificationExpiresAt: expiresAt }
      });

      try {
        await sendOmiNotification(omiUserId, `Your verification code is ${code}. It expires in 10 minutes.`);
      } catch (notifyErr) {
        console.warn('Failed to send OMI notification, returning code for dev:', notifyErr?.message || notifyErr);
      }

      const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
      res.status(200).json({ ok: true, omi_user_id: omiUserId, ...(isProduction ? {} : { dev_code: code }) });
    } catch (e) {
      console.error('Link start error:', e);
      res.status(500).json({ error: 'Failed to start OMI linking' });
    }
  });

  // Confirm linking: verify OTP
  app.post('/link/omi/confirm', requireAuth, linkThrottle(10, 60 * 1000), async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { omi_user_id, code, omi_session_id } = req.body || {};
      const omiUserId = (omi_user_id || '').toString().trim();
      const inputCode = (code || '').toString().trim();
      if (!omiUserId || !inputCode) return res.status(400).json({ error: 'omi_user_id and code are required' });

      const link = await prisma.omiUserLink.findUnique({ where: { omiUserId } });
      if (!link || link.userId !== req.user.id) return res.status(404).json({ error: 'Link request not found' });
      if (link.isVerified) return res.status(200).json({ ok: true, already_verified: true });
      if (link.verificationAttempts >= MAX_OTP_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts' });
      if (!link.verificationCode || !link.verificationExpiresAt || link.verificationExpiresAt < new Date()) {
        return res.status(400).json({ error: 'Verification code expired, please restart' });
      }

      const isValid = inputCode === link.verificationCode;
      if (!isValid) {
        await prisma.omiUserLink.update({
          where: { omiUserId },
          data: { verificationAttempts: { increment: 1 } }
        });
        return res.status(401).json({ error: 'Invalid code' });
      }

      await prisma.omiUserLink.update({
        where: { omiUserId },
        data: {
          isVerified: true,
          verifiedAt: new Date(),
          verificationCode: null,
          verificationExpiresAt: null,
          verificationAttempts: 0
        }
      });

      // Optionally attach an active OMI session id to this user
      try {
        const osid = (omi_session_id || '').toString().trim();
        if (osid) {
          await prisma.omiSession.upsert({
            where: { omiSessionId: osid },
            update: { userId: req.user.id, lastSeenAt: new Date() },
            create: { omiSessionId: osid, userId: req.user.id }
          });
        }
      } catch (attachErr) {
        console.warn('Failed to upsert/attach OmiSession on confirm:', attachErr?.message || attachErr);
      }

      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Link confirm error:', e);
      res.status(500).json({ error: 'Failed to confirm OMI linking' });
    }
  });

  // List links
  app.get('/link/omi', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const links = await prisma.omiUserLink.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        select: { omiUserId: true, isVerified: true, verifiedAt: true, createdAt: true }
      });
      res.status(200).json({ ok: true, items: links });
    } catch (e) {
      console.error('Link list error:', e);
      res.status(500).json({ error: 'Failed to list OMI links' });
    }
  });

  // Resend verification code (regenerate with fresh TTL)
  app.post('/link/omi/resend', requireAuth, linkThrottle(5, 60 * 1000), async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const { omi_user_id } = req.body || {};
      const omiUserId = String(omi_user_id || '').trim();
      if (!omiUserId) return res.status(400).json({ error: 'omi_user_id is required' });

      const link = await prisma.omiUserLink.findUnique({ where: { omiUserId } });
      if (!link || link.userId !== req.user.id) return res.status(404).json({ error: 'Link not found' });
      if (link.isVerified) return res.status(400).json({ error: 'Already verified' });

      const code = generateOtpCode();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);
      await prisma.omiUserLink.update({
        where: { omiUserId },
        data: { verificationCode: code, verificationExpiresAt: expiresAt, verificationAttempts: 0 }
      });

      try {
        await sendOmiNotification(omiUserId, `Your verification code is ${code}. It expires in 10 minutes.`);
      } catch (notifyErr) {
        console.warn('Failed to resend OMI notification, returning code for dev:', notifyErr?.message || notifyErr);
      }

      const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
      res.status(200).json({ ok: true, omi_user_id: omiUserId, ...(isProduction ? {} : { dev_code: code }) });
    } catch (e) {
      console.error('Link resend error:', e);
      res.status(500).json({ error: 'Failed to resend verification code' });
    }
  });

  // Unlink
  app.delete('/link/omi/unlink/:omi_user_id?', requireAuth, async (req, res) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'User system disabled' });
      const paramId = req.params.omi_user_id ? String(req.params.omi_user_id).trim() : '';
      const bodyId = req.body && req.body.omi_user_id ? String(req.body.omi_user_id).trim() : '';
      const omiUserId = paramId || bodyId;
      if (!omiUserId) return res.status(400).json({ error: 'omi_user_id is required' });

      const link = await prisma.omiUserLink.findUnique({ where: { omiUserId } });
      if (!link || link.userId !== req.user.id) return res.status(404).json({ error: 'Link not found' });
      await prisma.omiUserLink.delete({ where: { omiUserId } });
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Link unlink error:', e);
      res.status(500).json({ error: 'Failed to unlink OMI account' });
    }
  });
}
// Rate limit status endpoint
app.get('/rate-limit/:userId', (req, res) => {
  const { userId } = req.params;
  const status = getRateLimitStatus(userId);
  
  res.status(200).json({
    user_id: userId,
    rate_limit: status,
    message: status.isLimited ? 
      `Rate limited. Try again in ${status.timeUntilReset} minutes.` :
      `${status.remaining} notifications remaining this hour.`
  });
});

// Activation metrics (no auth; informational only)
app.get('/metrics/activation', (req, res) => {
  res.status(200).json({ ok: true, counters: activationCounters });
});

// ---- OMI Import REST endpoints ----

// Create Conversation
app.post('/omi/import/conversation', async (req, res) => {
  try {
    const result = await omiCreateConversation(req.body);
    res.status(200).json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Create Memories
app.post('/omi/import/memories', async (req, res) => {
  try {
    const result = await omiCreateMemories(req.body);
    res.status(200).json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Read Conversations
app.get('/omi/import/conversations', async (req, res) => {
  try {
    const result = await omiReadConversations(req.query);
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Read Memories
app.get('/omi/import/memories', async (req, res) => {
  try {
    const result = await omiReadMemories(req.query);
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Main Omi webhook endpoint
app.post('/omi-webhook', async (req, res) => {
  try {
    console.log('📥 Received webhook from Omi:', JSON.stringify(req.body, null, 2));
    
    const { session_id, segments } = req.body;
    
    // Validate required fields
    if (!session_id || !segments || !Array.isArray(segments)) {
      console.error('❌ Missing required fields:', { session_id, segments });
      return res.status(400).json({ 
        error: 'Missing required fields: session_id and segments array are required' 
      });
    }
    
    // Accumulate transcript segments for this session
    if (!sessionTranscripts.has(session_id)) {
      sessionTranscripts.set(session_id, []);
    }
    
    // Add new segments to the session
    const sessionSegments = sessionTranscripts.get(session_id);
    sessionSegments.push(...segments);
    
    // Extract all text from accumulated segments and join them
    const fullTranscript = sessionSegments
      .map(segment => segment.text)
      .join(' ')
      .trim();
    
    console.log('📝 Accumulated transcript for session:', fullTranscript);
    console.log('📊 Total segments in session:', sessionSegments.length);
    
    // Voice OTP verification flow (feature-flagged)
    if (ENABLE_USER_SYSTEM && prisma) {
      try {
        // Look for patterns like: "verify 123456" (case-insensitive, allows extra words before/after)
        const verifyMatch = fullTranscript.match(/\bverify\s+(\d{6})\b/i);
        if (verifyMatch) {
          const spokenCode = verifyMatch[1];
          // Find pending link by code (unique enough for short TTL); newest wins if multiple
          const link = await prisma.omiUserLink.findFirst({
            where: { isVerified: false, verificationCode: spokenCode, verificationExpiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' }
          });
          if (link) {
            if (link.verificationAttempts >= MAX_OTP_ATTEMPTS) {
              sessionTranscripts.delete(session_id);
              return res.status(200).json({ message: 'Too many attempts. Please request a new code.' });
            }
            // Mark verified
            await prisma.omiUserLink.update({
              where: { omiUserId: link.omiUserId },
              data: {
                isVerified: true,
                verifiedAt: new Date(),
                verificationCode: null,
                verificationExpiresAt: null,
                verificationAttempts: 0
              }
            });
            // Attach active Omi session to this user
            try {
              await prisma.omiSession.upsert({
                where: { omiSessionId: String(session_id) },
                update: { userId: link.userId, lastSeenAt: new Date() },
                create: { omiSessionId: String(session_id), userId: link.userId }
              });
            } catch (attachErr) {
              console.warn('Failed to upsert/attach OmiSession:', attachErr?.message || attachErr);
            }
            sessionTranscripts.delete(session_id);
            return res.status(200).json({ message: 'Verification successful. Your account is now linked.' });
          } else {
            // Increment attempts for any active links to gently rate-limit guessing (best-effort)
            try {
              await prisma.omiUserLink.updateMany({
                where: { isVerified: false, verificationCode: spokenCode, verificationExpiresAt: { gt: new Date() } },
                data: { verificationAttempts: { increment: 1 } }
              });
            } catch {}
            sessionTranscripts.delete(session_id);
            return res.status(200).json({ message: 'That code was not recognized. Please try again.' });
          }
        }
      } catch (voiceErr) {
        console.warn('Voice verification check failed:', voiceErr?.message || voiceErr);
        // continue to normal handling
      }
    }
    
    // Context-gated AI activation: allow more forgiving triggers anywhere in a segment
    const activationRegex = /(?:^|\b)(?:\s*(hey|ok|yo|hi|hello)\s*,?\s*)?(omi|jarvis|echo|assistant)\b[,:\-\s]*/i;
    let activationFoundIndex = -1;
    let question = '';
    for (let i = 0; i < sessionSegments.length; i++) {
      const seg = sessionSegments[i];
      if (typeof seg.text !== 'string') continue;
      const match = activationRegex.exec(seg.text);
      if (match) {
        activationFoundIndex = i;
        const startIndex = match.index ?? 0;
        question = seg.text.substring(startIndex + match[0].length).trim();
        break;
      }
    }

    if (activationFoundIndex === -1) {
      console.log('⏭️ Skipping transcript - explicit trigger not detected');
      return res.status(200).json({});
    }

    // If no question found after trigger phrase, use remaining segments
    if (!question) {
      const remainingSegments = sessionSegments.slice(activationFoundIndex + 1);
      question = remainingSegments.map(s => s.text).join(' ').trim();
    }
    
    if (!question) {
      console.log('⏭️ Skipping transcript - no question after trigger phrase');
      return res.status(200).json({ 
        message: 'Transcript ignored - no question provided' 
      });
    }
    
    // Deduplicate to avoid triggering the AI again for the same content
    const normalizedQuestion = normalizeText(question);
    const last = lastProcessedQuestion.get(session_id);
    const COOLDOWN_MS = 10 * 1000; // 10 seconds
    if (last && (Date.now() - last.ts) < COOLDOWN_MS && isNearDuplicate(last.normalized, normalizedQuestion)) {
      activationCounters.suppressedDuplicates++;
      console.log('⏭️ Suppressing near-duplicate within cooldown window:', question);
      return res.status(200).json({});
    }
    lastProcessedQuestion.set(session_id, { normalized: normalizedQuestion, ts: Date.now() });

    activationCounters.explicitTriggers++;
    console.log('🤖 Processing question:', question);

    // Session context
    const state = getOrInitSessionState(session_id);

    // Intent: menu/help
    if (/\b(menu|what can you do|help|options)\b/i.test(question)) {
      activationCounters.menuOpens++;
      const menu = [
        '- Say: "Hey Omi, list conversations"',
        '- Say: "Hey Omi, change conversation window"',
        '- Say: "Hey Omi, list spaces"',
        '- Say: "Hey Omi, switch to todos space"'
      ].join('\n');
      const msg = await formatMessageWithFooter(session_id, `Menu:\n${menu}`);
      sessionTranscripts.delete(session_id);
      return res.status(200).json({ message: msg });
    }

    // Handle pending selection (window switch)
    if (state.pending && state.pending.type === 'window_switch') {
      const lowerQ = question.toLowerCase();
      if (/\bcancel\b/.test(lowerQ)) {
        state.pending = null;
        const msg = await formatMessageWithFooter(session_id, 'Canceled.');
        sessionTranscripts.delete(session_id);
        return res.status(200).json({ message: msg });
      }
      const wordToNum = (w) => ({ one:1, two:2, three:3, four:4, five:5 }[w] || NaN);
      const numMatch = lowerQ.match(/\b(?:select\s+window\s+|select\s+|window\s+)?((?:[1-5])|one|two|three|four|five)\b/);
      if (numMatch) {
        const chosen = isNaN(Number(numMatch[1])) ? wordToNum(numMatch[1]) : Number(numMatch[1]);
        try {
          if (ENABLE_USER_SYSTEM && prisma) {
            const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
            if (sessionRow && sessionRow.userId) {
              // Ensure window exists
              let contextWindow = await prisma.userContextWindow.findUnique({ where: { userId_slot: { userId: sessionRow.userId, slot: chosen } } });
              if (!contextWindow) {
                const conversation = await prisma.conversation.create({ data: { userId: sessionRow.userId, openaiConversationId: '' } });
                contextWindow = await prisma.userContextWindow.create({ data: { userId: sessionRow.userId, slot: chosen, conversationId: conversation.id, isActive: true } });
              }
              // Make this window active and others inactive
              await prisma.userContextWindow.updateMany({ where: { userId: sessionRow.userId }, data: { isActive: false } });
              await prisma.userContextWindow.update({ where: { userId_slot: { userId: sessionRow.userId, slot: chosen } }, data: { isActive: true } });
              // Brief context summary
              const summaryRow = await prisma.conversation.findUnique({ where: { id: contextWindow.conversationId }, select: { title: true, summary: true, createdAt: true } });
              const summaryText = `Switched to window ${chosen}.` + (summaryRow ? ` Title: ${summaryRow.title || 'Untitled'}.` + (summaryRow.summary ? ` ${summaryRow.summary}` : '') : '');
              state.pending = null;
              const msg = await formatMessageWithFooter(session_id, summaryText.trim());
              sessionTranscripts.delete(session_id);
              return res.status(200).json({ message: msg });
            }
          }
        } catch (e) {
          console.warn('Window switch error:', e?.message || e);
        }
        state.pending = null;
        const msg = await formatMessageWithFooter(session_id, 'Unable to switch window right now.');
        sessionTranscripts.delete(session_id);
        return res.status(200).json({ message: msg });
      }
      // Not recognized; ask again
      const msg = await formatMessageWithFooter(session_id, 'Please say: select window 1-5, or say cancel.');
      sessionTranscripts.delete(session_id);
      return res.status(200).json({ message: msg });
    }

    // Intent: list spaces
    if (/\b(list|show)\s+(spaces)\b/i.test(question)) {
      const current = getOrInitSessionState(session_id).space;
      const lines = ALLOWED_SPACES.map((s) => `${s === current ? '[Active] ' : ''}${s}`);
      const msg = await formatMessageWithFooter(session_id, `Spaces:\n${lines.join('\n')}`);
      sessionTranscripts.delete(session_id);
      return res.status(200).json({ message: msg });
    }

    // Intent: change space
    {
      const m = question.toLowerCase().match(/\b(change|switch|set|go)\s+(to\s+)?(default|todos|memories|tasks|agent|friends|notifications)\s*(space)?\b/);
      if (m) {
        const desired = m[3];
        const stateNow = getOrInitSessionState(session_id);
        stateNow.space = desired;
        sessionContextState.set(session_id, stateNow);
        // Attempt to sync with user space if linked
        try {
          if (ENABLE_USER_SYSTEM && prisma) {
            const linkedUserId = await findLinkedUserIdForSession(session_id);
            if (linkedUserId) {
              userContextSpace.set(linkedUserId, desired);
            }
          }
        } catch {}
        const msg = await formatMessageWithFooter(session_id, `Switched to ${desired} space.`);
        sessionTranscripts.delete(session_id);
        return res.status(200).json({ message: msg });
      }
    }

    // Intent: list conversations (mapped to context windows)
    if (/\b(list|show)\s+(conversations|windows)\b/i.test(question)) {
      if (ENABLE_USER_SYSTEM && prisma) {
        try {
          const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
          if (sessionRow && sessionRow.userId) {
            const windows = await prisma.userContextWindow.findMany({ where: { userId: sessionRow.userId }, include: { conversation: { select: { title: true, summary: true, createdAt: true } } }, orderBy: { slot: 'asc' } });
            // Ensure all 1..5 represented
            const present = new Set(windows.map(w => w.slot));
            for (let s = 1; s <= 5; s++) {
              if (!present.has(s)) {
                // Fill placeholders without creating DB rows
                windows.push({ slot: s, isActive: false, conversationId: '', userId: sessionRow.userId, id: '', createdAt: new Date(), conversation: null });
              }
            }
            const sorted = windows.sort((a, b) => a.slot - b.slot);
            const lines = sorted.map(w => {
              const flag = w.isActive ? '[Active] ' : '';
              const conv = w.conversation;
              if (!conv) return `${w.slot}) ${flag}<empty>`;
              const title = conv.title || 'Untitled';
              const summary = conv.summary ? ` — ${conv.summary}` : '';
              return `${w.slot}) ${flag}${title}${summary}`;
            });
            const msg = await formatMessageWithFooter(session_id, `Conversations:\n${lines.join('\n')}`);
            sessionTranscripts.delete(session_id);
            return res.status(200).json({ message: msg });
          }
        } catch (e) {
          console.warn('List conversations error:', e?.message || e);
        }
      }
      const msg = await formatMessageWithFooter(session_id, 'No conversations found.');
      sessionTranscripts.delete(session_id);
      return res.status(200).json({ message: msg });
    }

    // Intent: change conversation window -> prompt for selection
    if (/\b(change|switch)\s+(conversation\s+window|window|context)\b/i.test(question)) {
      if (ENABLE_USER_SYSTEM && prisma) {
        try {
          const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
          if (sessionRow && sessionRow.userId) {
            // Prepare list (without guaranteeing rows exist)
            const windows = await prisma.userContextWindow.findMany({ where: { userId: sessionRow.userId }, include: { conversation: { select: { title: true, summary: true } } }, orderBy: { slot: 'asc' } });
            const present = new Set(windows.map(w => w.slot));
            for (let s = 1; s <= 5; s++) {
              if (!present.has(s)) windows.push({ slot: s, isActive: false, conversationId: '', userId: sessionRow.userId, id: '', createdAt: new Date(), conversation: null });
            }
            const sorted = windows.sort((a, b) => a.slot - b.slot).map(w => ({
              num: w.slot,
              slot: w.slot,
              conversationId: w.conversationId || null,
              title: (w.conversation && w.conversation.title) || null,
              summary: (w.conversation && w.conversation.summary) || null
            }));
            sessionContextState.set(session_id, { ...state, pending: { type: 'window_switch', options: sorted } });
            const lines = sorted.map(o => `${o.num}) ${(o.title || '<empty>')}${o.summary ? ' — ' + o.summary : ''}`);
            const msg = await formatMessageWithFooter(session_id, `Which conversation window would you like to select?\n${lines.join('\n')}\nSay: select window 1-5, or say cancel.`);
            sessionTranscripts.delete(session_id);
            return res.status(200).json({ message: msg });
          }
        } catch (e) {
          console.warn('Change window intent error:', e?.message || e);
        }
      }
      const msg = await formatMessageWithFooter(session_id, 'I could not access your windows.');
      sessionTranscripts.delete(session_id);
      return res.status(200).json({ message: msg });
    }
    
    // ---- OMI Import intent hooks ----
    const uid = req.body?.user_id || req.query?.uid; // allow either source of uid

    // Memory intent (e.g., "remember/save/note ... as a memory/fact")
    if (/\b(remember|save|note)\b.*\b(memory|fact)\b/i.test(question)) {
      try {
        await omiCreateMemories({ uid, text: question, text_source: 'other' });
        const msg = await formatMessageWithFooter(session_id, 'Saved to your OMI memories.');
        sessionTranscripts.delete(session_id);
        return res.status(200).json({ message: msg });
      } catch (e) {
        console.error('Memory import failed:', e);
        const msg = await formatMessageWithFooter(session_id, 'I tried to save that as a memory but hit an error.');
        sessionTranscripts.delete(session_id);
        return res.status(200).json({ message: msg });
      }
    }

    // Conversation intent (e.g., "log/record/create conversation/meeting/call ...")
    if (/\b(log|record|create)\b.*\b(conversation|meeting|call)\b/i.test(question)) {
      try {
        await omiCreateConversation({ uid, text: question, text_source: 'other_text' });
        const msg = await formatMessageWithFooter(session_id, 'Logged as a conversation in OMI.');
        sessionTranscripts.delete(session_id);
        return res.status(200).json({ message: msg });
      } catch (e) {
        console.error('Conversation import failed:', e);
        const msg = await formatMessageWithFooter(session_id, 'I tried to log that conversation but hit an error.');
        sessionTranscripts.delete(session_id);
        return res.status(200).json({ message: msg });
      }
    }

    // Use OpenAI Responses API with Conversations
    console.log('🤖 Using OpenAI Responses API (Conversations) for:', question);

    let aiResponse = '';

    // Ensure a valid OpenAI conversation id for this Omi session
    let conversationId = sessionConversations.get(session_id);
    if (!conversationId) {
      try {
        const conversation = await openai.conversations.create({
          metadata: { omi_session_id: String(session_id) }
        });
        conversationId = conversation.id;
        sessionConversations.set(session_id, conversationId);
        console.log('🧵 Created OpenAI conversation for session:', session_id, conversationId);
      } catch (convErr) {
        console.warn('⚠️ Failed to create OpenAI conversation, proceeding without conversation state:', convErr?.message || convErr);
      }
    }

    // Persist webhook data (non-blocking; errors logged only)
    if (ENABLE_USER_SYSTEM && prisma) {
      (async () => {
        try {
          // Upsert omi_sessions
          const payloadUserId = req.body?.user_id;
          let linkedUserId = null;
          if (payloadUserId) {
            try {
              const link = await prisma.omiUserLink.findUnique({ where: { omiUserId: String(payloadUserId) } });
              if (link && link.isVerified) {
                linkedUserId = link.userId;
              }
            } catch {}
          }
          await prisma.omiSession.upsert({
            where: { omiSessionId: String(session_id) },
            update: { lastSeenAt: new Date(), ...(linkedUserId ? { userId: linkedUserId } : {}) },
            create: { omiSessionId: String(session_id), ...(linkedUserId ? { userId: linkedUserId } : {}) }
          });

          // Persist transcript segments uniquely
          const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
          if (sessionRow) {
            for (const seg of segments) {
              try {
                await prisma.transcriptSegment.upsert({
                  where: { omiSessionId_omiSegmentId: { omiSessionId: sessionRow.id, omiSegmentId: String(seg.id || seg.segment_id || crypto.createHash('sha1').update(String(seg.text || '')).digest('hex')) } },
                  update: { text: String(seg.text || ''), speaker: seg.speaker || null, speakerId: seg.speaker_id ?? null, isUser: seg.is_user ?? null, start: seg.start ?? null, end: seg.end ?? null },
                  create: { omiSessionId: sessionRow.id, omiSegmentId: String(seg.id || seg.segment_id || crypto.createHash('sha1').update(String(seg.text || '')).digest('hex')), text: String(seg.text || ''), speaker: seg.speaker || null, speakerId: seg.speaker_id ?? null, isUser: seg.is_user ?? null, start: seg.start ?? null, end: seg.end ?? null }
                });
              } catch (segErr) {
                console.warn('Transcript segment persist error:', segErr?.message || segErr);
              }
            }
          }
        } catch (persistErr) {
          console.warn('Webhook persistence error (pre-AI):', persistErr?.message || persistErr);
        }
      })();
    }

    try {
      // Use the new Responses API (no preview web search tool)
      const requestPayload = {
        model: OPENAI_MODEL,
        input: question,
        tools: [
          { type: 'web_search' }
        ],
        tool_choice: 'auto'
      };
      if (conversationId) {
        requestPayload.conversation = conversationId;
      }
      const response = await openai.responses.create(requestPayload);

      aiResponse = response.output_text;
      console.log('✨ OpenAI Responses API response:', aiResponse);

    } catch (error) {
      console.error('❌ OpenAI Responses API error:', error);

      // Fallback to regular chat completion if Responses API fails
      try {
        const openaiResponse = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { 
              role: 'system', 
              content: 'You are a helpful AI assistant. When users ask about current events, weather, news, or time-sensitive information, be honest about your knowledge cutoff and suggest they check reliable sources for the most up-to-date information. For general knowledge questions, provide helpful and accurate responses.' 
            },
            { role: 'user', content: question }
          ],
          max_tokens: 800,
          temperature: 0.7,
        });
        aiResponse = openaiResponse.choices[0].message.content;
        console.log('✨ Fallback OpenAI response:', aiResponse);
      } catch (fallbackError) {
        console.error('❌ Fallback also failed:', fallbackError);
        aiResponse = "I'm sorry, I'm experiencing technical difficulties. Please try again later.";
      }
    }

    // Persist conversation+messages (non-blocking)
    if (ENABLE_USER_SYSTEM && prisma) {
      (async () => {
        try {
          const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
          let conversationRow = null;
          if (sessionRow && conversationId) {
            try {
              conversationRow = await prisma.conversation.upsert({
                where: { omiSessionId_openaiConversationId: { omiSessionId: sessionRow.id, openaiConversationId: String(conversationId) } },
                update: {},
                create: { omiSessionId: sessionRow.id, openaiConversationId: String(conversationId) }
              });
            } catch (convErr) {
              console.warn('Conversation upsert error:', convErr?.message || convErr);
            }
          }
          if (conversationRow) {
            // Persist user question message
            try {
              await prisma.message.create({
                data: {
                  conversationId: conversationRow.id,
                  role: 'USER',
                  text: question,
                  source: 'OMI_TRANSCRIPT'
                }
              });
            } catch (mErr) {
              console.warn('User message persist error:', mErr?.message || mErr);
            }
            // Persist assistant response (with footer)
            try {
              const formatted = await formatMessageWithFooter(session_id, aiResponse, { includeHeader: true });
              await prisma.message.create({
                data: {
                  conversationId: conversationRow.id,
                  role: 'ASSISTANT',
                  text: formatted,
                  source: 'SYSTEM'
                }
              });
            } catch (m2Err) {
              console.warn('Assistant message persist error:', m2Err?.message || m2Err);
            }
          }
        } catch (postPersistErr) {
          console.warn('Webhook persistence error (post-AI):', postPersistErr?.message || postPersistErr);
        }
      })();
    }

    // Return response so Omi shows content in chat and sends a single notification
    sessionTranscripts.delete(session_id);
    console.log('🧹 Cleared session transcript for:', session_id);
    const finalMsg = await formatMessageWithFooter(session_id, aiResponse, { includeHeader: true });
    return res.status(200).json({ message: finalMsg });
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    
    // Handle specific error types
    if (error.message && error.message.includes('API Error')) {
      // Omi API error response
      console.error('Omi API Error:', error.message);
      res.status(500).json({
        error: 'Omi API Error',
        message: 'Omi error message', //todo
        //message: error.message
      });
    } else if (error.message && (error.message.includes('OMI_APP_ID not set') || error.message.includes('OMI_APP_SECRET not set'))) {
      // Configuration error
      console.error('Configuration Error:', error.message);
      res.status(500).json({
        error: 'Configuration Error',
        message: 'Omi config error', //todo
       // message: error.message
      });
    } else {
      // Other errors
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🚨 Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'Something went wrong on the server'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, async () => {
  console.log('🚀 Omi AI Chat Plugin server started');
  console.log(`📍 Server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  if (ENABLE_USER_SYSTEM) {
    console.log(`🩺 DB health: http://localhost:${PORT}/health/db`);
  }
  console.log(`📖 Help & instructions: http://localhost:${PORT}/help`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/omi-webhook`);
  if (ENABLE_USER_SYSTEM && !process.env.DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL is not set (user system enabled)');
  }

  // Check environment variables (Updated)
  if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_KEY) {
    console.warn('⚠️  OPENAI_API_KEY (or OPENAI_KEY) environment variable is not set');
  }
  if (!process.env.OMI_APP_ID) {
    console.warn('⚠️  OMI_APP_ID environment variable is not set');
  }
  if (!process.env.OMI_APP_SECRET) {
    console.warn('⚠️  OMI_APP_SECRET environment variable is not set');
  }
  
     // OpenAI Responses API is ready to use
   console.log('✅ OpenAI Responses API ready with Conversations');
  
     // Set up session cleanup every 5 minutes
   setInterval(() => {
     const now = Date.now();
     const fiveMinutesAgo = now - (5 * 60 * 1000);
     
     for (const [sessionId, segments] of sessionTranscripts.entries()) {
       // Check if any segment is older than 5 minutes
       const hasOldSegment = segments.some(segment => {
         // Use segment.end time if available, otherwise assume recent
         return segment.end && (segment.end * 1000) < fiveMinutesAgo;
       });
       
       if (hasOldSegment) {
         sessionTranscripts.delete(sessionId);
         console.log('�� Cleaned up old session:', sessionId);
       }
     }
   }, 5 * 60 * 1000); // 5 minutes
   
   // Set up rate limit cleanup every hour
   setInterval(() => {
     const now = Date.now();
     const oneHourAgo = now - RATE_LIMIT_WINDOW;
     
     for (const [userId, timestamps] of notificationHistory.entries()) {
       // Remove timestamps older than 1 hour
       const recentTimestamps = timestamps.filter(timestamp => timestamp > oneHourAgo);
       
       if (recentTimestamps.length === 0) {
         notificationHistory.delete(userId);
         console.log('🧹 Cleaned up old rate limit history for user:', userId);
       } else {
         notificationHistory.set(userId, recentTimestamps);
       }
     }
   }, RATE_LIMIT_WINDOW); // 1 hour
  
  console.log('✅ Server ready to receive Omi webhooks');
});