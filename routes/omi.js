'use strict';

const crypto = require('crypto');
const { buildActivationRegex, withinQuietHours, normalizeText, isNearDuplicate } = require('../services/activation');
const { ENABLE_CONTEXT_ACTIVATION, QUIET_HOURS_ENABLED } = require('../featureFlags');

module.exports = function createOmiRoutes({ app, prisma, openai, OPENAI_MODEL, ENABLE_USER_SYSTEM, backgroundQueue }) {
  if (!app) throw new Error('app is required');

  // Helper: fetch session + user preferences and derive activation config
  async function loadActivationConfig(sessionId, overrideUserId = null, sessionRowOverride = null) {
    let pref = { listenMode: 'TRIGGER', followupWindowMs: 8000, injectMemories: false, meetingTranscribe: false };
    let sessionPref = null;
    let user = null;
    if (ENABLE_USER_SYSTEM && prisma) {
      let sessionRow = sessionRowOverride;
      if (!sessionRow) {
        sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(sessionId) }, include: { user: true, preferences: true } });
      }
      if (sessionRow) {
        sessionPref = sessionRow.preferences || null;
        user = sessionRow.user || null;
      }
      const targetUserId = overrideUserId || (user ? user.id : null);
      if (targetUserId) {
        if (!user || user.id !== targetUserId) {
          try {
            user = await prisma.user.findUnique({ where: { id: targetUserId } });
          } catch {}
        }
        try {
          const up = await prisma.userPreference.findUnique({ where: { userId: targetUserId } });
          if (up) pref = up;
        } catch {}
      } else if (user) {
        try {
          const up = await prisma.userPreference.findUnique({ where: { userId: user.id } });
          if (up) pref = up;
        } catch {}
      }
    }
    // Merge session-level preferences without overriding user-level injectMemories
    // Session prefs can override activation/listen behavior, but memory injection is a per-user opt-in
    let merged = { ...pref };
    if (sessionPref) {
      merged = {
        ...merged,
        listenMode: sessionPref.listenMode,
        followupWindowMs: sessionPref.followupWindowMs,
        meetingTranscribe: sessionPref.meetingTranscribe,
        // intentionally NOT overriding injectMemories here
        activationRegex: sessionPref.activationRegex,
        activationSensitivity: sessionPref.activationSensitivity,
        mute: sessionPref.mute,
        dndQuietHoursStart: sessionPref.dndQuietHoursStart,
        dndQuietHoursEnd: sessionPref.dndQuietHoursEnd
      };
    }
    const regex = buildActivationRegex(merged.activationRegex);
    return { pref: merged, regex };
  }

  // Stateful dedupe per session (kept minimal; acceptable until cutover)
  const lastProcessedQuestion = new Map();
  
  // Session metadata cache to avoid repeated database calls
  const sessionCache = new Map();
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  
  // Helper to get cached session metadata
  async function getCachedSessionMetadata(sessionId, linkedUserId = null) {
    const cacheKey = `${sessionId}-${linkedUserId || 'null'}`;
    const cached = sessionCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
    
    let sessionRow = null;
    if (ENABLE_USER_SYSTEM && prisma) {
      try {
        sessionRow = await prisma.omiSession.findUnique({
          where: { omiSessionId: String(sessionId) },
          include: { user: true, preferences: true }
        });
      } catch {}
    }
    
    const metadata = { sessionRow, linkedUserId };
    sessionCache.set(cacheKey, { data: metadata, timestamp: Date.now() });
    
    // Clean up old cache entries periodically
    if (sessionCache.size > 1000) {
      const now = Date.now();
      for (const [key, value] of sessionCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
          sessionCache.delete(key);
        }
      }
    }
    
    return metadata;
  }

  app.post('/omi-webhook', async (req, res) => {
    const startTime = Date.now();
    try {
      // Combined payload support: can include both transcript segments and memory data
      const uid = req.query && req.query.uid ? String(req.query.uid) : null;
      const body = req.body || {};
      const hasTranscriptSegments = Array.isArray(body.segments) && body.segments.length > 0;
      const hasMemoryData = !!(uid && (Array.isArray(body.transcript_segments) || body.structured || typeof body.discarded !== 'undefined'));
      const session_id = (req.query && req.query.session_id ? String(req.query.session_id) : (body && body.session_id ? String(body.session_id) : null));
      
      // Handle combined payload: transcript + memory
      if (hasTranscriptSegments && hasMemoryData && session_id) {
        // Queue memory save for background processing
        if (backgroundQueue && !body.discarded) {
          const memText = (await composeMemoryText(body)).trim();
          if (memText) {
            try {
              const link = await prisma.omiUserLink.findUnique({ where: { omiUserId: uid } });
              if (link && link.isVerified) {
                backgroundQueue.enqueue({
                  type: 'MEMORY_SAVE',
                  data: { userId: link.userId, text: memText }
                });
              }
            } catch (e) {
              console.warn('Failed to queue memory save:', e?.message || e);
            }
          }
        }
        
        // Continue with transcript processing (fall through to transcript mode)
      }
      
      // Memory-only payload (existing behavior)
      const isMemoryPayload = hasMemoryData && !hasTranscriptSegments;

      async function composeMemoryText(payload) {
        try {
          const structured = payload.structured || {};
          const emoji = structured.emoji ? String(structured.emoji).trim() : '';
          const title = structured.title ? String(structured.title).trim() : '';
          const overview = (structured.overview || payload.overview) ? String(structured.overview || payload.overview).trim() : '';
          let line = '';
          if (emoji && title) line = `${emoji} ${title}`;
          else if (emoji) line = emoji;
          else if (title) line = title;
          let text = '';
          if (line && overview) text = `${line}: ${overview}`;
          else if (overview) text = overview;
          else if (line) text = line;
          if (!text) {
            const segs = Array.isArray(payload.transcript_segments) ? payload.transcript_segments : [];
            if (segs.length) {
              const combined = segs
                .map((s) => (typeof s.text === 'string' ? s.text.trim() : ''))
                .filter(Boolean)
                .join(' ')
                .trim();
              text = combined;
            }
          }
          const actions = Array.isArray(structured.action_items) ? structured.action_items : [];
          const actionLines = actions
            .map((a) => (a && a.description ? String(a.description).trim() : ''))
            .filter(Boolean);
          if (actionLines.length) {
            const suffix = ` Action: ${actionLines.slice(0, 2).join('; ')}`;
            text = text ? `${text}${suffix}` : suffix;
          }
          text = String(text || '').replace(/\s+/g, ' ').trim();
          if (text.length > 500) text = text.slice(0, 497) + '...';
          return text;
        } catch {
          return '';
        }
      }

      if (isMemoryPayload) {
        if (!(ENABLE_USER_SYSTEM && prisma)) return res.status(503).json({ error: 'User system disabled' });
        try {
          if (body && body.discarded === true) return res.status(200).json({ ok: true, ignored: true, discarded: true });
          const link = await prisma.omiUserLink.findUnique({ where: { omiUserId: uid } });
          if (!link || !link.isVerified) return res.status(404).json({ error: 'uid not linked to a verified user' });
          const userId = link.userId;
          const memText = (await composeMemoryText(body)).trim();
          if (!memText) return res.status(200).json({ ok: true, ignored: true });
          // Deduplicate within recent window
          const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
          const dupe = await prisma.memory.findFirst({ where: { userId, text: memText, createdAt: { gt: since } } });
          if (dupe) {
            return res.status(200).json({ ok: true, deduped: true, memory: { id: dupe.id, text: dupe.text, createdAt: dupe.createdAt } });
          }
          const saved = await prisma.memory.create({ data: { userId, text: memText } });
          return res.status(201).json({ ok: true, memory: { id: saved.id, text: saved.text, createdAt: saved.createdAt } });
        } catch (e) {
          return res.status(500).json({ error: 'Failed to save memory' });
        }
      }

      // Transcript mode (existing behavior)
      const segments = Array.isArray(body) ? body : (Array.isArray(body.segments) ? body.segments : []);
      if (!session_id || !segments.length) return res.status(400).json({ error: 'session_id and segments[] required' });

      // Resolve any linked user/session metadata using cache for faster response
      let linkedUserId = null;
      let sessionRowCache = null;
      if (ENABLE_USER_SYSTEM && prisma) {
        const payloadUserId = (req.query?.uid ? String(req.query.uid) : (req.body?.uid ? String(req.body.uid) : (req.body?.user_id ? String(req.body.user_id) : null)));
        if (payloadUserId) {
          try {
            const link = await prisma.omiUserLink.findUnique({ where: { omiUserId: payloadUserId } });
            if (link && link.isVerified) linkedUserId = link.userId;
          } catch {}
        }
        
        // Use cached session metadata
        const cachedMetadata = await getCachedSessionMetadata(session_id, linkedUserId);
        sessionRowCache = cachedMetadata.sessionRow;
        if (!linkedUserId && sessionRowCache?.userId) {
          linkedUserId = sessionRowCache.userId;
        }
      }

      const { pref, regex } = await loadActivationConfig(session_id, linkedUserId, sessionRowCache);

      // Meeting transcribe special mode: only persist (already done) and optionally return on end
      if (pref.meetingTranscribe) {
        const endSignal = Boolean(req.body?.end || req.body?.final || req.body?.is_final) ||
          segments.some((s) => s?.end === true || s?.final === true || s?.is_final === true || s?.is_last_segment === true || s?.segment_type === 'end');
        if (!endSignal) return res.status(200).json({});
        const instructionsText = 'Ask questions naturally or use "Hey Omi" to be explicit.';
        const helpMessage = 'You can talk to me naturally! Try asking questions or giving commands.';
        const aiResponse = 'Meeting transcribed and saved.';
        return res.status(200).json({ message: aiResponse, help_response: helpMessage, instructions: instructionsText });
      }

      if (QUIET_HOURS_ENABLED && withinQuietHours(pref)) {
        return res.status(200).json({});
      }

      // Trigger phrase detection and question extraction
      let activationFoundIndex = -1;
      let question = '';
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (typeof seg.text !== 'string') continue;
        const match = regex.exec(seg.text);
        if (match) {
          activationFoundIndex = i;
          const startIndex = match.index ?? 0;
          question = seg.text.substring(startIndex + match[0].length).trim();
          break;
        }
      }

      if (pref.listenMode === 'TRIGGER') {
        if (activationFoundIndex === -1) return res.status(200).json({});
      } else if (pref.listenMode === 'FOLLOWUP') {
        const last = lastProcessedQuestion.get(session_id);
        const withinFollowup = last && Date.now() - last.ts <= (pref.followupWindowMs || 8000);
        if (!withinFollowup && activationFoundIndex === -1) return res.status(200).json({});
      } else {
        // ALWAYS
      }

      if (!question) {
        const remaining = segments.slice(activationFoundIndex + 1);
        question = remaining.map((s) => s.text).join(' ').trim();
      }
      if (!question) return res.status(200).json({});

      // Deduplication
      const normalized = normalizeText(question);
      const last = lastProcessedQuestion.get(session_id);
      const COOLDOWN_MS = 10 * 1000;
      if (last && Date.now() - last.ts < COOLDOWN_MS && isNearDuplicate(last.normalized, normalized)) {
        return res.status(200).json({});
      }
      lastProcessedQuestion.set(session_id, { normalized, ts: Date.now() });

      // Build context for OpenAI
      let memoryContext = '';
      if (pref.injectMemories && ENABLE_USER_SYSTEM && prisma) {
        try {
          const sessionRow = sessionRowCache || await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
          if (sessionRow && !sessionRowCache) sessionRowCache = sessionRow;
          const userIdForMemories = (sessionRow && sessionRow.userId) || linkedUserId || null;
          if (userIdForMemories) {
            const mems = await prisma.memory.findMany({ where: { userId: userIdForMemories }, orderBy: { createdAt: 'desc' }, take: 20 });
            memoryContext = mems.map((m) => `- ${m.text}`).join('\n');
            if (memoryContext.length > 2000) memoryContext = memoryContext.slice(0, 2000);
          }
        } catch {}
      }
      const sysInstructions = [
        'You are Omi, a friendly, practical assistant. Keep replies concise.',
        memoryContext ? `Relevant memories:\n${memoryContext}` : ''
      ].filter(Boolean).join('\n\n');

      // Ensure conversation id is stored in OmiSession
      let conversationId = null;
      if (ENABLE_USER_SYSTEM && prisma) {
        try {
          const sessionRow = sessionRowCache || await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
          if (sessionRow && !sessionRowCache) sessionRowCache = sessionRow;
          if (sessionRow && sessionRow.openaiConversationId) {
            conversationId = sessionRow.openaiConversationId;
          }
        } catch {}
      }
      if (!conversationId) {
        try {
          const conversation = await openai.conversations.create({ metadata: { omi_session_id: String(session_id) } });
          conversationId = conversation.id;
          if (sessionRowCache) sessionRowCache.openaiConversationId = conversationId;
        } catch {}
      }

      // Call OpenAI
      let aiResponse = '';
      try {
        const requestPayload = { model: OPENAI_MODEL, input: question };
        if (conversationId) requestPayload.conversation = conversationId;
        if (sysInstructions) requestPayload.instructions = sysInstructions;
        const response = await openai.responses.create(requestPayload);
        aiResponse = response.output_text;
      } catch (e) {
        try {
          const resp = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [ { role: 'system', content: sysInstructions || 'You are a helpful assistant.' }, { role: 'user', content: question } ],
            max_tokens: 800,
            temperature: 0.7
          });
          aiResponse = resp.choices?.[0]?.message?.content || '';
        } catch {
          aiResponse = "I'm sorry, please try again later.";
        }
      }

      const instructionsText = 'Ask questions naturally or use "Hey Omi" to be explicit.';
      const helpMessage = 'You can talk to me naturally! Try asking questions or giving commands.';
      const response = { message: aiResponse, help_response: helpMessage, instructions: instructionsText };
      const jsonRes = res.status(200).json(response);
      console.log('Webhook response time:', Date.now() - startTime, 'ms');

      // Queue background jobs for persistence (non-blocking)
      if (ENABLE_USER_SYSTEM && prisma && backgroundQueue) {
        const backgroundSessionId = String(session_id);
        const backgroundSegments = Array.isArray(segments) ? segments.slice() : [];
        const backgroundLinkedUserId = linkedUserId;
        const backgroundConversationId = conversationId ? String(conversationId) : null;
        const backgroundQuestion = question;
        const backgroundAiResponse = aiResponse;
        
        // Queue session update
        backgroundQueue.enqueue({
          type: 'SESSION_UPDATE',
          data: {
            sessionId: backgroundSessionId,
            userId: backgroundLinkedUserId,
            conversationId: backgroundConversationId,
            lastSeenAt: new Date()
          }
        });
        
        // Queue transcript batch upserts
        if (backgroundSegments.length) {
          backgroundQueue.enqueue({
            type: 'TRANSCRIPT_BATCH',
            data: {
              sessionId: backgroundSessionId,
              segments: backgroundSegments
            }
          });
        }
        
        // Queue conversation save
        if (backgroundConversationId && (backgroundQuestion || backgroundAiResponse)) {
          backgroundQueue.enqueue({
            type: 'CONVERSATION_SAVE',
            data: {
              sessionId: backgroundSessionId,
              conversationId: backgroundConversationId,
              question: backgroundQuestion,
              aiResponse: backgroundAiResponse
            }
          });
          
          // Queue context window update if user is linked
          if (backgroundLinkedUserId) {
            backgroundQueue.enqueue({
              type: 'CONTEXT_WINDOW_UPDATE',
              data: {
                userId: backgroundLinkedUserId,
                conversationId: backgroundConversationId
              }
            });
          }
        }
      }
      return jsonRes;
    } catch (e) {
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // Health check endpoint for background queue
  app.get('/omi-webhook/queue-status', (req, res) => {
    if (!backgroundQueue) {
      return res.status(503).json({ error: 'Background queue not available' });
    }
    
    const status = backgroundQueue.getStatus();
    res.status(200).json({
      ok: true,
      queue: status
    });
  });
};

