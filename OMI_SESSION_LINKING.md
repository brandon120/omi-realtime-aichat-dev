# OMI Session Linking for Live Chat

## Problem
The live chat feature in the Expo app isn't showing real-time updates because the OMI sessions aren't properly linked to the user accounts.

## How Session Linking Works

### 1. User Links OMI Device
When a user links their OMI device through the app:
```
POST /link/omi/start { "omi_user_id": "device-123" }
POST /link/omi/confirm { "omi_user_id": "device-123", "code": "123456" }
```
This creates an `OmiUserLink` record linking the device to the user.

### 2. OMI Sends Messages with UID
For the live chat to work, the OMI device must send the `uid` (omi_user_id) with each webhook call:

```json
POST /omi-webhook
{
  "session_id": "session-123",
  "uid": "device-123",  // <-- This links the session to the user
  "segments": [...]
}
```

Or as a query parameter:
```
POST /omi-webhook?uid=device-123
```

### 3. Session Gets Linked to User
When the webhook receives a request with a `uid`:
1. Looks up the `OmiUserLink` to find the user
2. Creates or updates the `OmiSession` with the userId
3. Links any conversations to that user

### 4. Live Chat Retrieves User's Conversations
The chat tab then finds conversations by:
1. Direct user conversations (`conversation.userId`)
2. OMI session conversations (`omiSession.userId`)
3. Linked device conversations

## Implementation Status

### ✅ Completed
1. **OMI Linking Endpoints** - `/link/omi/start` and `/link/omi/confirm`
2. **Session Upsert Logic** - Webhook now creates/updates sessions with userId
3. **Multiple Retrieval Methods** - Chat looks for conversations in multiple ways
4. **SSE Live Updates** - Real-time streaming of new messages

### ⚠️ Requirements
1. **Database Required** - Session linking needs database
2. **UID Must Be Sent** - OMI device must include `uid` parameter
3. **Device Must Be Linked** - User must complete device linking first

## Testing Guide

### Step 1: Link OMI Device
```javascript
// In Expo app or via API
const { dev_code } = await apiStartOmiLink("device-123");
await apiConfirmOmiLink("device-123", dev_code);
```

### Step 2: Send Messages with UID
```bash
curl -X POST http://localhost:3000/omi-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test-session-123",
    "uid": "device-123",
    "segments": [{
      "text": "Hey Omi, this is a test message",
      "is_user": true,
      "start": 0,
      "end": 3
    }]
  }'
```

### Step 3: Check Live Updates
```bash
# Get current conversation
curl http://localhost:3000/conversations/current \
  -H "Cookie: sid=USER_SESSION_TOKEN"

# Stream live updates
curl http://localhost:3000/conversations/current/stream?sid=USER_SESSION_TOKEN
```

## Troubleshooting

### No Live Updates Showing

1. **Check UID is being sent**:
   - Webhook must receive `uid` parameter
   - Check server logs for "Failed to upsert OMI session"

2. **Verify device is linked**:
   ```bash
   curl http://localhost:3000/me -H "Cookie: sid=SESSION"
   # Should show omi_links with your device
   ```

3. **Check session linkage**:
   - Database query: `SELECT * FROM OmiSession WHERE omiSessionId = 'your-session-id'`
   - Should have `userId` field populated

4. **Verify conversation linkage**:
   - Database query: `SELECT * FROM Conversation WHERE userId = 'your-user-id' OR omiSessionId IN (SELECT id FROM OmiSession WHERE userId = 'your-user-id')`

### Messages Not Appearing

1. **Check trigger phrase**: Default is "Hey Omi"
2. **Check quiet hours**: May be silenced during certain times
3. **Check listen mode**: Could be in TRIGGER, FOLLOWUP, or ALWAYS mode

## Code Flow

```
1. User links device → OmiUserLink created
2. OMI sends webhook with uid → Session linked to user
3. Conversation created → Linked to user or session
4. Messages saved → Associated with conversation
5. Live chat polls/streams → Finds user's conversations
6. Updates displayed → Real-time in chat tab
```

## API Reference

### Required Headers/Params for OMI Webhook
```
POST /omi-webhook
Query params or body:
- uid: "device-id" (links to user)
- session_id: "session-id" (required)
- segments: [...] (transcript data)
```

### Chat Retrieval Endpoints
```
GET /conversations/current - Get active conversation
GET /conversations/current/stream - SSE live updates
GET /conversations - List all conversations
GET /conversations/:id/messages - Get messages
```

## Database Relationships

```
User
  ↓ has many
OmiUserLink (via userId)
  - omiUserId (device identifier)
  
User
  ↓ has many
OmiSession (via userId)
  - omiSessionId (session identifier)
  ↓ has many
Conversation (via omiSessionId)
  ↓ has many
Message
```

## Summary

For live chat to work:
1. ✅ User must link their OMI device
2. ✅ OMI must send `uid` with webhooks
3. ✅ Database must be configured
4. ✅ User must be logged into Expo app

The system will then automatically:
- Link sessions to users
- Create conversations under the user
- Stream updates to the chat tab
- Show real-time message updates