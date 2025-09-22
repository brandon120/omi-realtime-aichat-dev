'use strict';

const crypto = require('crypto');
const { buildActivationRegex, withinQuietHours, normalizeText, isNearDuplicate } = require('../services/activation');
const { ENABLE_CONTEXT_ACTIVATION, QUIET_HOURS_ENABLED } = require('../featureFlags');

module.exports = function createOmiRoutes({ app, prisma, openai, OPENAI_MODEL, ENABLE_USER_SYSTEM }) {
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

  app.post('/omi-webhook', async (req, res) => {
    const startTime = Date.now();
    try {
      // Memory ingestion mode (payload includes full memory object and uid query)
      const uid = req.query && req.query.uid ? String(req.query.uid) : null;
      const body = req.body || {};
      const isMemoryPayload = !!(uid && (Array.isArray(body.transcript_segments) || body.structured || typeof body.discarded !== 'undefined'));

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
      const session_id = (req.query && req.query.session_id ? String(req.query.session_id) : (body && body.session_id ? String(body.session_id) : null));
      const segments = Array.isArray(body) ? body : (Array.isArray(body.segments) ? body.segments : []);
      if (!session_id || !segments.length) return res.status(400).json({ error: 'session_id and segments[] required' });

      // Resolve any linked user/session metadata needed for context without blocking the response on writes.
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
        try {
          sessionRowCache = await prisma.omiSession.findUnique({
            where: { omiSessionId: String(session_id) },
            include: { user: true, preferences: true }
          });
        } catch {}
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

      // Background persistence and notifications
      if (ENABLE_USER_SYSTEM && prisma) {
        const backgroundSessionId = String(session_id);
        const backgroundSegments = Array.isArray(segments) ? segments.slice() : [];
        const backgroundLinkedUserId = linkedUserId;
        const backgroundConversationId = conversationId ? String(conversationId) : null;
        const backgroundQuestion = question;
        const backgroundAiResponse = aiResponse;
        setImmediate(async () => {
          try {
            const sessionUpdate = { lastSeenAt: new Date() };
            const sessionCreate = { omiSessionId: backgroundSessionId };
            if (backgroundLinkedUserId) {
              sessionUpdate.userId = backgroundLinkedUserId;
              sessionCreate.userId = backgroundLinkedUserId;
            }
            if (backgroundConversationId) {
              sessionUpdate.openaiConversationId = backgroundConversationId;
              sessionCreate.openaiConversationId = backgroundConversationId;
            }
            const sessionRow = await prisma.omiSession.upsert({
              where: { omiSessionId: backgroundSessionId },
              update: sessionUpdate,
              create: sessionCreate
            });
            const sessionRowId = sessionRow?.id;

            if (sessionRowId && backgroundSegments.length) {
              try {
                const operations = backgroundSegments.map((seg) => {
                  if (!seg) return Promise.resolve();
                  const text = String(seg.text || '');
                  const omiSegmentId = String(seg.id || seg.segment_id || crypto.createHash('sha1').update(text).digest('hex'));
                  return prisma.transcriptSegment.upsert({
                    where: { omiSessionId_omiSegmentId: { omiSessionId: sessionRowId, omiSegmentId } },
                    update: { text, speaker: seg.speaker || null, speakerId: (seg.speaker_id ?? seg.speakerId ?? null), isUser: seg.is_user ?? null, start: seg.start ?? null, end: seg.end ?? null },
                    create: { omiSessionId: sessionRowId, omiSegmentId, text, speaker: seg.speaker || null, speakerId: (seg.speaker_id ?? seg.speakerId ?? null), isUser: seg.is_user ?? null, start: seg.start ?? null, end: seg.end ?? null }
                  }).catch((err) => {
                    console.error('Transcript segment upsert failed:', err);
                  });
                });
                await Promise.all(operations);
              } catch (err) {
                console.error('Background transcript persistence failed:', err);
              }
            }

            if (sessionRowId && backgroundConversationId) {
              try {
                const conversationRow = await prisma.conversation.upsert({
                  where: { omiSessionId_openaiConversationId: { omiSessionId: sessionRowId, openaiConversationId: backgroundConversationId } },
                  update: {},
                  create: { omiSessionId: sessionRowId, openaiConversationId: backgroundConversationId }
                });
                if (backgroundQuestion) {
                  await prisma.message.create({ data: { conversationId: conversationRow.id, role: 'USER', text: backgroundQuestion, source: 'OMI_TRANSCRIPT' } });
                }
                if (backgroundAiResponse) {
                  await prisma.message.create({ data: { conversationId: conversationRow.id, role: 'ASSISTANT', text: backgroundAiResponse, source: 'SYSTEM' } });
                }
                if (sessionRow.userId) {
                  const userId = sessionRow.userId;
                  let active = await prisma.userContextWindow.findFirst({ where: { userId, isActive: true } });
                  if (!active) {
                    const existingSlot1 = await prisma.userContextWindow.findUnique({ where: { userId_slot: { userId, slot: 1 } } });
                    if (!existingSlot1) {
                      await prisma.userContextWindow.create({ data: { userId, slot: 1, conversationId: conversationRow.id, isActive: true } });
                    } else {
                      await prisma.userContextWindow.update({ where: { userId_slot: { userId, slot: 1 } }, data: { conversationId: conversationRow.id, isActive: true } });
                    }
                  } else {
                    await prisma.userContextWindow.update({ where: { userId_slot: { userId, slot: active.slot } }, data: { conversationId: conversationRow.id } });
                  }
                }
              } catch (err) {
                console.error('Background conversation save failed:', err);
              }
            }
          } catch (err) {
            console.error('Background session persistence failed:', err);
          }
        });
      }
      return jsonRes;
    } catch (e) {
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });
};

