'use strict';

const fs = require('fs');
const path = require('path');

function loadPromptConfigs() {
  const cfgPath = path.join(process.cwd(), 'config', 'prompts.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed;
  } catch {
    return {};
  }
}

async function runPrompt({ promptId, variables }, { openai, model = 'gpt-5-mini-2025-08-07' }) {
  const prompts = loadPromptConfigs();
  const cfg = prompts[promptId];
  if (!cfg) throw new Error('Prompt config not found: ' + promptId);
  const prompt = (cfg.prompt || '').replace(/\{(\w+)\}/g, (_, key) => String(variables?.[key] ?? ''));
  const response = await openai.responses.create({ model, input: prompt });
  return { output: response.output_text, output_type: cfg.output_type || 'text' };
}

module.exports = { loadPromptConfigs, runPrompt };

