'use strict';

const { ENABLE_PROMPT_WORKERS } = require('../featureFlags');

function startBackgroundWorkers({ prisma, openai, logger = console }) {
  if (!ENABLE_PROMPT_WORKERS) {
    logger.log('Background workers disabled.');
    return { stop: () => {} };
  }

  let stopped = false;
  const interval = setInterval(async () => {
    if (stopped) return;
    try {
      // Placeholder: retry failed imports, run scheduled prompt jobs
      // This can be extended to pull from a jobs table.
    } catch (e) {
      logger.warn('Worker tick error:', e?.message || e);
    }
  }, 15000);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    }
  };
}

module.exports = { startBackgroundWorkers };

