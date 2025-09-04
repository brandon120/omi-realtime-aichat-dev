const express = require('express');
const https = require('https');
const OpenAI = require('openai');
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

// Rate limiting for Omi notifications (max 10 per hour)
const notificationQueue = [];
const notificationHistory = new Map(); // Track notifications per user
const MAX_NOTIFICATIONS_PER_HOUR = 10;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

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
    
    const isAskingForHelp = helpKeywords.some(keyword => 
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
      const helpMessage = `Hi! I'm Omi, your AI assistant. You can talk to me naturally! Try asking questions like "What's the weather like?" or "Can you search for current news?" I'll automatically detect when you need my help.`;
      
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
         
         // Create context-aware input for the Responses API
         let contextInput = question;
         if (history.length > 0) {
             // Build conversation context from history
             const contextMessages = history.map(msg => 
                 `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
             ).join('\n\n');
             
             contextInput = `Previous conversation:\n${contextMessages}\n\nCurrent user message: ${question}`;
             console.log('📚 Including conversation history in context');
         }
         
         // Use the new Responses API with web search and conversation context
         const response = await openai.responses.create({
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
             
             // Add current user message
             messages.push({ role: 'user', content: question });
             
             const openaiResponse = await openai.chat.completions.create({
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