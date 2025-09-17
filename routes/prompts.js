'use strict';

const { runPrompt } = require('../services/promptRunner');

module.exports = function createPromptRoutes({ app, prisma, openai, OPENAI_MODEL }) {
  if (!app) throw new Error('app is required');

  app.post('/prompts/run', async (req, res) => {
    try {
      const { prompt_id, variables } = req.body || {};
      if (!prompt_id) return res.status(400).json({ error: 'prompt_id is required' });
      const { output, output_type } = await runPrompt({ promptId: String(prompt_id), variables }, { openai, model: OPENAI_MODEL });
      // Persist as memory when configured
      if (output_type === 'memory' && prisma && req.user?.id) {
        try { await prisma.memory.create({ data: { userId: req.user.id, text: output } }); } catch {}
      }
      return res.status(200).json({ ok: true, output, output_type });
    } catch (e) {
      return res.status(400).json({ error: e?.message || 'Failed to run prompt' });
    }
  });
};

