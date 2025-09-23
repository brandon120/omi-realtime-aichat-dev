# Live Chat Feature Documentation

## Overview

The live chat feature enables real-time display of the current conversation linked to a user's OMI session in the Expo app's control/chat tab. When users log in, they immediately see their active conversation with live updates as new messages arrive.

## Backend Endpoints

### 1. Get Current Conversation
**Endpoint:** `GET /conversations/current`
**Authentication:** Required (cookie or header)

Returns the user's current active conversation based on their most recent OMI session.

**Response:**
```json
{
  "ok": true,
  "conversation": {
    "id": "uuid",
    "title": "Conversation Title",
    "summary": "Brief summary",
    "createdAt": "2025-09-23T10:00:00.000Z",
    "openaiConversationId": "openai-id",
    "omiSessionKey": "session-key"
  },
  "messages": [
    {
      "id": "msg-uuid",
      "role": "USER|ASSISTANT|SYSTEM|TOOL",
      "text": "Message content",
      "source": "OMI|APP|API",
      "createdAt": "2025-09-23T10:00:00.000Z"
    }
  ],
  "sessionId": "omi-session-id"
}
```

### 2. Live Updates Stream
**Endpoint:** `GET /conversations/current/stream`
**Authentication:** Required (query param `sid` for EventSource compatibility)

Server-Sent Events (SSE) endpoint for real-time updates.

**Event Types:**
- `connected` - Initial connection established
- `conversation_changed` - User's active conversation changed
- `new_messages` - New messages added to current conversation
- `update` - Full update (used by polling fallback)

**Example Events:**
```javascript
// Connected event
data: {"type":"connected"}

// Conversation changed
data: {"type":"conversation_changed","conversationId":"uuid"}

// New messages
data: {"type":"new_messages","messages":[{"id":"msg-id","role":"ASSISTANT","text":"Hello!","source":"OMI","createdAt":"2025-09-23T10:00:00.000Z"}]}
```

## Mobile App Integration

### API Functions

The following functions are available in `/mobile/lib/api.ts`:

```typescript
// Get current conversation with messages
apiGetCurrentConversation(): Promise<{
  conversation: ConversationItem | null;
  messages: MessageItem[];
  sessionId: string | null;
} | null>

// Stream live updates
apiStreamCurrentConversation(
  onMessage: (event: { type: string; [key: string]: any }) => void,
  onError?: (error: Error) => void
): () => void  // Returns cleanup function
```

### Usage in Control Tab

The control tab (`/mobile/app/(tabs)/control.tsx`) automatically:

1. **On Mount:**
   - Fetches the current conversation
   - Loads initial messages
   - Establishes SSE connection for live updates

2. **Live Updates:**
   - Automatically receives new messages as they arrive
   - Updates conversation when user switches sessions
   - Auto-scrolls to new messages if user is at bottom

3. **Fallback:**
   - If EventSource is not available (some React Native environments), falls back to polling every 3 seconds
   - Maintains backward compatibility with window-based approach

## How It Works

### Session Linking

1. When a user has an OMI device linked, their conversations are associated with an `OmiSession`
2. The backend tracks the most recent session with `lastSeenAt` timestamp
3. The current conversation is determined by finding the most recent session's latest conversation

### Real-time Updates

1. **SSE Connection:** Client establishes persistent connection to `/conversations/current/stream`
2. **Polling:** Backend checks for updates every 2 seconds
3. **Change Detection:** 
   - Tracks last message ID to detect new messages
   - Tracks conversation ID to detect session changes
4. **Event Emission:** Sends appropriate events when changes detected

### Authentication

- Standard endpoints use cookie-based auth (`sid` cookie)
- SSE endpoint accepts `sid` as query parameter for EventSource compatibility
- Session validation ensures only authenticated users can access their conversations

## Testing

Use the provided test script to verify functionality:

```bash
# Set your session token (get from browser cookies)
export SESSION_TOKEN="your-session-token-here"

# Run the test
node test-live-chat.js
```

The test script will:
1. Fetch the current conversation
2. Display messages
3. Listen for live updates for 30 seconds

## Performance Considerations

- **Update Frequency:** Checks every 2 seconds (configurable)
- **Message Limit:** Returns last 20 messages initially, new messages streamed as they arrive
- **Connection Management:** Automatic cleanup on disconnect
- **Fallback:** Polling mechanism for environments without SSE support

## Future Enhancements

1. **WebSocket Support:** Could replace SSE for bidirectional communication
2. **Typing Indicators:** Show when AI is processing/responding
3. **Read Receipts:** Track which messages user has seen
4. **Push Notifications:** Alert users to new messages when app is backgrounded
5. **Message Reactions:** Allow users to react to messages
6. **Conversation Switching:** UI to switch between multiple active sessions