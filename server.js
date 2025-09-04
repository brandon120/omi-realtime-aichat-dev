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

// Memory storage for vector-based semantic search
const memoryStorage = new Map(); // In-memory cache for quick access
let chromaClient = null;
let memoriesCollection = null;

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
    
    // Create or get the memories collection
    memoriesCollection = await chromaClient.getOrCreateCollection({
      name: "omi_memories",
      metadata: { description: "Omi AI Chat Plugin Memory Storage" }
    });
    
    console.log('✅ Memory storage initialized with ChromaDB');
    console.log('📊 Collection name: omi_memories');
  } catch (error) {
    console.error('❌ Failed to initialize ChromaDB:', error.message);
    console.log('💡 To start ChromaDB server:');
    console.log('   docker run -p 8000:8000 chromadb/chroma:latest');
    console.log('   or set CHROMA_URL environment variable to your ChromaDB instance');
    throw error; // Fail startup if ChromaDB is not available
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
 * Manages conversation history for a session with token limit handling
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
        { role: 'user', content: userMessage },
        { role: 'assistant', content: aiResponse }
    );
    
    // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
    const estimatedTokens = history.reduce((total, msg) => total + Math.ceil(msg.content.length / 4), 0);
    
    // If we're approaching token limits, keep only recent messages
    // GPT-4o has ~128k context, but we'll be conservative and limit to ~50k tokens
    const MAX_TOKENS = 50000;
    if (estimatedTokens > MAX_TOKENS) {
        // Keep the system message and the most recent exchanges
        const systemMessage = history.find(msg => msg.role === 'system');
        const recentMessages = history.filter(msg => msg.role !== 'system').slice(-20); // Keep last 10 exchanges
        
        history = systemMessage ? [systemMessage, ...recentMessages] : recentMessages;
        console.log(`🧹 Trimmed conversation history for session ${sessionId} due to token limit`);
    }
    
    // Store updated history
    conversationHistory.set(sessionId, history);
    
    return history;
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
 * Generates embeddings for text using OpenAI
 * @param {string} text - The text to embed
 * @returns {Promise<number[]>} The embedding vector
 */
async function generateEmbedding(text) {
    try {
        const openaiClient = getOpenAIClient();
        const response = await openaiClient.embeddings.create({
            model: "text-embedding-3-small",
            input: text
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error('❌ Error generating embedding:', error);
        throw error;
    }
}

/**
 * Saves a memory to the vector store
 * @param {string} userId - The user ID
 * @param {string} content - The memory content
 * @param {string} category - The memory category
 * @param {object} metadata - Additional metadata
 * @returns {Promise<string>} The memory ID
 */
async function saveMemory(userId, content, category = 'general', metadata = {}) {
    if (!chromaClient || !memoriesCollection) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }

    try {
        const memoryId = uuidv4();
        const embedding = await generateEmbedding(content);
        
        const memoryData = {
            id: memoryId,
            userId: userId,
            content: content,
            category: category,
            timestamp: new Date().toISOString(),
            metadata: {
                ...metadata,
                source: 'conversation'
            }
        };

        // Store in ChromaDB
        await memoriesCollection.add({
            ids: [memoryId],
            embeddings: [embedding],
            documents: [content],
            metadatas: [memoryData]
        });

        // Cache in memory for quick access
        if (!memoryStorage.has(userId)) {
            memoryStorage.set(userId, []);
        }
        memoryStorage.get(userId).push(memoryData);

        console.log(`💾 Saved memory for user ${userId}: ${content.substring(0, 50)}...`);
        return memoryId;
    } catch (error) {
        console.error('❌ Error saving memory:', error);
        throw error;
    }
}

/**
 * Searches for relevant memories using semantic similarity
 * @param {string} userId - The user ID
 * @param {string} query - The search query
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of relevant memories
 */
async function searchMemories(userId, query, limit = 5) {
    if (!chromaClient || !memoriesCollection) {
        throw new Error('Memory storage not initialized. ChromaDB is required.');
    }

    try {
        const queryEmbedding = await generateEmbedding(query);
        
        const results = await memoriesCollection.query({
            queryEmbeddings: [queryEmbedding],
            nResults: limit,
            where: { userId: userId }
        });

        return results.metadatas[0] || [];
    } catch (error) {
        console.error('❌ Error searching memories:', error);
        throw error;
    }
}

/**
 * Gets all memories for a user
 * @param {string} userId - The user ID
 * @returns {Promise<Array>} Array of user's memories
 */
async function getUserMemories(userId) {
    if (!chromaClient || !memoriesCollection) {
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
    if (!chromaClient || !memoriesCollection) {
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

// Web search is now handled automatically by OpenAI's web_search_preview tool

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
      vector_store: chromaClient ? 'ChromaDB' : 'disabled',
      memory_features: [
        'save to memory',
        'save notes',
        'save as todos',
        'clear context'
      ],
      total_memories: memoryStorage.size,
      status: chromaClient ? 'active' : 'disabled'
    }
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

// Main Omi webhook endpoint
app.post('/omi-webhook', async (req, res) => {
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
      'save as tasks', 'create tasks', 'todo list', 'task list'
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
    
    // Check for duplicate content to prevent processing the same transcript multiple times
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
     
     let aiResponse = '';
     
     try {
         // Get conversation history for this session
         const history = getConversationHistory(session_id);
         
         // Search for relevant memories (with error handling)
         let relevantMemories = [];
         try {
             relevantMemories = await searchMemories(session_id, question, 3);
         } catch (memoryError) {
             console.warn('⚠️ Memory search failed, continuing without memories:', memoryError.message);
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
         console.log('✨ OpenAI Responses API response:', aiResponse);
         
         // Log additional response data for debugging
         if (response.tool_use && response.tool_use.length > 0) {
             console.log('🔍 Web search tool was used:', response.tool_use);
         }
         
     } catch (error) {
         console.error('❌ OpenAI Responses API error:', error);
         
         // Fallback to regular chat completion if Responses API fails
         try {
             // Get conversation history for fallback
             const history = getConversationHistory(session_id);
             
             // Search for relevant memories (with error handling)
             let relevantMemories = [];
             try {
                 relevantMemories = await searchMemories(session_id, question, 3);
             } catch (memoryError) {
                 console.warn('⚠️ Memory search failed, continuing without memories:', memoryError.message);
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
             console.log('✨ Fallback OpenAI response:', aiResponse);
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
     
     // Return success response
     res.status(200).json({
       success: true,
       message: aiResponse,
       question: question,
       ai_response: aiResponse,
       omi_response: omiResponse,
       session_id: session_id,
       conversation_context: 'maintained'
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
app.listen(PORT, async () => {
  console.log('🚀 Omi AI Chat Plugin server started');
  console.log(`📍 Server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`📖 Help & instructions: http://localhost:${PORT}/help`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/omi-webhook`);
  
  // Initialize memory storage
  try {
    await initializeMemoryStorage();
  } catch (error) {
    console.error('❌ Failed to initialize memory storage:', error.message);
    console.warn('⚠️ Server will continue without memory features');
  }
  
  // Check environment variables (Updated)
  if (!process.env.OPENAI_KEY) {
    console.warn('⚠️  OPENAI_KEY environment variable is not set');
  }
  if (!process.env.OMI_APP_ID) {
    console.warn('⚠️  OMI_APP_ID environment variable is not set');
  }
  if (!process.env.OMI_APP_SECRET) {
    console.warn('⚠️  OMI_APP_SECRET environment variable is not set');
  }
  
     // OpenAI Responses API is ready to use
   console.log('✅ OpenAI Responses API ready with web search capability');
  
     // Set up session cleanup every 5 minutes
   setInterval(() => {
     const now = Date.now();
     const fiveMinutesAgo = now - (5 * 60 * 1000);
     
     for (const [sessionId, segments] of sessionTranscripts.entries()) {
       // Check if any segment is older than 5 minutes
       const hasOldSegment = segments.some(segment => {
         // Use segment.end time if available, otherwise assume recent
         return segment.end && (segment.end * 1000) < fiveMinutesAgo;
       });
       
       if (hasOldSegment) {
         sessionTranscripts.delete(sessionId);
         processedContent.delete(sessionId); // Also clean up processed content tracking
         console.log('🧹 Cleaned up old session:', sessionId);
       }
     }
     
     // Clean up conversation history for sessions that haven't been active for 30 minutes
     const thirtyMinutesAgo = now - (30 * 60 * 1000);
     for (const [sessionId, history] of conversationHistory.entries()) {
       // If no recent activity, clean up conversation history
       // This is a simple cleanup - in production you might want more sophisticated tracking
       if (history.length > 0) {
         const lastMessage = history[history.length - 1];
         // Simple heuristic: if we have more than 50 messages, it's probably old
         if (history.length > 50) {
           clearConversationHistory(sessionId);
         }
       }
     }
   }, 5 * 60 * 1000); // 5 minutes
   
   // Set up rate limit cleanup every hour
   setInterval(() => {
     const now = Date.now();
     const oneHourAgo = now - RATE_LIMIT_WINDOW;
     
     for (const [userId, timestamps] of notificationHistory.entries()) {
       // Remove timestamps older than 1 hour
       const recentTimestamps = timestamps.filter(timestamp => timestamp > oneHourAgo);
       
       if (recentTimestamps.length === 0) {
         notificationHistory.delete(userId);
         console.log('🧹 Cleaned up old rate limit history for user:', userId);
       } else {
         notificationHistory.set(userId, recentTimestamps);
       }
     }
   }, RATE_LIMIT_WINDOW); // 1 hour
  
  console.log('✅ Server ready to receive Omi webhooks');
});