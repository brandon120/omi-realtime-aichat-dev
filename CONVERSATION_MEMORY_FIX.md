# Conversation Memory Fix Documentation

## Problem
The AI wasn't remembering previous context, questions, or information from the conversation, making it unable to function as an effective agent.

## Root Causes

1. **No Conversation History Loading**: The webhook wasn't loading previous messages from the database
2. **Session State Not Persisted**: The `lastResponseId` and conversation ID weren't being properly stored/retrieved
3. **Limited Context Window**: Token limits were too restrictive (300-500 tokens)
4. **Missing Message Storage**: Conversations weren't being consistently saved to the database

## Solutions Implemented

### 1. Conversation History Loading
Added functionality to load the last 10 messages from the database and include them in the AI's context:

```javascript
// Load recent conversation history
const recentConversation = await prisma.conversation.findFirst({
  where: { omiSessionId: sessionRowCache.id },
  include: {
    messages: {
      orderBy: { createdAt: 'desc' },
      take: 10
    }
  }
});
```

### 2. Enhanced Context Building
The system now combines multiple context sources:
- Recent conversation history (last 10 messages)
- User memories (if enabled)
- Session state information

### 3. Increased Token Limits
- Context tokens: 500 → 1000
- Response tokens: 300 → 500
- Allows for richer context and more detailed responses

### 4. Configuration Options
New environment variables for fine-tuning:

```bash
# Conversation Memory Settings
OPENAI_INCLUDE_HISTORY=true      # Include conversation history
OPENAI_HISTORY_MESSAGES=10       # Number of messages to include
OPENAI_MAX_CONTEXT_TOKENS=1000   # Max tokens for context
OPENAI_WEBHOOK_MAX_TOKENS=500    # Max tokens for response
```

## How It Works Now

### Request Flow with Memory

1. **Webhook Receives Message**
   ```
   User: "My name is John and I like coding"
   ```

2. **System Loads Context**
   - Retrieves session from database
   - Loads last 10 messages
   - Fetches user memories
   - Gets previous response ID

3. **Builds AI Context**
   ```
   System: You are Omi, a friendly assistant.
   Recent conversation:
   USER: My name is John and I like coding
   ASSISTANT: Nice to meet you, John! What languages do you code in?
   USER: Python and JavaScript
   ASSISTANT: Great choices! Both are versatile languages.
   
   Current question: What's my name again?
   ```

4. **AI Responds with Context**
   ```
   Assistant: Your name is John, and you mentioned you like coding in Python and JavaScript.
   ```

5. **Saves to Database**
   - Stores conversation ID
   - Saves user message
   - Saves AI response
   - Updates lastResponseId

## Testing Conversation Memory

### Test Script
```javascript
// Test 1: Introduce yourself
POST /omi-webhook
{
  "session_id": "test-123",
  "segments": [{
    "text": "Hey Omi, my name is Alice and I'm 25 years old",
    "is_user": true
  }]
}

// Test 2: Ask if it remembers (same session)
POST /omi-webhook
{
  "session_id": "test-123",
  "segments": [{
    "text": "Hey Omi, what's my name and age?",
    "is_user": true
  }]
}

// Expected: Should remember "Alice" and "25"
```

### Manual Testing
```bash
# Set your session
SESSION="memory-test-$(date +%s)"

# Message 1
curl -X POST http://localhost:3000/omi-webhook \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION\",
    \"segments\": [{
      \"text\": \"Hey Omi, remember that my favorite color is blue\",
      \"is_user\": true
    }]
  }"

# Message 2 (should remember)
curl -X POST http://localhost:3000/omi-webhook \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION\",
    \"segments\": [{
      \"text\": \"Hey Omi, what's my favorite color?\",
      \"is_user\": true
    }]
  }"
```

## Performance Considerations

### Trade-offs
- **Slightly Slower**: Loading history adds 50-200ms
- **More Tokens**: Uses more OpenAI tokens (higher cost)
- **Better UX**: Provides coherent, contextual conversations

### Optimization Options

1. **Reduce History Size**
   ```bash
   OPENAI_HISTORY_MESSAGES=5  # Only last 5 messages
   ```

2. **Disable for Speed**
   ```bash
   OPENAI_INCLUDE_HISTORY=false  # Disable history loading
   ```

3. **Limit Context Tokens**
   ```bash
   OPENAI_MAX_CONTEXT_TOKENS=500  # Smaller context window
   ```

## Database Requirements

For conversation memory to work:

1. **OmiSession Table**: Must have `lastResponseId` field
2. **Conversation Table**: Linked to sessions and users
3. **Message Table**: Stores all messages with roles

## Troubleshooting

### Memory Not Working?

1. **Check Database**
   ```sql
   -- Verify messages are being saved
   SELECT * FROM Message 
   WHERE conversationId IN (
     SELECT id FROM Conversation 
     WHERE omiSessionId IN (
       SELECT id FROM OmiSession 
       WHERE omiSessionId = 'your-session-id'
     )
   );
   ```

2. **Check Logs**
   Look for:
   - "Loaded X messages for context"
   - "Session state:" debug output
   - "Failed to load conversation history" errors

3. **Verify Configuration**
   ```bash
   # Check settings
   echo $OPENAI_INCLUDE_HISTORY
   echo $OPENAI_HISTORY_MESSAGES
   ```

### Too Slow?

1. Reduce history messages: `OPENAI_HISTORY_MESSAGES=3`
2. Reduce context tokens: `OPENAI_MAX_CONTEXT_TOKENS=500`
3. Use faster model: `OPENAI_MODEL=gpt-3.5-turbo`

### Not Enough Context?

1. Increase history: `OPENAI_HISTORY_MESSAGES=20`
2. Increase tokens: `OPENAI_MAX_CONTEXT_TOKENS=2000`
3. Enable memories: `pref.injectMemories=true`

## Summary

The conversation memory system now:
- ✅ Loads previous messages for context
- ✅ Maintains conversation continuity
- ✅ Remembers user information across messages
- ✅ Supports configurable history depth
- ✅ Works with both Responses and Chat Completions APIs
- ✅ Preserves fast response times (< 2 seconds typically)

This enables the AI to function as a proper conversational agent with memory!