# Webhook Optimizations Implementation

This document describes the optimizations implemented for the OMI webhook system to improve performance and support combined payloads.

## Overview

The webhook system has been enhanced with the following optimizations:

1. **Combined Payload Support**: Accept transcript segments and memory data in a single request
2. **Background Job Queue**: Queue memory saves and other persistence operations
3. **Session Metadata Caching**: Cache session data to avoid repeated database calls
4. **Immediate Response**: Respond immediately while background jobs handle persistence
5. **Batch Operations**: Batch transcript upserts and context-window updates

## Implementation Details

### 1. Background Queue System (`services/backgroundQueue.js`)

A new background queue system has been implemented to handle persistence operations asynchronously:

```javascript
class BackgroundQueue {
  // Job types supported:
  // - MEMORY_SAVE: Save memory with deduplication
  // - SESSION_UPDATE: Update session metadata
  // - TRANSCRIPT_BATCH: Batch upsert transcript segments
  // - CONVERSATION_SAVE: Save conversation and messages
  // - CONTEXT_WINDOW_UPDATE: Update user context windows
}
```

**Key Features:**
- Batched processing (10 jobs per batch)
- Automatic deduplication for memories
- Error handling and logging
- Queue status monitoring

### 2. Combined Payload Support

The webhook now supports combined payloads containing both transcript segments and memory data:

```javascript
// Combined payload structure
{
  session_id: "session-123",
  uid: "user-456",
  segments: [
    { id: "seg1", text: "Hey Omi, remember this", speaker: "user" }
  ],
  structured: {
    title: "Important Meeting",
    overview: "Discussed project timeline",
    action_items: [{ description: "Follow up with client" }]
  }
}
```

**Processing Flow:**
1. Detect combined payload (has both segments and memory data)
2. Queue memory save for background processing
3. Continue with transcript processing
4. Respond immediately with AI response
5. Background jobs handle all persistence

### 3. Session Metadata Caching

Session metadata is now cached to avoid repeated database calls:

```javascript
// Cache structure
const sessionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache key: "sessionId-linkedUserId"
// Cache value: { data: { sessionRow, linkedUserId }, timestamp }
```

**Benefits:**
- Faster response times
- Reduced database load
- Automatic cache cleanup
- Configurable TTL

### 4. Background Job Processing

All persistence operations are now queued as background jobs:

```javascript
// Queue session update
backgroundQueue.enqueue({
  type: 'SESSION_UPDATE',
  data: { sessionId, userId, conversationId, lastSeenAt }
});

// Queue transcript batch
backgroundQueue.enqueue({
  type: 'TRANSCRIPT_BATCH',
  data: { sessionId, segments }
});

// Queue conversation save
backgroundQueue.enqueue({
  type: 'CONVERSATION_SAVE',
  data: { sessionId, conversationId, question, aiResponse }
});
```

### 5. Batch Operations

Transcript segments and context-window updates are processed in batches:

- **Transcript Upserts**: All segments for a session are processed together
- **Context Window Updates**: Batched with conversation saves
- **Memory Deduplication**: Automatic deduplication within 12-hour window

## Performance Improvements

### Before Optimization
- Sequential database operations blocking response
- Repeated session metadata queries
- No support for combined payloads
- Memory saves blocking transcript processing

### After Optimization
- Immediate response with background persistence
- Cached session metadata (5-minute TTL)
- Combined payload support
- Batched database operations
- Non-blocking memory saves

## API Changes

### New Endpoints

#### GET `/omi-webhook/queue-status`
Returns the current status of the background queue:

```json
{
  "ok": true,
  "queue": {
    "queueLength": 5,
    "processing": false,
    "batchSize": 10
  }
}
```

### Enhanced Webhook Behavior

The `/omi-webhook` endpoint now:

1. **Accepts Combined Payloads**: Can process transcript segments and memory data together
2. **Uses Cached Metadata**: Leverages session cache for faster processing
3. **Queues Background Jobs**: All persistence operations are queued
4. **Responds Immediately**: Returns AI response without waiting for persistence

## Configuration

### Environment Variables
- `ENABLE_USER_SYSTEM`: Enables user system features
- `ENABLE_PROMPT_WORKERS`: Enables background workers

### Queue Configuration
- **Batch Size**: 10 jobs per batch
- **Processing Interval**: 100ms
- **Cache TTL**: 5 minutes
- **Memory Deduplication**: 12 hours

## Monitoring

### Queue Status
Monitor the background queue using the `/omi-webhook/queue-status` endpoint to track:
- Queue length
- Processing status
- Batch size

### Logging
All background operations are logged with appropriate levels:
- Info: Successful operations
- Warn: Non-critical errors
- Error: Critical failures

## Testing

A test script is provided (`test-webhook-optimizations.js`) that validates:
- Background queue functionality
- Combined payload processing
- Session caching behavior
- Job execution

Run tests with:
```bash
node test-webhook-optimizations.js
```

## Migration Notes

### Backward Compatibility
- Existing webhook behavior is preserved
- Memory-only payloads work as before
- Transcript-only payloads work as before
- New combined payloads are supported

### Database Impact
- No schema changes required
- Existing data remains unchanged
- Background operations use existing tables

## Future Enhancements

Potential future improvements:
1. **Persistent Queue**: Store jobs in database for reliability
2. **Priority Queues**: Different priorities for different job types
3. **Retry Logic**: Automatic retry for failed jobs
4. **Metrics**: Detailed performance metrics
5. **Scaling**: Multiple worker processes

## Troubleshooting

### Common Issues

1. **Queue Not Processing**
   - Check `ENABLE_PROMPT_WORKERS` flag
   - Verify background workers are started
   - Monitor queue status endpoint

2. **Cache Misses**
   - Check cache TTL configuration
   - Verify session ID consistency
   - Monitor cache size

3. **Memory Deduplication**
   - Check deduplication window (12 hours)
   - Verify memory text normalization
   - Monitor duplicate detection logs

### Debug Mode
Enable detailed logging by setting log level to debug in the background queue configuration.