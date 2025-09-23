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
    const merged = {
      ...pref,
      ...(sessionPref || {})
    };
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
    
    // Set a timeout to ensure we respond before client timeout (499)
    const responseTimeout = setTimeout(() => {
      if (!res.headersSent) {
        console.warn('Webhook timeout - sending early response');
        res.status(200).json({ 
          message: "I'm here! Give me a moment to think...", 
          help_response: "You can talk to me naturally!", 
          instructions: "Ask questions naturally or use 'Hey Omi' to be explicit." 
        });
      }
    }, 12000); // Respond at 12 seconds max
    
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
        
        // Parallel fetch for user link and session metadata
        const [linkResult, cachedMetadata] = await Promise.allSettled([
          payloadUserId ? prisma.omiUserLink.findUnique({ where: { omiUserId: payloadUserId } }) : Promise.resolve(null),
          getCachedSessionMetadata(session_id, null)
        ]);
        
        if (linkResult.status === 'fulfilled' && linkResult.value?.isVerified) {
          linkedUserId = linkResult.value.userId;
        }
        
        if (cachedMetadata.status === 'fulfilled') {
          sessionRowCache = cachedMetadata.value.sessionRow;
          if (!linkedUserId && sessionRowCache?.userId) {
            linkedUserId = sessionRowCache.userId;
          }
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

      // Build context for OpenAI - fetch memories in parallel with conversation setup
      let memoryContextPromise = Promise.resolve('');
      if (pref.injectMemories && ENABLE_USER_SYSTEM && prisma) {
        const userIdForMemories = (sessionRowCache?.userId) || linkedUserId || null;
        if (userIdForMemories) {
          memoryContextPromise = prisma.memory.findMany({ 
            where: { userId: userIdForMemories }, 
            orderBy: { createdAt: 'desc' }, 
            take: 20,
            select: { text: true } // Only fetch needed field
          }).then(mems => {
            const context = mems.map((m) => `- ${m.text}`).join('\n');
            return context.length > 2000 ? context.slice(0, 2000) : context;
          }).catch((err) => {
            console.warn('Failed to fetch memories:', err.message);
            return '';
          });
        }
      }
      
      // Ensure conversation id is stored in OmiSession
      let conversationId = sessionRowCache?.openaiConversationId || null;
      
      // Create conversation if needed (parallel with memory fetch)
      const conversationPromise = conversationId ? 
        Promise.resolve(conversationId) : 
        openai.conversations.create({ metadata: { omi_session_id: String(session_id) } })
          .then(conv => {
            conversationId = conv.id;
            if (sessionRowCache) sessionRowCache.openaiConversationId = conversationId;
            return conversationId;
          })
          .catch(() => null);
      
      // Wait for parallel operations
      const [memoryContext, finalConversationId] = await Promise.all([
        memoryContextPromise,
        conversationPromise
      ]);
      
      if (finalConversationId) conversationId = finalConversationId;
      
      // Build system instructions AFTER memoryContext is resolved
      const sysInstructions = [
        'You are Omi, a friendly, practical assistant. Keep replies concise.',
        memoryContext ? `Relevant memories:\n${memoryContext}` : ''
      ].filter(Boolean).join('\n\n');

      // Call OpenAI with timeout to prevent long delays
      let aiResponse = '';
      const openaiTimeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('OpenAI timeout')), 10000) // Reduced to 10 seconds
      );
      
      const openaiStartTime = Date.now();
      try {
        // Use the standard chat completions API
        const messages = [
          { role: 'system', content: sysInstructions || 'You are Omi, a helpful assistant.' },
          { role: 'user', content: question }
        ];
        
        console.log(`Calling OpenAI with model: ${OPENAI_MODEL || 'gpt-4o-mini'}`);
        const response = await Promise.race([
          openai.chat.completions.create({
            model: OPENAI_MODEL || 'gpt-4o-mini',
            messages,
            max_tokens: 500,
            temperature: 0.7
          }),
          openaiTimeout
        ]);
        
        console.log(`OpenAI responded in ${Date.now() - openaiStartTime}ms`);
        aiResponse = response.choices?.[0]?.message?.content || '';
      } catch (e) {
        if (e.message === 'OpenAI timeout') {
          console.warn('OpenAI request timed out after 10s');
          aiResponse = "I'm processing your request. Please try again in a moment.";
        } else {
          console.error('OpenAI error:', e.message);
          // Try with a simpler, faster model as fallback
          try {
            const resp = await Promise.race([
              openai.chat.completions.create({
                model: 'gpt-3.5-turbo', // Even faster fallback model
                messages: [ 
                  { role: 'system', content: 'You are a helpful assistant.' }, 
                  { role: 'user', content: question } 
                ],
                max_tokens: 200,
                temperature: 0.7
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Fallback timeout')), 5000))
            ]);
            aiResponse = resp.choices?.[0]?.message?.content || '';
          } catch (fallbackError) {
            console.error('Fallback OpenAI error:', fallbackError.message);
            aiResponse = "I'm sorry, I'm having trouble processing your request. Please try again later.";
          }
        }
      }

      const instructionsText = 'Ask questions naturally or use "Hey Omi" to be explicit.';
      const helpMessage = 'You can talk to me naturally! Try asking questions or giving commands.';
      const response = { message: aiResponse, help_response: helpMessage, instructions: instructionsText };
      
      // Clear timeout and send response
      clearTimeout(responseTimeout);
      if (!res.headersSent) {
        res.status(200).json(response);
      }
      console.log('Webhook response time:', Date.now() - startTime, 'ms');

      // Queue background jobs for persistence (non-blocking)
      // Do this AFTER sending response to minimize latency
      setImmediate(() => {
        if (ENABLE_USER_SYSTEM && prisma && backgroundQueue) {
          const backgroundSessionId = String(session_id);
          const backgroundSegments = Array.isArray(segments) ? segments.slice() : [];
          const backgroundLinkedUserId = linkedUserId;
          const backgroundConversationId = conversationId ? String(conversationId) : null;
          const backgroundQuestion = question;
          const backgroundAiResponse = aiResponse;
          
          // Combine related jobs to reduce queue overhead
          const jobs = [];
          
          // Session update job
          jobs.push({
            type: 'SESSION_UPDATE',
            data: {
              sessionId: backgroundSessionId,
              userId: backgroundLinkedUserId,
              conversationId: backgroundConversationId,
              lastSeenAt: new Date()
            }
          });
          
          // Transcript batch upserts
          if (backgroundSegments.length) {
            jobs.push({
              type: 'TRANSCRIPT_BATCH',
              data: {
                sessionId: backgroundSessionId,
                segments: backgroundSegments
              }
            });
          }
          
          // Conversation save
          if (backgroundConversationId && (backgroundQuestion || backgroundAiResponse)) {
            jobs.push({
              type: 'CONVERSATION_SAVE',
              data: {
                sessionId: backgroundSessionId,
                conversationId: backgroundConversationId,
                question: backgroundQuestion,
                aiResponse: backgroundAiResponse
              }
            });
            
            // Context window update if user is linked
            if (backgroundLinkedUserId) {
              jobs.push({
                type: 'CONTEXT_WINDOW_UPDATE',
                data: {
                  userId: backgroundLinkedUserId,
                  conversationId: backgroundConversationId
                }
              });
            }
          }
          
          // Enqueue all jobs at once
          jobs.forEach(job => backgroundQueue.enqueue(job));
        }
      });
      
      return;
    } catch (e) {
      clearTimeout(responseTimeout);
      console.error('Webhook error:', e);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Webhook processing failed' });
      }
    }
  });

  // Health check endpoint for background queue
  app.get('/omi-webhook/queue-status', (req, res) => {
    if (!backgroundQueue) {
      return res.status(503).json({ error: 'Background queue not available' });
    }
    
    const status = backgroundQueue.getStatus();
    const sessionCacheSize = sessionCache.size;
    const lastProcessedSize = lastProcessedQuestion.size;
    
    res.status(200).json({
      ok: true,
      queue: status,
      caches: {
        sessionCache: sessionCacheSize,
        lastProcessedQuestion: lastProcessedSize
      },
      featureFlags: {
        ENABLE_USER_SYSTEM,
        ENABLE_CONTEXT_ACTIVATION,
        ENABLE_PROMPT_WORKERS: require('../featureFlags').ENABLE_PROMPT_WORKERS
      }
    });
  });
};

