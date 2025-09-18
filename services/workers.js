'use strict';

const { ENABLE_PROMPT_WORKERS } = require('../featureFlags');

// Optional env flags to toggle specific worker tasks without redeploys
const {
  ENABLE_TOOL_JOBS = 'true',
  ENABLE_VECTOR_BACKUP = 'true',
  WORKER_TICK_MS = '15000',
  VECTOR_BATCH_SIZE = '50',
} = process.env;

async function processToolJobs({ prisma, logger }) {
  // Runs only if a ToolJob model exists in Prisma schema
  if (!prisma || !prisma.toolJob || typeof prisma.toolJob.findFirst !== 'function') return;
  // Process one job at a time to keep it simple and avoid thundering herd
  const job = await prisma.toolJob.findFirst({
    where: {
      status: { in: ['PENDING', 'RETRY'] },
      nextRunAt: { lte: new Date() },
    },
    orderBy: { createdAt: 'asc' },
  }).catch(() => null);
  if (!job) return;
  try {
    // Mark running
    await prisma.toolJob.update({ where: { id: job.id }, data: { status: 'RUNNING', lastError: null } });
    // Example: implement a WEB_SEARCH job using a pluggable provider
    if (job.type === 'WEB_SEARCH') {
      const query = job.payload?.query || job.payload?.q;
      if (!query) throw new Error('Missing query');
      const results = await runWebSearch(query, logger);
      // Persist results back (assuming columns: outputText, completedAt)
      await prisma.toolJob.update({
        where: { id: job.id },
        data: { status: 'DONE', outputJson: results, completedAt: new Date() },
      });
      return;
    }
    // Unknown type
    await prisma.toolJob.update({ where: { id: job.id }, data: { status: 'FAILED', lastError: 'Unknown job type' } });
  } catch (e) {
    // Exponential backoff retry policy, assuming retryCount/nextRunAt columns
    const retryCount = (job.retryCount || 0) + 1;
    const backoffMs = Math.min(60_000, 2 ** Math.min(6, retryCount) * 1000);
    await prisma.toolJob.update({
      where: { id: job.id },
      data: {
        status: retryCount >= 6 ? 'FAILED' : 'RETRY',
        retryCount,
        nextRunAt: new Date(Date.now() + backoffMs),
        lastError: e?.message || String(e),
      },
    }).catch(() => {});
    logger.warn('Tool job error:', job.type, e?.message || e);
  }
}

async function syncMemoriesToVectorStore({ prisma, openai, logger }) {
  // Requires memory table; optional memoryVector table with columns: memoryId (unique), embedding (vector), createdAt
  if (!prisma || !prisma.memory || typeof prisma.memory.findMany !== 'function') return;
  // If vector target model is missing, noop
  if (!prisma.memoryVector || typeof prisma.memoryVector.createMany !== 'function') return;
  // Find memories that are not yet embedded (left join-like)
  const missing = await prisma.$queryRawUnsafe(`
    SELECT m.id, m.text
    FROM "Memory" m
    LEFT JOIN "MemoryVector" v ON v."memoryId" = m.id
    WHERE v."memoryId" IS NULL
    ORDER BY m."createdAt" ASC
    LIMIT ${Number(VECTOR_BATCH_SIZE) || 50}
  `).catch(() => []);
  if (!missing || missing.length === 0) return;
  try {
    // Create embeddings via OpenAI if available
    if (!openai || !openai.embeddings || typeof openai.embeddings.create !== 'function') {
      logger.log('Vector backup skipped: openai embeddings not configured');
      return;
    }
    const inputs = missing.map((m) => m.text || '');
    const { data } = await openai.embeddings.create({ model: 'text-embedding-3-small', input: inputs });
    const rows = missing.map((m, i) => ({ memoryId: m.id, embedding: data[i]?.embedding || [] }));
    await prisma.memoryVector.createMany({ data: rows, skipDuplicates: true });
    logger.log(`Backed up ${rows.length} memory embeddings to vector store`);
  } catch (e) {
    logger.warn('Vector backup error:', e?.message || e);
  }
}

async function runWebSearch(query, logger) {
  // Try Bing first if key present, else SerpAPI, else fallback to DuckDuckGo html
  try {
    if (process.env.BING_SEARCH_V7_SUBSCRIPTION_KEY) {
      const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=5&textDecorations=false&textFormat=Raw`;
      const res = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': process.env.BING_SEARCH_V7_SUBSCRIPTION_KEY } });
      const json = await res.json();
      return { provider: 'bing', json };
    }
  } catch (e) {
    logger.warn('Bing search failed:', e?.message || e);
  }
  try {
    if (process.env.SERPAPI_KEY) {
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&engine=google&num=5&api_key=${process.env.SERPAPI_KEY}`;
      const res = await fetch(url);
      const json = await res.json();
      return { provider: 'serpapi', json };
    }
  } catch (e) {
    logger.warn('SerpAPI search failed:', e?.message || e);
  }
  // Minimal fallback: DuckDuckGo lite HTML (no key) – return top titles/links by regex
  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    const html = await res.text();
    const items = Array.from(html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)).slice(0, 5).map((m) => ({ url: m[1], title: m[2]?.replace(/<[^>]+>/g, '') }));
    return { provider: 'duckduckgo', items };
  } catch (e) {
    return { provider: 'none', error: e?.message || String(e) };
  }
}

function startBackgroundWorkers({ prisma, openai, logger = console }) {
  if (!ENABLE_PROMPT_WORKERS) {
    logger.log('Background workers disabled.');
    return { stop: () => {} };
  }

  let stopped = false;
  const tickMs = Number(WORKER_TICK_MS) || 15000;
  const interval = setInterval(async () => {
    if (stopped) return;
    try {
      // Modular tasks – each is safe to no-op if schema/env is missing
      if (ENABLE_TOOL_JOBS === 'true') {
        await processToolJobs({ prisma, logger });
      }
      if (ENABLE_VECTOR_BACKUP === 'true') {
        await syncMemoriesToVectorStore({ prisma, openai, logger });
      }
    } catch (e) {
      logger.warn('Worker tick error:', e?.message || e);
    }
  }, tickMs);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    }
  };
}

module.exports = { startBackgroundWorkers };

