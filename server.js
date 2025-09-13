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
 * - "Hey Jarvis" (Iron Man style)
 * - "Hey, Jarvis" (with comma)
 * - "Hey Jarvis," (with trailing comma)
 * - "Hey, Jarvis," (with both commas)
 * - "Hey Echo" (Amazon Alexa style)
 * - "Hey, Echo" (with comma)
 * - "Hey Echo," (with trailing comma)
 * - "Hey, Echo," (with both commas)
 * - "Hey Assistant" (Google Assistant style)
 * - "Hey, Assistant" (with comma)
 * - "Hey Assistant," (with trailing comma)
 * - "Hey, Assistant," (with both commas)
 * - "hey" (simple trigger)
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
// Conversation state per Omi session (OpenAI conversation id)
const sessionConversations = new Map();
// Last processed question per session to prevent duplicate triggers
const lastProcessedQuestion = new Map();

// Helpers for duplicate detection
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNearDuplicate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (longer.includes(shorter)) {
    return shorter.length / longer.length >= 0.9;
  }
  return false;
}

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
const OPENAI_MODEL = "gpt-4o-mini"; // Smaller/cheaper, supports conversation state
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
      'Hey Omi', 'Hey, Omi', 'Hey Omi,', 'Hey, Omi,',
      'Hey Jarvis', 'Hey, Jarvis', 'Hey Jarvis,', 'Hey, Jarvis,',
      'Hey Echo', 'Hey, Echo', 'Hey Echo,', 'Hey, Echo,',
      'Hey Assistant', 'Hey, Assistant', 'Hey Assistant,', 'Hey, Assistant,',
      'hey'
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
      web_search: 'web_search_preview tool enabled',
      conversation_state: 'enabled (server-managed conversation id per Omi session)'
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
        'Hey Omi', 'Hey, Omi', 'Hey Omi,', 'Hey, Omi,',
        'Hey Jarvis', 'Hey, Jarvis', 'Hey Jarvis,', 'Hey, Jarvis,',
        'Hey Echo', 'Hey, Echo', 'Hey Echo,', 'Hey, Echo,',
        'Hey Assistant', 'Hey, Assistant', 'Hey Assistant,', 'Hey, Assistant,',
        'hey'
      ]
    },
    examples: [
      'Hey Omi, what is the weather like in Sydney, Australia?',
      'Hey Jarvis, can you help me solve a math problem?',
      'Hey Echo, what are the latest news headlines?',
      'Hey Assistant, how do I make a chocolate cake?',
      'hey what time is it?'
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
    
    // Primary trigger: Multiple AI assistant variations
    const triggerPhrases = [
      // Omi variations
      'hey omi', 'hey, omi', 'hey omi,', 'hey, omi,',
      // Jarvis variations (Iron Man style)
      'hey jarvis', 'hey, jarvis', 'hey jarvis,', 'hey, jarvis,',
      // Echo variations (Amazon Alexa style)
      'hey echo', 'hey, echo', 'hey echo,', 'hey, echo,',
      // Assistant variations (Google Assistant style)
      'hey assistant', 'hey, assistant', 'hey assistant,', 'hey, assistant,',
      // Simple trigger
      'hey'
    ];
    
    const hasTriggerPhrase = triggerPhrases.some(phrase => 
      transcriptLower.includes(phrase)
    );
    
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
    
    // Determine if user wants AI interaction
    const wantsAIInteraction = hasTriggerPhrase || (isQuestion && isCommand) || (isConversational && isCommand);
    
    if (!wantsAIInteraction) {
      if (isAskingForHelp) {
        // User is asking for help, provide helpful response
        const helpMessage = `Hi! I'm Omi, your AI assistant. You can talk to me naturally! Try asking questions like "What's the weather like?" or "Can you search for current news?" I'll automatically detect when you need my help.`;
        
        console.log('💡 User asked for help, providing instructions');
        // Clear the session transcript after help response
        sessionTranscripts.delete(session_id);
        console.log('🧹 Cleared session transcript for help request:', session_id);
        return res.status(200).json({ 
          message: 'You can talk to me naturally! Try asking questions or giving commands.',
          help_response: helpMessage,
          instructions: 'Ask questions naturally or use trigger phrases like "Hey Omi", "Hey Jarvis", "Hey Echo", "Hey Assistant", or just "hey" to be explicit.'
        });
      } else {
        // User didn't trigger AI interaction - silently ignore
        console.log('⏭️ Skipping transcript - no AI interaction detected:', fullTranscript);
        return res.status(200).json({}); // Return empty response - no message
      }
    }
    
         // Extract the question from the accumulated transcript
     let question = '';
     
     if (hasTriggerPhrase) {
       // If any trigger phrase was used, extract everything after it
       for (const segment of sessionSegments) {
         const segmentText = segment.text.toLowerCase();
         
         // Find which trigger phrase was used
         const usedTrigger = triggerPhrases.find(phrase => 
           segmentText.includes(phrase)
         );
         
         if (usedTrigger) {
           const patternIndex = segmentText.indexOf(usedTrigger);
           question = segment.text.substring(patternIndex + usedTrigger.length).trim();
           break;
         }
       }
       
       // If no question found after trigger phrase, use remaining segments
       if (!question) {
         const triggerIndex = sessionSegments.findIndex(segment => 
           triggerPhrases.some(phrase => segment.text.toLowerCase().includes(phrase))
         );
         if (triggerIndex !== -1) {
           const remainingSegments = sessionSegments.slice(triggerIndex + 1);
           question = remainingSegments.map(s => s.text).join(' ').trim();
         }
       }
     } else {
       // For natural language detection, use the full transcript
       question = fullTranscript;
     }
    
    if (!question) {
      console.log('⏭️ Skipping transcript - no question after trigger phrase');
      return res.status(200).json({ 
        message: 'Transcript ignored - no question provided' 
      });
    }
    
    // Deduplicate to avoid triggering the AI again for the same content
    const normalizedQuestion = normalizeText(question);
    const last = lastProcessedQuestion.get(session_id);
    const COOLDOWN_MS = 10 * 1000; // 10 seconds
    if (last && (Date.now() - last.ts) < COOLDOWN_MS && isNearDuplicate(last.normalized, normalizedQuestion)) {
      console.log('⏭️ Suppressing near-duplicate within cooldown window:', question);
      return res.status(200).json({});
    }
    lastProcessedQuestion.set(session_id, { normalized: normalizedQuestion, ts: Date.now() });

        console.log('🤖 Processing question:', question);
    
    // Use OpenAI Responses API with built-in web search
    console.log('🤖 Using OpenAI Responses API with web search for:', question);
    
    let aiResponse = '';
    
    // Manage OpenAI conversation id for this Omi session
    let conversationId = sessionConversations.get(session_id);
    // If an old/invalid id is present (not starting with conv_), drop it
    if (conversationId && !/^conv_/.test(conversationId)) {
      sessionConversations.delete(session_id);
      conversationId = undefined;
    }
    
    try {
        // Use the new Responses API with web search
        const responsePayload = {
            model: OPENAI_MODEL,
            tools: [WEB_SEARCH_TOOL],
            input: question,
        };
        if (conversationId) {
            responsePayload.conversation = conversationId;
        }
        const response = await openai.responses.create(responsePayload);
        
        aiResponse = response.output_text;
        console.log('✨ OpenAI Responses API response:', aiResponse);
        
        // Persist the conversation id for follow-ups
        if (response && response.conversation) {
            const returnedConversationId = typeof response.conversation === 'string'
              ? response.conversation
              : response.conversation.id;
            if (returnedConversationId && /^conv_/.test(returnedConversationId)) {
              sessionConversations.set(session_id, returnedConversationId);
            }
        }
        
        // Log additional response data for debugging
        if (response.tool_use && response.tool_use.length > 0) {
            console.log('🔍 Web search tool was used:', response.tool_use);
        }
        
    } catch (error) {
         console.error('❌ OpenAI Responses API error:', error);
         
         // Fallback to regular chat completion if Responses API fails
         try {
             const openaiResponse = await openai.chat.completions.create({
                 model: 'gpt-4o',
                 messages: [
                     { 
                         role: 'system', 
                         content: 'You are a helpful AI assistant. When users ask about current events, weather, news, or time-sensitive information, be honest about your knowledge cutoff and suggest they check reliable sources for the most up-to-date information. For general knowledge questions, provide helpful and accurate responses.' 
                     },
                     { role: 'user', content: question }
                 ],
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
    
    // Return response so Omi shows content in chat and sends a single notification
    sessionTranscripts.delete(session_id);
    console.log('🧹 Cleared session transcript for:', session_id);
    return res.status(200).json({ message: aiResponse });
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    
    // Handle specific error types
    if (error.message && error.message.includes('API Error')) {
      // Omi API error response
      console.error('Omi API Error:', error.message);
      res.status(500).json({
        error: 'Omi API Error',
        message: 'Omi error message', //todo
        //message: error.message
      });
    } else if (error.message && (error.message.includes('OMI_APP_ID not set') || error.message.includes('OMI_APP_SECRET not set'))) {
      // Configuration error
      console.error('Configuration Error:', error.message);
      res.status(500).json({
        error: 'Configuration Error',
        message: 'Omi config error', //todo
       // message: error.message
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
         console.log('�� Cleaned up old session:', sessionId);
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