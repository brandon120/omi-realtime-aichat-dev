const express = require('express');
const https = require('https');
const OpenAI = require('openai');
const { ChromaClient } = require('chromadb');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

/**
 * Omi AI Chat Plugin Server
 * 
 * TRIGGER PHRASES: Users must start their message with one of these to activate the AI:
 * - "Hey Omi" (most common)
 * - "Hey, Omi" (with comma)
 * - "Hey Omi," (with trailing comma)
 * - "Hey, Omi," (with both commas)
 * 
 * HELP KEYWORDS: Users can ask for help using these words:
 * - "help", "what can you do", "how to use", "instructions", "guide"
 * - "what do you do", "how does this work", "what are the commands"
 * - "keywords", "trigger words", "how to talk to you"
 */

const app = express();
const PORT = process.env.PORT || 3000;

// Session storage to accumulate transcript segments
const sessionTranscripts = new Map();

// Conversation history storage to maintain context between interactions
const conversationHistory = new Map();

// Track processed content to prevent duplicate notifications
const processedContent = new Map();

// Enhanced memory storage with local caching and efficient search
const memoryStorage = new Map(); // In-memory cache for quick access
const embeddingCache = new Map(); // Cache for embeddings to avoid regeneration
const memoryIndex = new Map(); // Fast lookup index by user and category
let chromaClient = null;
let memoriesCollection = null;
let isChromaDBInitialized = false;

// Memory storage configuration
const MEMORY_CONFIG = {
  MAX_MEMORIES_PER_USER: 1000,
  MAX_EMBEDDING_CACHE_SIZE: 10000,
  BATCH_EMBEDDING_SIZE: 10,
  MEMORY_CLEANUP_INTERVAL: 30 * 60 * 1000, // 30 minutes
  SIMPLE_QUESTION_THRESHOLD: 50, // characters
  MEMORY_SEARCH_THRESHOLD: 3 // minimum conversation length to search memories
};

// Performance monitoring
const performanceMetrics = {
  totalRequests: 0,
  averageResponseTime: 0,
  memorySearchCount: 0,
  embeddingGenerationCount: 0,
  cacheHits: 0,
  cacheMisses: 0,
  lastCleanup: Date.now()
};

// Session management configuration
const SESSION_CONFIG = {
  MAX_SESSION_AGE: 5 * 60 * 1000, // 5 minutes
  MAX_CONVERSATION_AGE: 30 * 60 * 1000, // 30 minutes
  CLEANUP_INTERVAL: 2 * 60 * 1000, // 2 minutes
  MAX_SESSIONS: 1000
};

/**
 * Check if ChromaDB is properly initialized and ready
 * @returns {boolean} True if ChromaDB is ready
 */
function isChromaDBReady() {
  return isChromaDBInitialized && chromaClient && memoriesCollection;
}

// Initialize ChromaDB for vector storage
async function initializeMemoryStorage() {
  try {
    // Check if ChromaDB URL is provided
    const chromaUrl = process.env.CHROMA_URL || "http://localhost:8000";
    const chromaAuthToken = process.env.CHROMA_AUTH_TOKEN;
    
    console.log('🔗 Connecting to ChromaDB at:', chromaUrl);
    console.log('🔑 Authentication:', chromaAuthToken ? 'Enabled' : 'Disabled');
    
    // Try to connect to ChromaDB with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    try {
      const headers = {};
      if (chromaAuthToken) {
        headers['Authorization'] = `Bearer ${chromaAuthToken}`;
      }
      
      const response = await fetch(`${chromaUrl}/api/v1/heartbeat`, {
        signal: controller.signal,
        headers: headers
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`ChromaDB server responded with status: ${response.status}`);
      }
      
      console.log('✅ ChromaDB heartbeat successful');
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw new Error(`ChromaDB server not available at ${chromaUrl}. Please start ChromaDB server.`);
    }
    
    // Configure ChromaDB client with authentication if needed
    const clientConfig = { path: chromaUrl };
    if (chromaAuthToken) {
      clientConfig.auth = {
        provider: 'token',
        credentials: chromaAuthToken
      };
    }
    
    chromaClient = new ChromaClient(clientConfig);
    
    // Create or get the memories collection - using manual embeddings for Railway compatibility
    console.log('📝 Using manual OpenAI embeddings for Railway compatibility');
    
    try {
      // Try to get existing collection first
      memoriesCollection = await chromaClient.getCollection({
        name: "omi_memories"
      });
      
      // Test if the collection works with embedding function by trying a simple query
      try {
        await memoriesCollection.query({
          queryTexts: ["test"],
          nResults: 1
        });
        console.log('📚 Using existing collection with embedding function');
      } catch (queryError) {
        if (queryError.message.includes('Bad request') || queryError.message.includes('400') || queryError.message.includes('chromadb-default-embed')) {
          console.log('🔄 Collection exists but needs embedding function, migrating...');
          // Get existing data before deleting
          let existingData = [];
          try {
            const existingMemories = await memoriesCollection.get();
            existingData = existingMemories.metadatas || [];
            console.log(`📦 Found ${existingData.length} existing memories to migrate`);
          } catch (getError) {
            console.log('⚠️ Could not retrieve existing data, will start fresh');
          }
          
          // Delete and recreate collection without embedding function
          await chromaClient.deleteCollection({ name: "omi_memories" });
          memoriesCollection = await chromaClient.createCollection({
            name: "omi_memories",
            metadata: { description: "Omi AI Chat Plugin Memory Storage" }
          });
          
          // Restore existing data if any
          if (existingData.length > 0) {
            console.log('🔄 Restoring existing memories...');
            const ids = existingData.map((_, index) => `migrated-${Date.now()}-${index}`);
            const documents = existingData.map(data => data.content || '');
            const metadatas = existingData.map(data => ({
              ...data,
              migrated: true,
              originalId: data.id
            }));
            
            await memoriesCollection.add({
              ids: ids,
              documents: documents,
              metadatas: metadatas
            });
            console.log(`✅ Restored ${existingData.length} memories`);
          }
          
          console.log('📚 Collection migrated with manual embeddings');
        } else {
          throw queryError;
        }
      }
    } catch (error) {
      if (error.message.includes('not found')) {
        // Collection doesn't exist, create it without embedding function
        memoriesCollection = await chromaClient.createCollection({
          name: "omi_memories",
          metadata: { description: "Omi AI Chat Plugin Memory Storage" }
        });
        console.log('📚 Created new collection with manual embeddings');
      } else {
        throw error;
      }
    }
    
    console.log('✅ Memory storage initialized with ChromaDB');
    console.log('📊 Collection name: omi_memories');
    isChromaDBInitialized = true;
  } catch (error) {
    console.error('❌ Failed to initialize ChromaDB:', error.message);
    console.log('💡 Troubleshooting steps:');
    console.log('   1. Check if ChromaDB server is running');
    console.log('   2. Verify CHROMA_URL environment variable');
    console.log('   3. Check CHROMA_AUTH_TOKEN if using authentication');
    console.log('   4. Test connection manually:');
    console.log('      curl -X GET "http://localhost:8000/api/v1/heartbeat"');
    console.log('   5. Start ChromaDB with Docker:');
    console.log('      docker run -p 8000:8000 chromadb/chroma:latest');
    console.log('   6. Check server logs for detailed error information');
    
    // Set initialization status to false
    isChromaDBInitialized = false;
    
    // Don't throw error - allow server to start without ChromaDB
    console.warn('⚠️ Server will continue without ChromaDB features');
  }
}

// Rate limiting for Omi notifications (max 10 per hour)
const notificationQueue = [];
const notificationHistory = new Map(); // Track notifications per user
const MAX_NOTIFICATIONS_PER_HOUR = 10;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

// Initialize OpenAI client (lazy initialization)
let openai = null;

function getOpenAIClient() {
  if (!openai) {
    if (!process.env.OPENAI_KEY) {
      throw new Error('OPENAI_KEY environment variable is not set');
    }
    openai = new OpenAI({
      apiKey: process.env.OPENAI_KEY,
    });
  }
  return openai;
}

// OpenAI Responses API configuration
const OPENAI_MODEL = "gpt-4o"; // You can change this to "gpt-4.1" when available
const WEB_SEARCH_TOOL = { type: "web_search_preview" };

// No need to create an assistant - Responses API handles everything
console.log('✅ Using OpenAI Responses API with web search');

/**
 * Sends a direct notification to an Omi user with rate limiting.
 * @param {string} userId - The Omi user's unique ID
 * @param {string} message - The notification text
 * @returns {Promise<object>} Response data or error
 */
async function sendOmiNotification(userId, message) {
    const appId = process.env.OMI_APP_ID;
    const appSecret = process.env.OMI_APP_SECRET;

    if (!appId) throw new Error("OMI_APP_ID not set");
    if (!appSecret) throw new Error("OMI_APP_SECRET not set");

    // Check rate limit for this user
    const now = Date.now();
    const userHistory = notificationHistory.get(userId) || [];
    
    // Remove notifications older than 1 hour
    const recentNotifications = userHistory.filter(timestamp => 
        now - timestamp < RATE_LIMIT_WINDOW
    );
    
    if (recentNotifications.length >= MAX_NOTIFICATIONS_PER_HOUR) {
        const oldestNotification = recentNotifications[0];
        const timeUntilReset = RATE_LIMIT_WINDOW - (now - oldestNotification);
        const minutesUntilReset = Math.ceil(timeUntilReset / (60 * 1000));
        
        throw new Error(`Rate limit exceeded. Maximum ${MAX_NOTIFICATIONS_PER_HOUR} notifications per hour. Try again in ${minutesUntilReset} minutes.`);
    }

    const options = {
        hostname: 'api.omi.me',
        path: `/v2/integrations/${appId}/notification?uid=${encodeURIComponent(userId)}&message=${encodeURIComponent(message)}`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${appSecret}`,
            'Content-Type': 'application/json',
            'Content-Length': 0
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        // Update rate limit tracking
                        if (!notificationHistory.has(userId)) {
                            notificationHistory.set(userId, []);
                        }
                        notificationHistory.get(userId).push(now);
                        
                        resolve(data ? JSON.parse(data) : {});
                    } catch (e) {
                        resolve({ raw: data });
                    }
                } else if (res.statusCode === 429) {
                    // Rate limit exceeded - update tracking and reject
                    if (!notificationHistory.has(userId)) {
                        notificationHistory.set(userId, []);
                    }
                    notificationHistory.get(userId).push(now);
                    
                    reject(new Error(`Rate limit exceeded. Maximum ${MAX_NOTIFICATIONS_PER_HOUR} notifications per hour.`));
                } else {
                    reject(new Error(`API Error (${res.statusCode}): ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Gets the current rate limit status for a user
 * @param {string} userId - The Omi user's unique ID
 * @returns {object} Rate limit information
 */
function getRateLimitStatus(userId) {
    const now = Date.now();
    const userHistory = notificationHistory.get(userId) || [];
    const recentNotifications = userHistory.filter(timestamp => 
        now - timestamp < RATE_LIMIT_WINDOW
    );
    
    const remainingNotifications = MAX_NOTIFICATIONS_PER_HOUR - recentNotifications.length;
    const timeUntilReset = recentNotifications.length > 0 ? 
        RATE_LIMIT_WINDOW - (now - recentNotifications[0]) : 0;
    
    return {
        remaining: Math.max(0, remainingNotifications),
        used: recentNotifications.length,
        limit: MAX_NOTIFICATIONS_PER_HOUR,
        timeUntilReset: Math.ceil(timeUntilReset / (60 * 1000)), // minutes
        isLimited: remainingNotifications <= 0
    };
}

/**
 * Manages conversation history for a session with optimized token handling
 * @param {string} sessionId - The session ID
 * @param {string} userMessage - The user's message
 * @param {string} aiResponse - The AI's response
 * @returns {Array} The conversation history array
 */
function manageConversationHistory(sessionId, userMessage, aiResponse) {
    // Get existing conversation history or create new one
    let history = conversationHistory.get(sessionId) || [];
    
    // Add the new exchange to history
    history.push(
        { role: 'user', content: userMessage, timestamp: Date.now() },
        { role: 'assistant', content: aiResponse, timestamp: Date.now() }
    );
    
    // Optimized token estimation and trimming
    const trimmedHistory = optimizeConversationHistory(history, sessionId);
    
    // Store updated history
    conversationHistory.set(sessionId, trimmedHistory);
    
    return trimmedHistory;
}

/**
 * Optimizes conversation history by removing old messages and keeping important context
 * @param {Array} history - Current conversation history
 * @param {string} sessionId - Session ID for logging
 * @returns {Array} Optimized conversation history
 */
function optimizeConversationHistory(history, sessionId) {
    if (history.length <= 20) {
        return history; // Keep recent conversations intact
    }
    
    // Estimate tokens more accurately
    const estimatedTokens = history.reduce((total, msg) => {
        const content = msg.content || '';
        return total + Math.ceil(content.length / 3.5); // More accurate token estimation
    }, 0);
    
    const MAX_TOKENS = 30000; // Reduced for better performance
    const MAX_MESSAGES = 30; // Maximum number of messages to keep
    
    if (estimatedTokens <= MAX_TOKENS && history.length <= MAX_MESSAGES) {
        return history;
    }
    
    // Keep system messages and recent messages
    const systemMessages = history.filter(msg => msg.role === 'system');
    const recentMessages = history.filter(msg => msg.role !== 'system').slice(-MAX_MESSAGES);
    
    // If we still have too many tokens, trim more aggressively
    let finalHistory = [...systemMessages, ...recentMessages];
    let finalTokens = finalHistory.reduce((total, msg) => total + Math.ceil((msg.content || '').length / 3.5), 0);
    
    if (finalTokens > MAX_TOKENS) {
        // Keep only the most recent messages that fit within token limit
        const messages = finalHistory.filter(msg => msg.role !== 'system');
        finalHistory = [...systemMessages];
        
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const msgTokens = Math.ceil((msg.content || '').length / 3.5);
            
            if (finalTokens + msgTokens <= MAX_TOKENS) {
                finalHistory.unshift(msg);
                finalTokens += msgTokens;
            } else {
                break;
            }
        }
    }
    
    console.log(`🧹 Optimized conversation history for session ${sessionId}: ${history.length} → ${finalHistory.length} messages`);
    return finalHistory;
}

/**
 * Gets conversation history for a session
 * @param {string} sessionId - The session ID
 * @returns {Array} The conversation history array
 */
function getConversationHistory(sessionId) {
    return conversationHistory.get(sessionId) || [];
}

/**
 * Clears conversation history for a session
 * @param {string} sessionId - The session ID
 */
function clearConversationHistory(sessionId) {
    conversationHistory.delete(sessionId);
    console.log(`🧹 Cleared conversation history for session: ${sessionId}`);
}

/**
 * Performance monitoring functions
 */
function updatePerformanceMetrics(operation, duration) {
    performanceMetrics.totalRequests++;
    performanceMetrics.averageResponseTime = 
        (performanceMetrics.averageResponseTime * (performanceMetrics.totalRequests - 1) + duration) / 
        performanceMetrics.totalRequests;
    
    if (operation === 'memory_search') performanceMetrics.memorySearchCount++;
    if (operation === 'embedding_generation') performanceMetrics.embeddingGenerationCount++;
    if (operation === 'cache_hit') performanceMetrics.cacheHits++;
    if (operation === 'cache_miss') performanceMetrics.cacheMisses++;
}

function getPerformanceMetrics() {
    return {
        ...performanceMetrics,
        cacheHitRate: performanceMetrics.cacheHits / (performanceMetrics.cacheHits + performanceMetrics.cacheMisses) || 0,
        memoryUsage: {
            sessions: sessionTranscripts.size,
            conversations: conversationHistory.size,
            memories: Array.from(memoryStorage.values()).reduce((total, memories) => total + memories.length, 0),
            embeddings: embeddingCache.size
        }
    };
}

/**
 * Optimized session cleanup with better memory management
 */
function performSessionCleanup() {
    const now = Date.now();
    let cleanedSessions = 0;
    let cleanedConversations = 0;
    
    // Clean up old session transcripts
    for (const [sessionId, segments] of sessionTranscripts.entries()) {
        const hasOldSegment = segments.some(segment => {
            const segmentTime = segment.end ? segment.end * 1000 : segment.timestamp || now;
            return (now - segmentTime) > SESSION_CONFIG.MAX_SESSION_AGE;
        });
        
        if (hasOldSegment) {
            sessionTranscripts.delete(sessionId);
            processedContent.delete(sessionId);
            cleanedSessions++;
        }
    }
    
    // Clean up old conversation history
    for (const [sessionId, history] of conversationHistory.entries()) {
        if (history.length > 0) {
            const lastMessage = history[history.length - 1];
            const lastActivity = lastMessage.timestamp || 0;
            
            if ((now - lastActivity) > SESSION_CONFIG.MAX_CONVERSATION_AGE || history.length > 50) {
                clearConversationHistory(sessionId);
                cleanedConversations++;
            }
        }
    }
    
    // Clean up rate limit history
    for (const [userId, timestamps] of notificationHistory.entries()) {
        const recentTimestamps = timestamps.filter(timestamp => 
            (now - timestamp) < RATE_LIMIT_WINDOW
        );
        
        if (recentTimestamps.length === 0) {
            notificationHistory.delete(userId);
        } else {
            notificationHistory.set(userId, recentTimestamps);
        }
    }
    
    // Clean up embedding cache if it's too large
    if (embeddingCache.size > MEMORY_CONFIG.MAX_EMBEDDING_CACHE_SIZE) {
        const entries = Array.from(embeddingCache.entries());
        const toDelete = entries.slice(0, Math.floor(entries.length / 2));
        toDelete.forEach(([key]) => embeddingCache.delete(key));
    }
    
    // Clean up memory storage if it's too large
    for (const [userId, memories] of memoryStorage.entries()) {
        if (memories.length > MEMORY_CONFIG.MAX_MEMORIES_PER_USER) {
            memories.splice(0, memories.length - MEMORY_CONFIG.MAX_MEMORIES_PER_USER);
        }
    }
    
    if (cleanedSessions > 0 || cleanedConversations > 0) {
        console.log(`🧹 Cleanup completed: ${cleanedSessions} sessions, ${cleanedConversations} conversations`);
    }
    
    performanceMetrics.lastCleanup = now;
}


/**
 * Saves a memory with optimized storage and caching
 * @param {string} userId - The user ID
 * @param {string} content - The memory content
 * @param {string} category - The memory category
 * @param {object} metadata - Additional metadata
 * @returns {Promise<string>} The memory ID
 */
async function saveMemory(userId, content, category = 'general', metadata = {}) {
    try {
        const memoryId = uuidv4();
        const timestamp = new Date().toISOString();
        
        const memoryData = {
            id: memoryId,
            userId: userId,
            content: content,
            category: category,
            timestamp: timestamp,
            metadata: {
                ...metadata,
                source: 'conversation'
            }
        };

        // Store in local memory first (fast)
        if (!memoryStorage.has(userId)) {
            memoryStorage.set(userId, []);
        }
        
        const userMemories = memoryStorage.get(userId);
        
        // Enforce memory limit per user
        if (userMemories.length >= MEMORY_CONFIG.MAX_MEMORIES_PER_USER) {
            // Remove oldest memory
            userMemories.shift();
        }
        
        userMemories.push(memoryData);
        
        // Update memory index for fast category lookup
        if (!memoryIndex.has(userId)) {
            memoryIndex.set(userId, new Map());
        }
        const userIndex = memoryIndex.get(userId);
        if (!userIndex.has(category)) {
            userIndex.set(category, []);
        }
        userIndex.get(category).push(memoryId);

        // Generate and cache embedding asynchronously (non-blocking)
        generateEmbeddingAsync(content, memoryId);

        // Store in ChromaDB asynchronously (non-blocking backup)
        if (isChromaDBReady()) {
            storeInChromaDBAsync(memoryData, content);
        }

        console.log(`💾 Saved memory for user ${userId}: ${content.substring(0, 50)}...`);
        return memoryId;
    } catch (error) {
        console.error('❌ Error saving memory:', error);
        throw error;
    }
}

/**
 * Generate embedding asynchronously and cache it
 * @param {string} content - Content to embed
 * @param {string} memoryId - Memory ID for caching
 */
async function generateEmbeddingAsync(content, memoryId) {
    try {
        // Check cache first
        const contentHash = Buffer.from(content).toString('base64');
        if (embeddingCache.has(contentHash)) {
            updatePerformanceMetrics('cache_hit', 0);
            return embeddingCache.get(contentHash);
        }

        updatePerformanceMetrics('cache_miss', 0);
        const embeddingStart = Date.now();
        const embedding = await generateEmbedding(content);
        const embeddingDuration = Date.now() - embeddingStart;
        updatePerformanceMetrics('embedding_generation', embeddingDuration);
        
        // Cache the embedding
        embeddingCache.set(contentHash, embedding);
        
        // Cleanup cache if it gets too large
        if (embeddingCache.size > MEMORY_CONFIG.MAX_EMBEDDING_CACHE_SIZE) {
            const entries = Array.from(embeddingCache.entries());
            const toDelete = entries.slice(0, Math.floor(entries.length / 2));
            toDelete.forEach(([key]) => embeddingCache.delete(key));
        }
        
        return embedding;
    } catch (error) {
        console.warn('⚠️ Failed to generate embedding:', error.message);
    }
}

/**
 * Store memory in ChromaDB asynchronously (backup)
 * @param {object} memoryData - Memory data
 * @param {string} content - Memory content
 */
async function storeInChromaDBAsync(memoryData, content) {
    try {
        const embedding = await generateEmbeddingAsync(content, memoryData.id);
        if (embedding) {
            await memoriesCollection.add({
                ids: [memoryData.id],
                documents: [content],
                embeddings: [embedding],
                metadatas: [memoryData]
            });
        }
    } catch (error) {
        console.warn('⚠️ Failed to store in ChromaDB:', error.message);
    }
}

/**
 * Generate embedding using OpenAI API directly
 * @param {string} text - Text to embed
 * @returns {Promise<Array>} Embedding vector
 */
async function generateEmbedding(text) {
    if (!process.env.OPENAI_KEY) {
        throw new Error('OPENAI_KEY is required for embedding generation');
    }
    
    const openai = getOpenAIClient();
    const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text
    });
    
    return response.data[0].embedding;
}

/**
 * Batch process multiple embeddings for efficiency
 * @param {Array<string>} texts - Array of texts to embed
 * @returns {Promise<Array>} Array of embedding vectors
 */
async function generateBatchEmbeddings(texts) {
    if (!process.env.OPENAI_KEY) {
        throw new Error('OPENAI_KEY is required for embedding generation');
    }
    
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await generateEmbedding(texts[0])];
    
    const openai = getOpenAIClient();
    const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: texts
    });
    
    return response.data.map(item => item.embedding);
}

/**
 * Searches for relevant memories using optimized local search with ChromaDB fallback
 * @param {string} userId - The user ID
 * @param {string} query - The search query
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of relevant memories
 */
async function searchMemories(userId, query, limit = 5) {
    try {
        // First try local search for fast results
        const localResults = searchMemoriesLocally(userId, query, limit);
        if (localResults.length > 0) {
            console.log(`⚡ Local memory search found ${localResults.length} results`);
            return localResults;
        }

        // Fallback to ChromaDB for semantic search if local search is insufficient
        if (isChromaDBReady()) {
            console.log('🔍 Falling back to ChromaDB for semantic search');
            return await searchMemoriesChromaDB(userId, query, limit);
        }

        return [];
    } catch (error) {
        console.error('❌ Error searching memories:', error);
        // Return empty array instead of throwing to prevent blocking
        return [];
    }
}

/**
 * Fast local memory search using keyword matching and simple scoring
 * @param {string} userId - The user ID
 * @param {string} query - The search query
 * @param {number} limit - Maximum number of results
 * @returns {Array} Array of relevant memories
 */
function searchMemoriesLocally(userId, query, limit = 5) {
    const userMemories = memoryStorage.get(userId) || [];
    if (userMemories.length === 0) {
        return [];
    }

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);
    
    // Score memories based on keyword matches
    const scoredMemories = userMemories.map(memory => {
        const contentLower = memory.content.toLowerCase();
        let score = 0;
        
        // Exact phrase match (highest score)
        if (contentLower.includes(queryLower)) {
            score += 10;
        }
        
        // Individual word matches
        queryWords.forEach(word => {
            if (contentLower.includes(word)) {
                score += 1;
            }
        });
        
        // Category match bonus
        if (memory.category && queryLower.includes(memory.category.toLowerCase())) {
            score += 2;
        }
        
        // Recency bonus (newer memories get slight boost)
        const age = Date.now() - new Date(memory.timestamp).getTime();
        const daysOld = age / (1000 * 60 * 60 * 24);
        if (daysOld < 7) score += 0.5;
        else if (daysOld < 30) score += 0.2;
        
        return { ...memory, score };
    });
    
    // Sort by score and return top results
    return scoredMemories
        .filter(memory => memory.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ score, ...memory }) => memory); // Remove score from final result
}

/**
 * ChromaDB semantic search fallback
 * @param {string} userId - The user ID
 * @param {string} query - The search query
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of relevant memories
 */
async function searchMemoriesChromaDB(userId, query, limit = 5) {
    try {
        // Generate embedding for the query
        const queryEmbedding = await generateEmbedding(query);
        
        // Use queryEmbeddings for semantic search
        const results = await memoriesCollection.query({
            queryEmbeddings: [queryEmbedding],
            nResults: limit,
            where: { userId: userId }
        });

        return results.metadatas[0] || [];
    } catch (error) {
        console.warn('⚠️ ChromaDB search failed:', error.message);
        return [];
    }
}

/**
 * Gets all memories for a user
 * @param {string} userId - The user ID
 * @returns {Promise<Array>} Array of user's memories
 */
async function getUserMemories(userId) {
    if (!isChromaDBReady()) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }

    try {
        const results = await memoriesCollection.get({
            where: { userId: userId }
        });

        return results.metadatas || [];
    } catch (error) {
        console.error('❌ Error getting user memories:', error);
        throw error;
    }
}

/**
 * Deletes a memory by ID
 * @param {string} memoryId - The memory ID to delete
 * @returns {Promise<boolean>} Success status
 */
async function deleteMemory(memoryId) {
    if (!isChromaDBReady()) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }

    try {
        await memoriesCollection.delete({
            ids: [memoryId]
        });

        // Remove from memory cache
        for (const [userId, memories] of memoryStorage.entries()) {
            const index = memories.findIndex(m => m.id === memoryId);
            if (index !== -1) {
                memories.splice(index, 1);
                break;
            }
        }

        console.log(`🗑️ Deleted memory: ${memoryId}`);
        return true;
    } catch (error) {
        console.error('❌ Error deleting memory:', error);
        throw error;
    }
}

/**
 * Get all memories for a user with advanced filtering and pagination
 * @param {string} userId - The user ID
 * @param {Object} options - Filtering and pagination options
 * @returns {Promise<Object>} Paginated memories with metadata
 */
async function getAllMemories(userId, options = {}) {
    if (!isChromaDBReady()) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }
    
    const {
        limit = 50,
        offset = 0,
        category = null,
        startDate = null,
        endDate = null,
        searchQuery = null
    } = options;
    
    try {
        // Build where clause for filtering
        const whereClause = { userId: { "$eq": userId } };
        
        if (category) {
            whereClause.category = { "$eq": category };
        }
        
        if (startDate || endDate) {
            whereClause.timestamp = {};
            if (startDate) whereClause.timestamp["$gte"] = startDate;
            if (endDate) whereClause.timestamp["$lte"] = endDate;
        }
        
        // If search query provided, use semantic search
        if (searchQuery) {
            // Generate embedding for the search query
            const queryEmbedding = await generateEmbedding(searchQuery);
            
            const searchResults = await memoriesCollection.query({
                queryEmbeddings: [queryEmbedding],
                nResults: limit,
                where: whereClause
            });
            
            return {
                memories: searchResults.metadatas[0] || [],
                total: searchResults.metadatas[0]?.length || 0,
                hasMore: false
            };
        }
        
        // Otherwise, get all memories with filters
        const results = await memoriesCollection.get({
            where: whereClause,
            limit: limit,
            offset: offset
        });
        
        return {
            memories: results.metadatas || [],
            total: results.metadatas?.length || 0,
            hasMore: results.metadatas?.length === limit
        };
    } catch (error) {
        console.error('❌ Error getting memories:', error);
        throw error;
    }
}

/**
 * Get memory by ID with full details
 * @param {string} memoryId - The memory ID
 * @returns {Promise<Object|null>} Memory object or null if not found
 */
async function getMemoryById(memoryId) {
    if (!isChromaDBReady()) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }
    
    try {
        const results = await memoriesCollection.get({
            ids: [memoryId]
        });
        
        if (results.metadatas && results.metadatas.length > 0) {
            return {
                id: memoryId,
                content: results.documents[0],
                metadata: results.metadatas[0]
            };
        }
        
        return null;
    } catch (error) {
        console.error('❌ Error getting memory by ID:', error);
        throw error;
    }
}

/**
 * Get memory categories for a user
 * @param {string} userId - The user ID
 * @returns {Promise<Array>} Array of unique categories
 */
async function getMemoryCategories(userId) {
    if (!isChromaDBReady()) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }
    
    try {
        const results = await memoriesCollection.get({
            where: { userId: { "$eq": userId } }
        });
        
        const categories = new Set();
        results.metadatas?.forEach(metadata => {
            if (metadata.category) {
                categories.add(metadata.category);
            }
        });
        
        return Array.from(categories).sort();
    } catch (error) {
        console.error('❌ Error getting memory categories:', error);
        throw error;
    }
}

/**
 * Update memory content and metadata
 * @param {string} memoryId - The memory ID
 * @param {string} newContent - New content for the memory
 * @param {Object} newMetadata - New metadata to merge
 * @returns {Promise<boolean>} Success status
 */
async function updateMemory(memoryId, newContent, newMetadata = {}) {
    if (!isChromaDBReady()) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }
    
    try {
        // Get existing memory first
        const existing = await getMemoryById(memoryId);
        if (!existing) {
            throw new Error('Memory not found');
        }
        
        // Update with new content and merged metadata
        const updatedMetadata = {
            ...existing.metadata,
            ...newMetadata,
            updatedAt: new Date().toISOString()
        };
        
        await memoriesCollection.update({
            ids: [memoryId],
            documents: [newContent],
            metadatas: [updatedMetadata]
        });
        
        console.log(`📝 Updated memory: ${memoryId}`);
        return true;
    } catch (error) {
        console.error('❌ Error updating memory:', error);
        throw error;
    }
}

/**
 * Search memories with advanced options
 * @param {string} userId - The user ID
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Promise<Array>} Search results
 */
async function advancedMemorySearch(userId, query, options = {}) {
    if (!isChromaDBReady()) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }
    
    const {
        limit = 10,
        category = null,
        startDate = null,
        endDate = null,
        minSimilarity = 0.0
    } = options;
    
    try {
        // Build where clause for filtering
        const whereClause = { userId: { "$eq": userId } };
        
        if (category) {
            whereClause.category = { "$eq": category };
        }
        
        if (startDate || endDate) {
            whereClause.timestamp = {};
            if (startDate) whereClause.timestamp["$gte"] = startDate;
            if (endDate) whereClause.timestamp["$lte"] = endDate;
        }
        
        // Generate embedding for the query
        const queryEmbedding = await generateEmbedding(query);
        
        const results = await memoriesCollection.query({
            queryEmbeddings: [queryEmbedding],
            nResults: limit,
            where: whereClause
        });
        
        // Filter by similarity if specified
        const filteredResults = results.metadatas[0] || [];
        if (minSimilarity > 0 && results.distances && results.distances[0]) {
            return filteredResults.filter((_, index) => 
                results.distances[0][index] >= minSimilarity
            );
        }
        
        return filteredResults;
    } catch (error) {
        console.error('❌ Error in advanced memory search:', error);
        throw error;
    }
}

// Web search is now handled automatically by OpenAI's web_search_preview tool

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug endpoint for environment variables
app.get('/debug', (req, res) => {
  res.status(200).json({
    environment: {
      chroma_url: process.env.CHROMA_URL || 'NOT_SET',
      chroma_auth_token: process.env.CHROMA_AUTH_TOKEN ? 'SET' : 'NOT_SET',
      openai_key: process.env.OPENAI_KEY ? 'SET' : 'NOT_SET',
      omi_app_id: process.env.OMI_APP_ID ? 'SET' : 'NOT_SET',
      omi_app_secret: process.env.OMI_APP_SECRET ? 'SET' : 'NOT_SET'
    },
    memory_status: {
      chroma_client: chromaClient ? 'initialized' : 'not_initialized',
      memories_collection: memoriesCollection ? 'ready' : 'not_ready',
      memory_storage_size: memoryStorage.size
    },
    timestamp: new Date().toISOString()
  });
});

// Test ChromaDB connection endpoint
app.get('/test-chromadb', async (req, res) => {
  try {
    const chromaUrl = process.env.CHROMA_URL || 'https://chroma-yfcv-production.up.railway.app';
    const authToken = process.env.CHROMA_AUTH_TOKEN;
    
    console.log('🧪 Testing ChromaDB connection from /test-chromadb endpoint');
    console.log('URL:', chromaUrl);
    console.log('Auth Token:', authToken ? 'Present' : 'Missing');
    
    // Test heartbeat
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const headers = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const response = await fetch(`${chromaUrl}/api/v1/heartbeat`, {
      signal: controller.signal,
      headers: headers
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`ChromaDB heartbeat failed: ${response.status} ${response.statusText}`);
    }
    
    const responseText = await response.text();
    console.log('✅ Heartbeat successful:', responseText);
    
    // Test client creation
    const clientConfig = { path: chromaUrl };
    if (authToken) {
      clientConfig.auth = {
        provider: 'token',
        credentials: authToken
      };
    }
    
    const testClient = new ChromaClient(clientConfig);
    const testCollection = await testClient.getOrCreateCollection({
      name: "test_connection",
      metadata: { test: true }
    });
    
    console.log('✅ ChromaDB test successful');
    
    res.status(200).json({
      status: 'success',
      message: 'ChromaDB connection test passed',
      heartbeat_response: responseText,
      collection_name: testCollection.name,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ ChromaDB test failed:', error);
    
    res.status(500).json({
      status: 'error',
      message: 'ChromaDB connection test failed',
      error: error.message,
      error_type: error.constructor.name,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Omi AI Chat Plugin is running',
    trigger_phrases: [
      'Hey Omi.',
      'Hey, Omi', 
      'Hey omi,',
      'Hey, omi,',
      'Hey Omi.',
      'Hey, Omi.',
      'Hey omi.',
      'Hey, omi.'
    ],
    help_keywords: [
      'help', 'what can you do', 'how to use', 'instructions', 'guide',
      'what do you do', 'how does this work', 'what are the commands',
      'keywords', 'trigger words', 'how to talk to you'
    ],
    example_usage: 'Hey Omi, what is the weather like in Sydney, Australia?',
    rate_limiting: {
      max_notifications_per_hour: MAX_NOTIFICATIONS_PER_HOUR,
      active_users: notificationHistory.size,
      note: 'Check /rate-limit/:userId for specific user status'
    },
    api: {
      type: 'OpenAI Responses API',
      model: OPENAI_MODEL,
      web_search: 'web_search_preview tool enabled'
    },
    conversation_state: {
      active_sessions: sessionTranscripts.size,
      active_conversations: conversationHistory.size,
      context_management: 'enabled',
      token_limit_handling: 'automatic'
    },
    memory_system: {
      vector_store: isChromaDBReady() ? 'ChromaDB' : 'disabled',
      memory_features: [
        'save to memory',
        'save notes',
        'save as todos',
        'clear context'
      ],
      total_memories: memoryStorage.size,
      status: isChromaDBReady() ? 'active' : 'disabled',
      initialization_status: isChromaDBInitialized ? 'completed' : 'pending'
    }
  });
});

// ChromaDB status endpoint
app.get('/chromadb-status', (req, res) => {
  const status = {
    initialized: isChromaDBInitialized,
    ready: isChromaDBReady(),
    client_available: !!chromaClient,
    collection_available: !!memoriesCollection,
    url: process.env.CHROMA_URL || 'http://localhost:8000',
    auth_enabled: !!process.env.CHROMA_AUTH_TOKEN,
    timestamp: new Date().toISOString()
  };
  
  res.status(200).json(status);
});

// Performance metrics endpoint
app.get('/metrics', (req, res) => {
  res.status(200).json({
    performance: getPerformanceMetrics(),
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Help endpoint
app.get('/help', (req, res) => {
  res.status(200).json({
    title: 'Omi AI Chat Plugin - How to Use',
    description: 'Learn how to interact with the Omi AI assistant',
    trigger_phrases: {
      description: 'Start your message with one of these phrases to activate the AI:',
      phrases: [
        'Hey Omi',
        'Hey, Omi', 
        'Hey Omi,',
        'Hey, Omi,'
      ]
    },
    examples: [
      'Hey Omi, what is the weather like in Sydney, Australia?',
      'Hey, Omi, can you help me solve a math problem?',
      'Hey Omi, what are the latest news headlines?',
      'Hey, Omi, how do I make a chocolate cake?'
    ],
    help_keywords: {
      description: 'You can also ask for help using these words:',
      keywords: [
        'help', 'what can you do', 'how to use', 'instructions', 'guide',
        'what do you do', 'how does this work', 'what are the commands',
        'keywords', 'trigger words', 'how to talk to you'
      ]
    },
    note: 'The AI will only respond when you use the trigger phrases. Regular messages without these phrases will be ignored unless you\'re asking for help.',
    features: {
      web_search: 'Built-in web search for current information',
      natural_language: 'Understands natural conversation patterns',
      rate_limiting: 'Smart rate limiting to prevent API errors'
    }
  });
});

// Rate limit status endpoint
app.get('/rate-limit/:userId', (req, res) => {
  const { userId } = req.params;
  const status = getRateLimitStatus(userId);
  
  res.status(200).json({
    user_id: userId,
    rate_limit: status,
    message: status.isLimited ? 
      `Rate limited. Try again in ${status.timeUntilReset} minutes.` :
      `${status.remaining} notifications remaining this hour.`
  });
});

// Conversation history endpoint (for debugging)
app.get('/conversation/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const history = getConversationHistory(sessionId);
  
  res.status(200).json({
    session_id: sessionId,
    conversation_history: history,
    message_count: history.length,
    has_context: history.length > 0
  });
});

// Clear conversation history endpoint (for debugging)
app.delete('/conversation/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  clearConversationHistory(sessionId);
  
  res.status(200).json({
    session_id: sessionId,
    message: 'Conversation history cleared'
  });
});

// Memory management endpoints
app.get('/memories/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const memories = await getUserMemories(userId);
    
    res.status(200).json({
      user_id: userId,
      memories: memories,
      count: memories.length
    });
  } catch (error) {
    console.error('❌ Error getting user memories:', error);
    res.status(500).json({
      error: 'Failed to get memories',
      message: error.message
    });
  }
});

app.post('/memories/search', async (req, res) => {
  try {
    const { userId, query, limit = 5 } = req.body;
    
    if (!userId || !query) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'userId and query are required'
      });
    }
    
    const memories = await searchMemories(userId, query, limit);
    
    res.status(200).json({
      user_id: userId,
      query: query,
      memories: memories,
      count: memories.length
    });
  } catch (error) {
    console.error('❌ Error searching memories:', error);
    res.status(500).json({
      error: 'Failed to search memories',
      message: error.message
    });
  }
});

app.delete('/memories/:memoryId', async (req, res) => {
  try {
    const { memoryId } = req.params;
    const success = await deleteMemory(memoryId);
    
    if (success) {
      res.status(200).json({
        memory_id: memoryId,
        message: 'Memory deleted successfully'
      });
    } else {
      res.status(404).json({
        error: 'Memory not found',
        message: 'Memory with the specified ID was not found'
      });
    }
  } catch (error) {
    console.error('❌ Error deleting memory:', error);
    res.status(500).json({
      error: 'Failed to delete memory',
      message: error.message
    });
  }
});

// Advanced memory search and retrieval endpoints

// Get all memories with advanced filtering and pagination
app.get('/memories/:userId/all', async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      limit = 50,
      offset = 0,
      category = null,
      startDate = null,
      endDate = null,
      searchQuery = null
    } = req.query;
    
    const options = {
      limit: parseInt(limit),
      offset: parseInt(offset),
      category: category || null,
      startDate: startDate || null,
      endDate: endDate || null,
      searchQuery: searchQuery || null
    };
    
    const result = await getAllMemories(userId, options);
    
    res.status(200).json({
      user_id: userId,
      memories: result.memories,
      total: result.total,
      hasMore: result.hasMore,
      pagination: {
        limit: options.limit,
        offset: options.offset
      }
    });
  } catch (error) {
    console.error('❌ Error getting all memories:', error);
    res.status(500).json({
      error: 'Failed to get memories',
      message: error.message
    });
  }
});

// Get specific memory by ID
app.get('/memories/details/:memoryId', async (req, res) => {
  try {
    const { memoryId } = req.params;
    const memory = await getMemoryById(memoryId);
    
    if (memory) {
      res.status(200).json({
        memory: memory
      });
    } else {
      res.status(404).json({
        error: 'Memory not found',
        message: 'Memory with the specified ID was not found'
      });
    }
  } catch (error) {
    console.error('❌ Error getting memory by ID:', error);
    res.status(500).json({
      error: 'Failed to get memory',
      message: error.message
    });
  }
});

// Get memory categories for a user
app.get('/memories/:userId/categories', async (req, res) => {
  try {
    const { userId } = req.params;
    const categories = await getMemoryCategories(userId);
    
    res.status(200).json({
      user_id: userId,
      categories: categories,
      count: categories.length
    });
  } catch (error) {
    console.error('❌ Error getting memory categories:', error);
    res.status(500).json({
      error: 'Failed to get memory categories',
      message: error.message
    });
  }
});

// Advanced memory search with filters
app.post('/memories/search/advanced', async (req, res) => {
  try {
    const { 
      userId, 
      query, 
      limit = 10, 
      category = null, 
      startDate = null, 
      endDate = null, 
      minSimilarity = 0.0 
    } = req.body;
    
    if (!userId || !query) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'userId and query are required'
      });
    }
    
    const options = {
      limit: parseInt(limit),
      category: category || null,
      startDate: startDate || null,
      endDate: endDate || null,
      minSimilarity: parseFloat(minSimilarity)
    };
    
    const memories = await advancedMemorySearch(userId, query, options);
    
    res.status(200).json({
      user_id: userId,
      query: query,
      memories: memories,
      count: memories.length,
      filters: options
    });
  } catch (error) {
    console.error('❌ Error in advanced memory search:', error);
    res.status(500).json({
      error: 'Failed to search memories',
      message: error.message
    });
  }
});

// Update memory content and metadata
app.put('/memories/:memoryId', async (req, res) => {
  try {
    const { memoryId } = req.params;
    const { content, metadata = {} } = req.body;
    
    if (!content) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'content is required'
      });
    }
    
    const success = await updateMemory(memoryId, content, metadata);
    
    if (success) {
      res.status(200).json({
        memory_id: memoryId,
        message: 'Memory updated successfully'
      });
    } else {
      res.status(404).json({
        error: 'Memory not found',
        message: 'Memory with the specified ID was not found'
      });
    }
  } catch (error) {
    console.error('❌ Error updating memory:', error);
    res.status(500).json({
      error: 'Failed to update memory',
      message: error.message
    });
  }
});

// Export memories for a user (backup/analysis)
app.get('/memories/:userId/export', async (req, res) => {
  try {
    const { userId } = req.params;
    const { format = 'json' } = req.query;
    
    const result = await getAllMemories(userId, { limit: 1000 }); // Get up to 1000 memories
    
    if (format === 'csv') {
      // Convert to CSV format
      const csvHeader = 'ID,Content,Category,Timestamp,Type\n';
      const csvRows = result.memories.map(memory => 
        `"${memory.id}","${memory.content.replace(/"/g, '""')}","${memory.category || ''}","${memory.timestamp || ''}","${memory.type || ''}"`
      ).join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="memories_${userId}_${new Date().toISOString().split('T')[0]}.csv"`);
      res.status(200).send(csvHeader + csvRows);
    } else {
      // Default JSON format
      res.status(200).json({
        user_id: userId,
        export_date: new Date().toISOString(),
        total_memories: result.total,
        memories: result.memories
      });
    }
  } catch (error) {
    console.error('❌ Error exporting memories:', error);
    res.status(500).json({
      error: 'Failed to export memories',
      message: error.message
    });
  }
});

// Memory statistics for a user
app.get('/memories/:userId/stats', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await getAllMemories(userId, { limit: 1000 });
    
    // Calculate statistics
    const categories = {};
    const typeCounts = {};
    const monthlyCounts = {};
    
    result.memories.forEach(memory => {
      // Category stats
      const category = memory.category || 'uncategorized';
      categories[category] = (categories[category] || 0) + 1;
      
      // Type stats
      const type = memory.type || 'memory';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      
      // Monthly stats
      if (memory.timestamp) {
        const month = memory.timestamp.substring(0, 7); // YYYY-MM
        monthlyCounts[month] = (monthlyCounts[month] || 0) + 1;
      }
    });
    
    res.status(200).json({
      user_id: userId,
      total_memories: result.total,
      categories: categories,
      types: typeCounts,
      monthly_breakdown: monthlyCounts,
      most_common_category: Object.keys(categories).reduce((a, b) => categories[a] > categories[b] ? a : b, 'uncategorized'),
      most_common_type: Object.keys(typeCounts).reduce((a, b) => typeCounts[a] > typeCounts[b] ? a : b, 'memory')
    });
  } catch (error) {
    console.error('❌ Error getting memory statistics:', error);
    res.status(500).json({
      error: 'Failed to get memory statistics',
      message: error.message
    });
  }
});

// Main Omi webhook endpoint
app.post('/omi-webhook', async (req, res) => {
  const requestStartTime = Date.now();
  try {
    console.log('📥 Received webhook from Omi:', JSON.stringify(req.body, null, 2));
    
    const { session_id, segments } = req.body;
    
    // Validate required fields
    if (!session_id || !segments || !Array.isArray(segments)) {
      console.error('❌ Missing required fields:', { session_id, segments });
      return res.status(400).json({ 
        error: 'Missing required fields: session_id and segments array are required' 
      });
    }
    
    // Accumulate transcript segments for this session
    if (!sessionTranscripts.has(session_id)) {
      sessionTranscripts.set(session_id, []);
    }
    
    // Add new segments to the session
    const sessionSegments = sessionTranscripts.get(session_id);
    sessionSegments.push(...segments);
    
    // Extract all text from accumulated segments and join them
    const fullTranscript = sessionSegments
      .map(segment => segment.text)
      .join(' ')
      .trim();
    
    console.log('📝 Accumulated transcript for session:', fullTranscript);
    console.log('📊 Total segments in session:', sessionSegments.length);
    
        // Smart AI interaction detection
    const transcriptLower = fullTranscript.toLowerCase();
    
    // Primary trigger: "Hey Omi" variations
    const hasHeyOmi = transcriptLower.includes('hey omi') || 
                      transcriptLower.includes('hey, omi') ||
                      transcriptLower.includes('hey omi,') ||
                      transcriptLower.includes('hey, omi.');
    
    // Secondary triggers: Natural language patterns
    const isQuestion = /\b(who|what|where|when|why|how|can you|could you|would you|tell me|show me|find|search|look up)\b/i.test(fullTranscript);
    const isCommand = /\b(weather|news|temperature|time|date|current|today|now|latest|help me|i need|find out)\b/i.test(fullTranscript);
    const isConversational = fullTranscript.endsWith('?') || fullTranscript.includes('?');
    
    // Help keywords
    const helpKeywords = [
      'help', 'what can you do', 'how to use', 'instructions', 'guide',
      'what do you do', 'how does this work', 'what are the commands',
      'keywords', 'trigger words', 'how to talk to you'
    ];
    
    // Memory management keywords
    const memoryKeywords = [
      'save to memory', 'remember this', 'store information', 'save information',
      'save as memory', 'memorize this', 'keep this', 'save this'
    ];
    
    // Notes and summary keywords
    const notesKeywords = [
      'save notes', 'create summary', 'save this conversation', 'summarize',
      'save as notes', 'make notes', 'take notes', 'conversation summary'
    ];
    
    // Todo list keywords
    const todoKeywords = [
      'save as todos', 'create todo list', 'extract tasks', 'make todo list',
      'save as tasks', 'create tasks', 'todo list', 'task list', 'create a todo',
      'create todo', 'make a todo', 'extract todo', 'todo', 'todos'
    ];
    
    // Context management keywords
    const contextKeywords = [
      'clear context', 'start fresh', 'forget this conversation', 'reset',
      'clear memory', 'new conversation', 'forget everything'
    ];
    
    const isAskingForHelp = helpKeywords.some(keyword => 
      transcriptLower.includes(keyword)
    );
    
    const isMemoryCommand = memoryKeywords.some(keyword => 
      transcriptLower.includes(keyword)
    );
    
    const isNotesCommand = notesKeywords.some(keyword => 
      transcriptLower.includes(keyword)
    );
    
    const isTodoCommand = todoKeywords.some(keyword => 
      transcriptLower.includes(keyword)
    );
    
    const isContextCommand = contextKeywords.some(keyword => 
      transcriptLower.includes(keyword)
    );
    
    // Debug logging for command detection
    if (isTodoCommand || isMemoryCommand || isNotesCommand || isContextCommand) {
      console.log('🔍 Command detected:', {
        transcript: fullTranscript.substring(0, 100) + '...',
        isMemoryCommand,
        isNotesCommand,
        isTodoCommand,
        isContextCommand
      });
    }
    
    // Check for duplicate content to prevent processing the same transcript multiple times
    // But allow commands to be processed even if repeated
    const isAnyCommand = isMemoryCommand || isNotesCommand || isTodoCommand || isContextCommand || isAskingForHelp;
    
    if (!isAnyCommand) {
      const contentHash = Buffer.from(fullTranscript).toString('base64');
      if (processedContent.has(session_id) && processedContent.get(session_id).includes(contentHash)) {
        console.log('⏭️ Skipping duplicate transcript content:', fullTranscript);
        return res.status(200).json({ message: 'Content already processed' });
      }
      
      // Track this content as processed
      if (!processedContent.has(session_id)) {
        processedContent.set(session_id, []);
      }
      processedContent.get(session_id).push(contentHash);
    }
    
    // Determine if user wants AI interaction
    const wantsAIInteraction = hasHeyOmi || (isQuestion && isCommand) || (isConversational && isCommand);
    
    // Prioritize help requests over general AI interactions to prevent duplicates
    if (isAskingForHelp) {
      // User is asking for help, provide helpful response
      const helpMessage = `Hi! I'm Omi, your AI assistant. You can talk to me naturally! Try asking questions like "What's the weather like?" or "Can you search for current news?" I'll automatically detect when you need my help.

**New Memory Features:**
- "save to memory" - Store important information
- "save notes" - Create conversation summary
- "save as todos" - Extract actionable tasks
- "clear context" - Start fresh conversation

I can remember things for you and help organize your thoughts!`;
      
      console.log('💡 User asked for help, providing instructions');
      
      // Store help interaction in conversation history
      manageConversationHistory(session_id, fullTranscript, helpMessage);
      
      // Clear the session transcript after help response
      sessionTranscripts.delete(session_id);
      console.log('🧹 Cleared session transcript for help request:', session_id);
      return res.status(200).json({ 
        message: 'You can talk to me naturally! Try asking questions or giving commands.',
        help_response: helpMessage,
        instructions: 'Ask questions naturally or use "Hey Omi" to be explicit.',
        conversation_context: 'maintained'
      });
    }
    
    // Handle memory commands
    if (isMemoryCommand) {
      console.log('💾 User wants to save to memory');
      
      try {
        // Extract the content to save (everything before the memory command)
        const memoryContent = fullTranscript.replace(/\b(save to memory|remember this|store information|save information|save as memory|memorize this|keep this|save this)\b/gi, '').trim();
        
        if (!memoryContent) {
          return res.status(200).json({
            message: 'What would you like me to remember? Please provide the information you want to save.',
            error: 'No content provided for memory'
          });
        }
        
        // Use AI to categorize the memory
        const openaiClient = getOpenAIClient();
        const categoryResponse = await openaiClient.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'Categorize the following information into one of these categories: personal, work, learning, general, facts, preferences, or other. Respond with just the category name.' },
            { role: 'user', content: memoryContent }
          ],
          max_tokens: 20,
          temperature: 0.3
        });
        
        const category = categoryResponse.choices[0].message.content.trim().toLowerCase();
        
        // Save to memory
        let memoryId;
        try {
            memoryId = await saveMemory(session_id, memoryContent, category);
        } catch (memoryError) {
            console.warn('⚠️ Failed to save memory:', memoryError.message);
            return res.status(200).json({
                message: 'Sorry, I had trouble saving that to memory. Please try again.',
                error: memoryError.message
            });
        }
        
        // Store in conversation history
        manageConversationHistory(session_id, fullTranscript, `Saved to memory: "${memoryContent}"`);
        
        // Clear session transcript
        sessionTranscripts.delete(session_id);
        
        return res.status(200).json({
          message: `✅ Saved to memory: "${memoryContent}"`,
          memory_id: memoryId,
          category: category,
          action: 'memory_saved'
        });
        
      } catch (error) {
        console.error('❌ Error saving to memory:', error);
        return res.status(200).json({
          message: 'Sorry, I had trouble saving that to memory. Please try again.',
          error: error.message
        });
      }
    }
    
    // Handle context clearing commands
    if (isContextCommand) {
      console.log('🧹 User wants to clear context');
      
      // Clear conversation history
      clearConversationHistory(session_id);
      
      // Clear session transcript
      sessionTranscripts.delete(session_id);
      
      return res.status(200).json({
        message: '✅ Context cleared! Starting fresh conversation.',
        action: 'context_cleared'
      });
    }
    
    // Handle notes/summary commands
    if (isNotesCommand) {
      console.log('📝 User wants to save notes/summary');
      
      try {
        // Get conversation history for summary
        const history = getConversationHistory(session_id);
        
        if (history.length === 0) {
          return res.status(200).json({
            message: 'No conversation to summarize. Start a conversation first!',
            error: 'No conversation history'
          });
        }
        
        // Create conversation summary using AI
        const summaryPrompt = `Create a concise summary of this conversation. Focus on key points, decisions made, and important information discussed. Keep it under 200 words.

Conversation:
${history.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n')}`;

        const openaiClient = getOpenAIClient();
        const summaryResponse = await openaiClient.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a helpful assistant that creates clear, concise conversation summaries.' },
            { role: 'user', content: summaryPrompt }
          ],
          max_tokens: 300,
          temperature: 0.7
        });
        
        const summary = summaryResponse.choices[0].message.content;
        
        // Save summary to memory
        let memoryId;
        try {
            memoryId = await saveMemory(session_id, summary, 'notes', {
              type: 'conversation_summary',
              original_length: history.length
            });
        } catch (memoryError) {
            console.warn('⚠️ Failed to save notes to memory:', memoryError.message);
            return res.status(200).json({
                message: 'Sorry, I had trouble saving the notes. Please try again.',
                error: memoryError.message
            });
        }
        
        // Store in conversation history
        manageConversationHistory(session_id, fullTranscript, `Created notes: ${summary}`);
        
        // Clear session transcript
        sessionTranscripts.delete(session_id);
        
        return res.status(200).json({
          message: `✅ Notes created and saved!\n\n**Summary:**\n${summary}`,
          memory_id: memoryId,
          summary: summary,
          action: 'notes_created'
        });
        
      } catch (error) {
        console.error('❌ Error creating notes:', error);
        return res.status(200).json({
          message: 'Sorry, I had trouble creating notes. Please try again.',
          error: error.message
        });
      }
    }
    
    // Handle todo list commands
    if (isTodoCommand) {
      console.log('📋 User wants to create todo list');
      
      try {
        // Get conversation history for todo extraction
        const history = getConversationHistory(session_id);
        
        if (history.length === 0) {
          return res.status(200).json({
            message: 'No conversation to extract todos from. Start a conversation first!',
            error: 'No conversation history'
          });
        }
        
        // Extract todos using AI
        const todoPrompt = `Extract actionable tasks and todos from this conversation. Format as a numbered list. Only include specific, actionable items. If no clear tasks are mentioned, respond with "No specific tasks identified."

Conversation:
${history.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n')}`;

        const openaiClient = getOpenAIClient();
        const todoResponse = await openaiClient.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a helpful assistant that extracts actionable tasks from conversations. Format as a clear numbered list.' },
            { role: 'user', content: todoPrompt }
          ],
          max_tokens: 500,
          temperature: 0.5
        });
        
        const todoList = todoResponse.choices[0].message.content;
        
        if (todoList.toLowerCase().includes('no specific tasks')) {
          return res.status(200).json({
            message: 'No specific tasks were identified in this conversation. Try discussing specific actions or goals!',
            action: 'no_todos_found'
          });
        }
        
        // Save todo list to memory
        let memoryId;
        try {
            memoryId = await saveMemory(session_id, todoList, 'todos', {
              type: 'todo_list',
              original_length: history.length
            });
        } catch (memoryError) {
            console.warn('⚠️ Failed to save todos to memory:', memoryError.message);
            return res.status(200).json({
                message: 'Sorry, I had trouble saving the todo list. Please try again.',
                error: memoryError.message
            });
        }
        
        // Store in conversation history
        manageConversationHistory(session_id, fullTranscript, `Created todo list: ${todoList}`);
        
        // Clear session transcript
        sessionTranscripts.delete(session_id);
        
        return res.status(200).json({
          message: `✅ Todo list created and saved!\n\n**Tasks:**\n${todoList}`,
          memory_id: memoryId,
          todo_list: todoList,
          action: 'todos_created'
        });
        
      } catch (error) {
        console.error('❌ Error creating todo list:', error);
        return res.status(200).json({
          message: 'Sorry, I had trouble creating the todo list. Please try again.',
          error: error.message
        });
      }
    }
    
    if (!wantsAIInteraction) {
      // User didn't trigger AI interaction - silently ignore
      console.log('⏭️ Skipping transcript - no AI interaction detected:', fullTranscript);
      return res.status(200).json({}); // Return empty response - no message
    }
    
         // Extract the question from the accumulated transcript
     let question = '';
     
     if (hasHeyOmi) {
       // If "Hey Omi" was used, extract everything after it
       for (const segment of sessionSegments) {
         const segmentText = segment.text.toLowerCase();
         const heyOmiPatterns = ['hey, omi', 'hey omi,', 'hey, omi,', 'hey omi', 'Hey, Omi', 'Hey Omi.', 'Hey Omi,'];
         
         for (const pattern of heyOmiPatterns) {
           if (segmentText.includes(pattern)) {
             const patternIndex = segmentText.indexOf(pattern);
             question = segment.text.substring(patternIndex + pattern.length).trim();
             break;
           }
         }
         if (question) break;
       }
       
       // If no question found after "Hey Omi", use remaining segments
       if (!question) {
         const heyOmiIndex = sessionSegments.findIndex(segment => 
           heyOmiPatterns.some(pattern => segment.text.toLowerCase().includes(pattern))
         );
         if (heyOmiIndex !== -1) {
           const remainingSegments = sessionSegments.slice(heyOmiIndex + 1);
           question = remainingSegments.map(s => s.text).join(' ').trim();
         }
       }
     } else {
       // For natural language detection, use the full transcript
       question = fullTranscript;
     }
    
    if (!question) {
      console.log('⏭️ Skipping transcript - no question after "hey omi"');
      return res.status(200).json({ 
        message: 'Transcript ignored - no question provided' 
      });
    }
    
         console.log('🤖 Processing question:', question);
     
     // Use OpenAI Responses API with built-in web search
     console.log('🤖 Using OpenAI Responses API with web search for:', question);
     const startTime = Date.now();
     
     let aiResponse = '';
     let needsMemoryContext = false; // Declare at function scope for performance tracking
     
     try {
         // Get conversation history for this session
         const history = getConversationHistory(session_id);
         
         // Optimized memory search with smart context detection
         let relevantMemories = [];
         const questionLower = question.toLowerCase();
         const isSimpleQuestion = question.length < MEMORY_CONFIG.SIMPLE_QUESTION_THRESHOLD;
         const hasSubstantialHistory = history.length > MEMORY_CONFIG.MEMORY_SEARCH_THRESHOLD;
         
         // Smart context detection - only search when likely to be beneficial
         needsMemoryContext = !isSimpleQuestion && (
           questionLower.includes('remember') || 
           questionLower.includes('what did') ||
           questionLower.includes('tell me about') ||
           questionLower.includes('do you know') ||
           questionLower.includes('my') ||
           questionLower.includes('i') ||
           hasSubstantialHistory
         );
         
         if (needsMemoryContext) {
           try {
             const memorySearchStart = Date.now();
             relevantMemories = await searchMemories(session_id, question, 3);
             const memorySearchDuration = Date.now() - memorySearchStart;
             updatePerformanceMetrics('memory_search', memorySearchDuration);
             console.log('🧠 Memory search completed, found:', relevantMemories.length, 'memories');
           } catch (memoryError) {
             console.warn('⚠️ Memory search failed, continuing without memories:', memoryError.message);
           }
         } else {
           console.log('⚡ Skipping memory search for simple question or insufficient context');
         }
         
         // Create context-aware input for the Responses API
         let contextInput = question;
         let contextParts = [];
         
         if (history.length > 0) {
             // Build conversation context from history
             const contextMessages = history.map(msg => 
                 `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
             ).join('\n\n');
             
             contextParts.push(`Previous conversation:\n${contextMessages}`);
             console.log('📚 Including conversation history in context');
         }
         
         if (relevantMemories.length > 0) {
             // Add relevant memories to context
             const memoryContext = relevantMemories.map(memory => 
                 `- ${memory.content} (${memory.category})`
             ).join('\n');
             
             contextParts.push(`Relevant memories:\n${memoryContext}`);
             console.log('🧠 Including relevant memories in context');
         }
         
         if (contextParts.length > 0) {
             contextInput = `${contextParts.join('\n\n')}\n\nCurrent user message: ${question}`;
         }
         
         // Use the new Responses API with web search and conversation context
         const openaiClient = getOpenAIClient();
         const response = await openaiClient.responses.create({
             model: OPENAI_MODEL,
             tools: [WEB_SEARCH_TOOL],
             input: contextInput,
         });
         
         aiResponse = response.output_text;
         const responseTime = Date.now() - startTime;
         console.log(`✨ OpenAI Responses API response (${responseTime}ms):`, aiResponse);
         
         // Log additional response data for debugging
         if (response.tool_use && response.tool_use.length > 0) {
             console.log('🔍 Web search tool was used:', response.tool_use);
         }
         
     } catch (error) {
         console.error('❌ OpenAI Responses API error:', error);
         
         // Fallback to regular chat completion if Responses API fails
         try {
             console.log('🔄 Falling back to regular OpenAI chat completion');
             const fallbackStartTime = Date.now();
             
             // Get conversation history for fallback
             const history = getConversationHistory(session_id);
             
             // Search for relevant memories only if needed (same logic as main path)
             let relevantMemories = [];
             needsMemoryContext = question.toLowerCase().includes('remember') || 
                                       question.toLowerCase().includes('what did') ||
                                       question.toLowerCase().includes('tell me about') ||
                                       question.toLowerCase().includes('do you know') ||
                                       question.toLowerCase().includes('my') ||
                                       question.toLowerCase().includes('i') ||
                                       history.length > 3;
             
             if (needsMemoryContext) {
               try {
                 relevantMemories = await searchMemories(session_id, question, 3);
                 console.log('🧠 Fallback memory search completed, found:', relevantMemories.length, 'memories');
               } catch (memoryError) {
                 console.warn('⚠️ Memory search failed, continuing without memories:', memoryError.message);
               }
             }
             
             // Build messages array with conversation history
             const messages = [
                 { 
                     role: 'system', 
                     content: 'You are a helpful AI assistant. When users ask about current events, weather, news, or time-sensitive information, be honest about your knowledge cutoff and suggest they check reliable sources for the most up-to-date information. For general knowledge questions, provide helpful and accurate responses.' 
                 }
             ];
             
             // Add conversation history
             if (history.length > 0) {
                 messages.push(...history);
                 console.log('📚 Including conversation history in fallback');
             }
             
             // Add relevant memories as context
             if (relevantMemories.length > 0) {
                 const memoryContext = relevantMemories.map(memory => 
                     `- ${memory.content} (${memory.category})`
                 ).join('\n');
                 
                 messages.push({
                     role: 'system',
                     content: `Relevant memories from previous conversations:\n${memoryContext}`
                 });
                 console.log('🧠 Including relevant memories in fallback');
             }
             
             // Add current user message
             messages.push({ role: 'user', content: question });
             
             const openaiClient = getOpenAIClient();
             const openaiResponse = await openaiClient.chat.completions.create({
                 model: 'gpt-4o',
                 messages: messages,
                 max_tokens: 800,
                 temperature: 0.7,
             });
             aiResponse = openaiResponse.choices[0].message.content;
             const fallbackResponseTime = Date.now() - fallbackStartTime;
             console.log(`✨ Fallback OpenAI response (${fallbackResponseTime}ms):`, aiResponse);
         } catch (fallbackError) {
             console.error('❌ Fallback also failed:', fallbackError);
             aiResponse = "I'm sorry, I'm experiencing technical difficulties. Please try again later.";
         }
     }
    
         // Send response back to Omi using the new function
     let omiResponse = null;
     let rateLimitInfo = null;
     
     try {
       omiResponse = await sendOmiNotification(session_id, aiResponse);
       console.log('📤 Successfully sent response to Omi:', omiResponse);
     } catch (error) {
       if (error.message.includes('Rate limit exceeded')) {
         rateLimitInfo = getRateLimitStatus(session_id);
         console.log('⚠️ Rate limit exceeded for user:', session_id, rateLimitInfo);
         
         // Store conversation history even when rate limited
         manageConversationHistory(session_id, question, aiResponse);
         
         // Still return the AI response, but note the rate limit
         res.status(200).json({
           success: true,
           message: aiResponse,
           question: question,
           ai_response: aiResponse,
           omi_response: null,
           rate_limit_warning: {
             message: `AI response generated but notification not sent due to rate limit.`,
             rate_limit: rateLimitInfo,
             retry_after: `${rateLimitInfo.timeUntilReset} minutes`
           },
           session_id: session_id,
           conversation_context: 'maintained'
         });
         
         // Clear the session transcript after response
         sessionTranscripts.delete(session_id);
         console.log('🧹 Cleared session transcript for:', session_id);
         return;
       } else {
         // Re-throw other errors
         throw error;
       }
     }
     
     // Store conversation history for future context
     manageConversationHistory(session_id, question, aiResponse);
     
     // Clear the session transcript after successful processing
     sessionTranscripts.delete(session_id);
     console.log('🧹 Cleared session transcript for:', session_id);
     
     // Update performance metrics
     const requestDuration = Date.now() - requestStartTime;
     updatePerformanceMetrics('request', requestDuration);
     
     // Return success response
     res.status(200).json({
       success: true,
       message: aiResponse,
       question: question,
       ai_response: aiResponse,
       omi_response: omiResponse,
       session_id: session_id,
       conversation_context: 'maintained',
       performance: {
         response_time_ms: requestDuration,
         memory_search_performed: needsMemoryContext
       }
     });
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    
    // Handle specific error types
    if (error.message && error.message.includes('API Error')) {
      // Omi API error response
      console.error('Omi API Error:', error.message);
      res.status(500).json({
        error: 'Omi API Error',
        message: error.message
      });
    } else if (error.message && (error.message.includes('OMI_APP_ID not set') || error.message.includes('OMI_APP_SECRET not set'))) {
      // Configuration error
      console.error('Configuration Error:', error.message);
      res.status(500).json({
        error: 'Configuration Error',
        message: error.message
      });
    } else {
      // Other errors
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🚨 Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'Something went wrong on the server'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'Endpoint not found'
  });
});

// Start server
async function startServer() {
  // Initialize memory storage first
  try {
    await initializeMemoryStorage();
    console.log('✅ Memory storage initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize memory storage:', error.message);
    console.warn('⚠️ Server will continue without memory features');
  }
  
  // Start the server after initialization
  app.listen(PORT, () => {
    console.log('🚀 Omi AI Chat Plugin server started');
    console.log(`📍 Server running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📖 Help & instructions: http://localhost:${PORT}/help`);
    console.log(`📡 Webhook endpoint: http://localhost:${PORT}/omi-webhook`);
  });
}

// Check environment variables
if (!process.env.OPENAI_KEY) {
  console.warn('⚠️  OPENAI_KEY environment variable is not set');
}
if (!process.env.OMI_APP_ID) {
  console.warn('⚠️  OMI_APP_ID environment variable is not set');
}
if (!process.env.OMI_APP_SECRET) {
  console.warn('⚠️  OMI_APP_SECRET environment variable is not set');
}

// Start the server
startServer().catch(error => {
  console.error('❌ Failed to start server:', error.message);
  process.exit(1);
});