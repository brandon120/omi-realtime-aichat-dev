'use strict';

const crypto = require('crypto');

module.exports = function createRealtimeRouter({ app, prisma, ENABLE_USER_SYSTEM }) {
  if (!app) throw new Error('app is required');

  app.post('/realtime/transcripts', async (req, res) => {
    try {
      const sessionId = String(req.query.session_id || req.body?.session_id || '').trim();
      const uid = req.query.uid ? String(req.query.uid) : undefined;
      const segments = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.segments) ? req.body.segments : [];
      if (!sessionId || !segments.length) {
        return res.status(400).json({ error: 'session_id and segments[] are required' });
      }

      if (ENABLE_USER_SYSTEM && prisma) {
        // Upsert OmiSession and link to user via OmiUserLink when possible
        let linkedUserId = null;
        if (uid) {
          try {
            const link = await prisma.omiUserLink.findUnique({ where: { omiUserId: uid } });
            if (link && link.isVerified) linkedUserId = link.userId;
          } catch {}
        }
        const sessionRow = await prisma.omiSession.upsert({
          where: { omiSessionId: sessionId },
          update: { lastSeenAt: new Date(), ...(linkedUserId ? { userId: linkedUserId } : {}) },
          create: { omiSessionId: sessionId, ...(linkedUserId ? { userId: linkedUserId } : {}) }
        });

        // Persist segments idempotently using (omiSessionId, omiSegmentId)
        for (const seg of segments) {
          const text = String(seg.text || '');
          const omiSegmentId = String(seg.id || seg.segment_id || crypto.createHash('sha1').update(text).digest('hex'));
          try {
            await prisma.transcriptSegment.upsert({
              where: { omiSessionId_omiSegmentId: { omiSessionId: sessionRow.id, omiSegmentId } },
              update: { text, speaker: seg.speaker || null, speakerId: seg.speaker_id ?? null, isUser: seg.is_user ?? null, start: seg.start ?? null, end: seg.end ?? null },
              create: { omiSessionId: sessionRow.id, omiSegmentId, text, speaker: seg.speaker || null, speakerId: seg.speaker_id ?? null, isUser: seg.is_user ?? null, start: seg.start ?? null, end: seg.end ?? null }
            });
          } catch {}
        }
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to persist realtime transcripts' });
    }
  });
};

