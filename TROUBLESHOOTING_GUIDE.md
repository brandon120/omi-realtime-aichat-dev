# Omi AI Chat Plugin - Troubleshooting Guide

## Quick Reference

### Health Check Commands
```bash
# Basic health check
curl http://localhost:3000/health

# Performance metrics
curl http://localhost:3000/metrics

# Memory statistics for user
curl http://localhost:3000/memories/user123/stats
```

### Log Analysis Commands
```bash
# Monitor logs in real-time
tail -f server.log | grep -E "(⚡|🔍|🧹|⚠️|❌)"

# Check performance logs
grep "response_time_ms" server.log

# Check memory search logs
grep "Memory search" server.log
```

## Common Issues & Solutions

### 1. High Memory Usage

#### Symptoms
- Server becomes slow
- Memory usage grows continuously
- Out of memory errors
- High response times

#### Diagnosis
```bash
# Check memory usage
curl http://localhost:3000/metrics | jq '.performance.memoryUsage'

# Check active sessions
curl http://localhost:3000/health | jq '.conversation_state'

# Check cleanup status
grep "Cleanup completed" server.log | tail -10
```

#### Solutions
1. **Restart server** if memory usage is critical
2. **Check cleanup intervals** are running
3. **Verify memory limits** are enforced
4. **Monitor cache sizes**

#### Configuration Fix
```javascript
// Reduce memory limits if needed
const MEMORY_CONFIG = {
  MAX_MEMORIES_PER_USER: 500,  // Reduced from 1000
  MAX_EMBEDDING_CACHE_SIZE: 5000,  // Reduced from 10000
  // ... other settings
};
```

### 2. Slow Response Times

#### Symptoms
- Response times >5 seconds
- Users reporting delays
- Timeout errors

#### Diagnosis
```bash
# Check average response time
curl http://localhost:3000/metrics | jq '.performance.averageResponseTime'

# Check cache hit rate
curl http://localhost:3000/metrics | jq '.performance.cacheHitRate'

# Check memory search performance
grep "Memory search completed" server.log | tail -10
```

#### Solutions
1. **Check cache hit rates** - should be >80%
2. **Verify local search** is working
3. **Check ChromaDB connectivity**
4. **Monitor OpenAI API** response times

#### Performance Tuning
```javascript
// Increase cache size for better hit rates
const MEMORY_CONFIG = {
  MAX_EMBEDDING_CACHE_SIZE: 20000,  // Increased
  // ... other settings
};

// Reduce search thresholds for faster responses
const MEMORY_CONFIG = {
  SIMPLE_QUESTION_THRESHOLD: 30,  // Lower threshold
  MEMORY_SEARCH_THRESHOLD: 2,     // Earlier search
  // ... other settings
};
```

### 3. Memory Search Issues

#### Symptoms
- No memories found
- Inconsistent search results
- Search errors in logs

#### Diagnosis
```bash
# Check user memories
curl http://localhost:3000/memories/user123/all

# Test memory search
curl -X POST http://localhost:3000/memories/search \
  -H "Content-Type: application/json" \
  -d '{"userId": "user123", "query": "test"}'

# Check local search logs
grep "Local memory search" server.log | tail -10
```

#### Solutions
1. **Check local memory storage**
2. **Verify ChromaDB connectivity**
3. **Check embedding generation**
4. **Review search thresholds**

#### Debug Steps
```javascript
// Add debug logging to searchMemoriesLocally function
function searchMemoriesLocally(userId, query, limit = 5) {
    console.log(`🔍 Local search for user ${userId}, query: "${query}"`);
    const userMemories = memoryStorage.get(userId) || [];
    console.log(`📊 User has ${userMemories.length} memories`);
    // ... rest of function
}
```

### 4. ChromaDB Connection Issues

#### Symptoms
- ChromaDB errors in logs
- Memory operations failing
- Fallback to local-only mode

#### Diagnosis
```bash
# Check ChromaDB status
curl http://localhost:3000/health | jq '.memory_system'

# Check ChromaDB logs
grep "ChromaDB" server.log | tail -10

# Test ChromaDB connectivity
curl http://localhost:8000/api/v1/heartbeat
```

#### Solutions
1. **Check ChromaDB server status**
2. **Verify connection settings**
3. **Check authentication**
4. **Monitor fallback performance**

#### Configuration Fix
```bash
# Set ChromaDB URL
export CHROMA_URL=http://localhost:8000

# Set authentication token
export CHROMA_AUTH_TOKEN=your_token

# Restart server
npm start
```

### 5. Embedding Generation Issues

#### Symptoms
- Embedding generation errors
- Slow memory operations
- Cache miss rates high

#### Diagnosis
```bash
# Check embedding generation count
curl http://localhost:3000/metrics | jq '.performance.embeddingGenerationCount'

# Check cache hit rate
curl http://localhost:3000/metrics | jq '.performance.cacheHitRate'

# Check embedding errors
grep "Failed to generate embedding" server.log | tail -10
```

#### Solutions
1. **Check OpenAI API key**
2. **Verify API rate limits**
3. **Check network connectivity**
4. **Monitor cache performance**

### 6. Session Management Issues

#### Symptoms
- Sessions not cleaning up
- Memory leaks
- Old data accumulating

#### Diagnosis
```bash
# Check active sessions
curl http://localhost:3000/health | jq '.conversation_state'

# Check cleanup logs
grep "Cleanup completed" server.log | tail -10

# Check session counts
curl http://localhost:3000/metrics | jq '.performance.memoryUsage.sessions'
```

#### Solutions
1. **Check cleanup intervals**
2. **Verify cleanup triggers**
3. **Monitor session growth**
4. **Adjust cleanup thresholds**

## Performance Monitoring

### Key Metrics to Watch

#### Response Time
- **Good**: <2 seconds
- **Warning**: 2-5 seconds
- **Critical**: >5 seconds

#### Cache Hit Rate
- **Good**: >80%
- **Warning**: 60-80%
- **Critical**: <60%

#### Memory Usage
- **Good**: Stable growth
- **Warning**: Rapid growth
- **Critical**: Continuous growth

### Monitoring Commands

#### Real-time Monitoring
```bash
# Watch performance metrics
watch -n 5 'curl -s http://localhost:3000/metrics | jq ".performance"'

# Monitor response times
tail -f server.log | grep "response_time_ms"

# Check memory usage
watch -n 10 'curl -s http://localhost:3000/metrics | jq ".performance.memoryUsage"'
```

#### Performance Analysis
```bash
# Analyze response times
grep "response_time_ms" server.log | awk '{print $NF}' | sort -n

# Check cache performance
grep "cache_hit\|cache_miss" server.log | tail -20

# Monitor memory search performance
grep "Memory search completed" server.log | tail -20
```

## Debugging Tools

### 1. Memory Debugging

#### Check Memory Storage
```javascript
// Add to server.js for debugging
app.get('/debug/memory/:userId', (req, res) => {
  const { userId } = req.params;
  const memories = memoryStorage.get(userId) || [];
  const index = memoryIndex.get(userId) || new Map();
  
  res.json({
    userId,
    memoryCount: memories.length,
    memories: memories.slice(-10), // Last 10 memories
    categories: Array.from(index.keys()),
    categoryCounts: Object.fromEntries(
      Array.from(index.entries()).map(([cat, ids]) => [cat, ids.length])
    )
  });
});
```

#### Test Memory Search
```javascript
// Add to server.js for debugging
app.post('/debug/search/:userId', async (req, res) => {
  const { userId } = req.params;
  const { query } = req.body;
  
  const localResults = searchMemoriesLocally(userId, query, 5);
  const chromaResults = await searchMemoriesChromaDB(userId, query, 5);
  
  res.json({
    userId,
    query,
    localResults,
    chromaResults,
    localCount: localResults.length,
    chromaCount: chromaResults.length
  });
});
```

### 2. Performance Debugging

#### Response Time Analysis
```javascript
// Add to server.js for debugging
app.get('/debug/performance', (req, res) => {
  const metrics = getPerformanceMetrics();
  const recentRequests = performanceMetrics.recentRequests || [];
  
  res.json({
    current: metrics,
    recent: recentRequests.slice(-20),
    trends: {
      avgResponseTime: recentRequests.reduce((a, b) => a + b, 0) / recentRequests.length,
      maxResponseTime: Math.max(...recentRequests),
      minResponseTime: Math.min(...recentRequests)
    }
  });
});
```

### 3. Cache Debugging

#### Cache Analysis
```javascript
// Add to server.js for debugging
app.get('/debug/cache', (req, res) => {
  const cacheEntries = Array.from(embeddingCache.entries());
  
  res.json({
    cacheSize: embeddingCache.size,
    maxSize: MEMORY_CONFIG.MAX_EMBEDDING_CACHE_SIZE,
    hitRate: performanceMetrics.cacheHits / (performanceMetrics.cacheHits + performanceMetrics.cacheMisses),
    sampleEntries: cacheEntries.slice(0, 10).map(([hash, embedding]) => ({
      hash: hash.substring(0, 20) + '...',
      embeddingLength: embedding.length
    }))
  });
});
```

## Configuration Tuning

### High-Traffic Configuration
```javascript
const MEMORY_CONFIG = {
  MAX_MEMORIES_PER_USER: 2000,
  MAX_EMBEDDING_CACHE_SIZE: 20000,
  BATCH_EMBEDDING_SIZE: 20,
  MEMORY_CLEANUP_INTERVAL: 15 * 60 * 1000, // 15 minutes
  SIMPLE_QUESTION_THRESHOLD: 30,
  MEMORY_SEARCH_THRESHOLD: 2
};

const SESSION_CONFIG = {
  MAX_SESSION_AGE: 3 * 60 * 1000, // 3 minutes
  MAX_CONVERSATION_AGE: 20 * 60 * 1000, // 20 minutes
  CLEANUP_INTERVAL: 60000, // 1 minute
  MAX_SESSIONS: 2000
};
```

### Low-Memory Configuration
```javascript
const MEMORY_CONFIG = {
  MAX_MEMORIES_PER_USER: 500,
  MAX_EMBEDDING_CACHE_SIZE: 5000,
  BATCH_EMBEDDING_SIZE: 5,
  MEMORY_CLEANUP_INTERVAL: 10 * 60 * 1000, // 10 minutes
  SIMPLE_QUESTION_THRESHOLD: 100,
  MEMORY_SEARCH_THRESHOLD: 5
};

const SESSION_CONFIG = {
  MAX_SESSION_AGE: 2 * 60 * 1000, // 2 minutes
  MAX_CONVERSATION_AGE: 15 * 60 * 1000, // 15 minutes
  CLEANUP_INTERVAL: 30000, // 30 seconds
  MAX_SESSIONS: 500
};
```

## Emergency Procedures

### 1. Server Overload
```bash
# Stop server
pkill -f "node server.js"

# Clear all data (emergency only)
rm -rf *.log
rm -rf data/

# Restart with minimal config
NODE_ENV=production npm start
```

### 2. Memory Leak
```bash
# Check memory usage
ps aux | grep node

# Force garbage collection (if available)
node --expose-gc -e "global.gc()"

# Restart with cleanup
npm start
```

### 3. ChromaDB Failure
```bash
# Disable ChromaDB temporarily
export CHROMA_URL=""
npm start

# Check local-only performance
curl http://localhost:3000/metrics
```

## Log Analysis

### Key Log Patterns
```bash
# Performance issues
grep -E "(slow|timeout|error)" server.log

# Memory issues
grep -E "(memory|cleanup|leak)" server.log

# Cache issues
grep -E "(cache|hit|miss)" server.log

# Search issues
grep -E "(search|memory|found)" server.log
```

### Performance Analysis
```bash
# Response time distribution
grep "response_time_ms" server.log | awk '{print $NF}' | sort -n | uniq -c

# Cache hit rate over time
grep "cache_hit\|cache_miss" server.log | tail -100 | awk '{print $1}' | sort | uniq -c

# Memory search performance
grep "Memory search completed" server.log | awk '{print $NF}' | sort -n
```

This troubleshooting guide provides comprehensive tools and procedures for diagnosing and fixing issues with the optimized Omi AI Chat Plugin system.