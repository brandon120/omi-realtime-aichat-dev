# Expo App Error Fixes

## Issues Identified

1. **500 Error on `/conversations/current`** - Database query issues with null handling
2. **CORS Error on SSE Stream** - Missing CORS headers for EventSource
3. **400 Error on `/memories/import/omi`** - Incorrect error response format
4. **404 Error on `/agent-events`** - Missing endpoint
5. **Authentication Issues** - Session token validation problems

## Fixes Applied

### 1. Fixed `/conversations/current` Endpoint
- Added null safety for all database fields
- Fixed `recentSession` variable scoping issue
- Added proper error handling for missing data

```javascript
// Added null checks for all fields
title: currentConversation.title || null,
summary: currentConversation.summary || null,
createdAt: currentConversation.createdAt ? currentConversation.createdAt.toISOString() : null,
text: msg.text || '',
source: msg.source || 'UNKNOWN'
```

### 2. Fixed SSE CORS Headers
- Added proper CORS headers to SSE endpoint
- Added `Access-Control-Allow-Origin: *`
- Added `Access-Control-Allow-Credentials: true`
- Added `X-Accel-Buffering: no` for Nginx compatibility

```javascript
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'X-Accel-Buffering': 'no'
});
```

### 3. Fixed `/memories/import/omi` Response
- Changed 404 to 400 status for missing link
- Added `ok: false` to error response
- Improved error message format

```javascript
return res.status(400).json({ 
  ok: false,
  error: 'No verified OMI link found',
  message: 'Please link your OMI device first.' 
});
```

### 4. Added `/agent-events` Endpoint
- Created new endpoint for agent events
- Returns empty array for now (can be expanded later)
- Follows Expo app expected format

```javascript
app.get('/agent-events', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json({
    ok: true,
    events: [],
    cursor: null
  });
}));
```

## Authentication Flow

The Expo app uses cookie-based authentication:
1. User logs in via `/auth/login`
2. Receives `session_token` in response
3. Stores token and sends as `Cookie: sid=<token>`
4. Server validates token from `AuthSession` table

## Testing the Fixes

### Manual Testing with cURL

```bash
# 1. Login to get session token
TOKEN=$(curl -s -X POST https://your-api.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password"}' \
  | jq -r '.session_token')

# 2. Test conversations/current
curl -H "Cookie: sid=$TOKEN" https://your-api.com/conversations/current

# 3. Test SSE stream
curl -N -H "Accept: text/event-stream" \
  "https://your-api.com/conversations/current/stream?sid=$TOKEN"

# 4. Test agent events
curl -H "Cookie: sid=$TOKEN" https://your-api.com/agent-events?limit=50

# 5. Test memory import
curl -X POST -H "Cookie: sid=$TOKEN" \
  -H "Content-Type: application/json" \
  https://your-api.com/memories/import/omi
```

### Expected Responses

#### `/conversations/current` (200 OK)
```json
{
  "ok": true,
  "conversation": {
    "id": "uuid",
    "title": "Conversation Title",
    "summary": null,
    "createdAt": "2025-09-23T00:00:00.000Z",
    "openaiConversationId": "conv_123",
    "omiSessionKey": "session_456"
  },
  "messages": [
    {
      "id": "msg_uuid",
      "role": "USER",
      "text": "Hello",
      "source": "OMI_TRANSCRIPT",
      "createdAt": "2025-09-23T00:00:00.000Z"
    }
  ],
  "sessionId": "session_456"
}
```

#### `/conversations/current/stream` (200 OK - SSE)
```
data: {"type":"connected"}

data: {"type":"new_messages","messages":[...]}

data: {"type":"conversation_changed","conversationId":"..."}
```

#### `/agent-events` (200 OK)
```json
{
  "ok": true,
  "events": [],
  "cursor": null
}
```

#### `/memories/import/omi` (400 if no link, 200 if success)
```json
{
  "ok": false,
  "error": "No verified OMI link found",
  "message": "Please link your OMI device first."
}
```

## Deployment Notes

After deploying these fixes:

1. **Restart the server** to apply all changes
2. **Clear any caches** (CDN, browser, app)
3. **Monitor logs** for any remaining errors
4. **Test with real user sessions** from the Expo app

## Remaining Issues to Monitor

1. **Session Management**: Ensure sessions are being created correctly
2. **Database Performance**: Monitor query times for conversation fetching
3. **SSE Connection Stability**: Watch for disconnections/reconnections
4. **Memory Usage**: Track memory with SSE connections

## Next Steps

1. Implement actual agent events functionality
2. Add pagination to conversation messages
3. Optimize database queries with proper indexes
4. Add rate limiting to prevent abuse
5. Implement proper conversation state management