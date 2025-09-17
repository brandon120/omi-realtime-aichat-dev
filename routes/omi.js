'use strict';

const { buildActivationRegex, withinQuietHours, normalizeText, isNearDuplicate } = require('../services/activation');
const { ENABLE_CONTEXT_ACTIVATION, QUIET_HOURS_ENABLED } = require('../featureFlags');

module.exports = function createOmiRoutes({ app, prisma, openai, OPENAI_MODEL, ENABLE_USER_SYSTEM }) {
  if (!app) throw new Error('app is required');

  // Helper: fetch session + user preferences and derive activation config
  async function loadActivationConfig(sessionId) {
    let pref = { listenMode: 'TRIGGER', followupWindowMs: 8000, injectMemories: false, meetingTranscribe: false };
    let sessionPref = null;
    let user = null;
    if (ENABLE_USER_SYSTEM && prisma) {
      const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(sessionId) }, include: { user: true, preferences: true } });
      if (sessionRow) {
        sessionPref = sessionRow.preferences || null;
        user = sessionRow.user || null;
      }
      if (user) {
        const up = await prisma.userPreference.findUnique({ where: { userId: user.id } });
        if (up) pref = up;
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
    try {
      const { session_id, segments } = req.body || {};
      if (!session_id || !Array.isArray(segments)) return res.status(400).json({ error: 'session_id and segments[] required' });

      // Persist segments immediately for idempotency
      if (ENABLE_USER_SYSTEM && prisma) {
        const payloadUserId = req.body?.user_id ? String(req.body.user_id) : null;
        let linkedUserId = null;
        if (payloadUserId) {
          try {
            const link = await prisma.omiUserLink.findUnique({ where: { omiUserId: payloadUserId } });
            if (link && link.isVerified) linkedUserId = link.userId;
          } catch {}
        }
        const sessionRow = await prisma.omiSession.upsert({
          where: { omiSessionId: String(session_id) },
          update: { lastSeenAt: new Date(), ...(linkedUserId ? { userId: linkedUserId } : {}) },
          create: { omiSessionId: String(session_id), ...(linkedUserId ? { userId: linkedUserId } : {}) }
        });
        for (const seg of segments) {
          const text = String(seg.text || '');
          const omiSegmentId = String(seg.id || seg.segment_id || require('crypto').createHash('sha1').update(text).digest('hex'));
          try {
            await prisma.transcriptSegment.upsert({
              where: { omiSessionId_omiSegmentId: { omiSessionId: sessionRow.id, omiSegmentId } },
              update: { text, speaker: seg.speaker || null, speakerId: seg.speaker_id ?? null, isUser: seg.is_user ?? null, start: seg.start ?? null, end: seg.end ?? null },
              create: { omiSessionId: sessionRow.id, omiSegmentId, text, speaker: seg.speaker || null, speakerId: seg.speaker_id ?? null, isUser: seg.is_user ?? null, start: seg.start ?? null, end: seg.end ?? null }
            });
          } catch {}
        }
      }

      const { pref, regex } = await loadActivationConfig(session_id);

      // Meeting transcribe special mode: only persist (already done) and optionally return on end
      if (pref.meetingTranscribe) {
        const endSignal = Boolean(req.body?.end || req.body?.final || req.body?.is_final) ||
          segments.some((s) => s?.end === true || s?.final === true || s?.is_final === true || s?.is_last_segment === true || s?.segment_type === 'end');
        if (!endSignal) return res.status(200).json({});
        return res.status(200).json({ message: 'Meeting transcribed and saved.' });
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
          const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
          if (sessionRow && sessionRow.userId) {
            const mems = await prisma.memory.findMany({ where: { userId: sessionRow.userId }, orderBy: { createdAt: 'desc' }, take: 20 });
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
          const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
          if (sessionRow && sessionRow.openaiConversationId) {
            conversationId = sessionRow.openaiConversationId;
          }
        } catch {}
      }
      if (!conversationId) {
        try {
          const conversation = await openai.conversations.create({ metadata: { omi_session_id: String(session_id) } });
          conversationId = conversation.id;
          if (ENABLE_USER_SYSTEM && prisma) {
            try { await prisma.omiSession.update({ where: { omiSessionId: String(session_id) }, data: { openaiConversationId: conversationId } }); } catch {}
          }
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

      // Persist conversation + messages
      if (ENABLE_USER_SYSTEM && prisma && conversationId) {
        (async () => {
          try {
            const sessionRow = await prisma.omiSession.findUnique({ where: { omiSessionId: String(session_id) } });
            if (!sessionRow) return;
            const conversationRow = await prisma.conversation.upsert({
              where: { omiSessionId_openaiConversationId: { omiSessionId: sessionRow.id, openaiConversationId: String(conversationId) } },
              update: {},
              create: { omiSessionId: sessionRow.id, openaiConversationId: String(conversationId) }
            });
            await prisma.message.create({ data: { conversationId: conversationRow.id, role: 'USER', text: question, source: 'OMI_TRANSCRIPT' } });
            await prisma.message.create({ data: { conversationId: conversationRow.id, role: 'ASSISTANT', text: aiResponse, source: 'SYSTEM' } });
            // Ensure user's active window points to this conversation
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
          } catch {}
        })();
      }

      return res.status(200).json({ message: aiResponse });
    } catch (e) {
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });
};

