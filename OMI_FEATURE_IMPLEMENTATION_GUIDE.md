# OMI Feature Implementation Guide

---

## 1. Terminology and Assumptions

- **OMI**: The open voice-first platform, providing APIs for memory, conversation, transcript, and integration management.
- **uid**: OMI user ID (string, globally unique, required for most OMI API calls).
- **session_id**: OMI session identifier (for real-time transcript and streaming).
- **Memory**: A user-authored or system-captured fact, note, or snippet.
- **Conversation**: A thread of messages, can be imported/exported.
- **Prompt-based app**: An OMI app that runs logic based on prompt templates and triggers.
- **Integration app**: An app that connects OMI to external systems, often via webhooks or REST.
- **Prisma**: Your ORM for PostgreSQL.
- **Express**: Your Node.js backend framework.
- **Expo**: Your React Native mobile app framework.

---

## 2. OMI Capabilities Deep-Dive

### 2.1 Prompt-Based Apps

**What it is:**  
Prompt-based apps in OMI allow you to define templates and rules that trigger AI or workflow actions based on user input, memory, or transcript content.

**Endpoints & Schemas:**  
- No single REST endpoint; prompt definitions are typically stored as config (JSON/YAML) and invoked by server logic.
- Example config:
  ```json
  {
    "id": "meeting-summary",
    "trigger": "transcript_end",
    "prompt": "Summarize this meeting: {transcript}",
    "output_type": "memory"
  }
  ```

**Auth/Scopes:**  
- Only server-side, not user-exposed.
- Secure prompt configs in code or DB.

**Workflows:**  
- On transcript end, server matches triggers and runs prompt logic.
- Output is stored as memory or sent as notification.

**Errors/Retry:**  
- If OpenAI fails, retry with fallback prompt or log error.
- Idempotency: Use session_id + trigger type as key.

**Example:**  
- On meeting end, auto-create a summary memory.

---

### 2.2 Memory Import & Creation Triggers

**What it is:**  
Import memories to OMI, and trigger memory creation from transcripts or typed input.

**Endpoints:**  
- `POST /omi/import/memories`
  - Body: `{ uid, text?, text_source?, text_source_spec?, memories? }`
- `GET /omi/import/memories`
  - Query: `{ uid, limit?, offset? }`

**Required Params:**  
- `uid` (required)
- `text` or `memories` (at least one required)

**Auth:**  
- Bearer token (OMI app secret) or user session.

**Rate Limits:**  
- Typically 10-60/minute per user.

**Errors:**  
- 400: missing uid/text
- 401: auth
- 429: rate limit

**Example Request:**
```bash
curl -X POST https://api.omi.me/v2/user/memories?uid=abc123 \
  -H "Authorization: Bearer {OMI_APP_SECRET}" \
  -d '{"text":"My passport is in the top drawer"}'
```

---

### 2.3 Integration Apps & Import

**What it is:**  
Connect OMI to external systems for data sync (import/export).

**Endpoints:**  
- `POST /omi/import/conversation`
- `GET /omi/import/conversations`
- `POST /omi/import/memories`
- `GET /omi/import/memories`

**Required Params:**  
- `uid` (required)
- For import: `text`, `memories`, etc.

**Auth:**  
- Bearer token (OMI app secret)

**Rate Limits:**  
- 10-60/minute per user

**Errors:**  
- 400: missing params
- 401: auth
- 429: rate limit

**Implementation Notes:**  
- Use idempotency keys (e.g., memory_id, conversation_id) to dedupe.
- Retry on 5xx, backoff on 429.

---

### 2.4 Real-Time Transcript Processing

**What it is:**  
Process streaming transcript segments in real time, triggering memory or prompt logic.

**Endpoint:**  
- `POST /realtime/transcripts?session_id={sid}&uid={omi_uid}`
  - Body: `[{ "text": "...", "speaker": "...", ... }, ...]`

**Behavior:**  
- Segments arrive in multiple calls.
- Use session_id to maintain context.
- Suppress near-duplicates, apply cooldowns.
- Persist segments idempotently (segment id/hash).
- Trigger memory/prompt logic as needed.

**Errors:**  
- 400: missing session_id/uid
- 429: rate limit

**Example Request:**
```bash
curl -X POST https://api.omi.me/v2/realtime/transcripts?session_id=abc&uid=xyz \
  -d '[{"text":"Hello world","speaker":"SPEAKER_00","start":0,"end":2}]'
```

---

### 2.5 Real-Time Audio Streaming

**What it is:**  
Stream audio to OMI for live transcription and processing.

**Protocols:**  
- WebSocket: `wss://api.omi.me/v2/audio/stream?session_id=...&uid=...`
- HTTP chunked POST (rare)

**Server Expectations:**  
- Buffer audio, handle backpressure.
- Forward to STT engine.
- Return transcript segments in real time.

**Express Design:**  
- Use a sidecar (Node or Python) for WebSocket/audio handling.
- Express receives transcript events via webhook.

---

### 2.6 Read All Conversations

**What it is:**  
Fetch all conversations for a user, with pagination and status filtering.

**Endpoint:**  
- `GET /omi/import/conversations?uid=...&limit=...&offset=...&statuses=...`

**Params:**  
- `uid` (required)
- `limit` (default 100, max 500)
- `offset` (for pagination)
- `statuses` (optional: active, archived, etc.)

**Response:**  
- `{ conversations: [ ... ], nextCursor: ... }`

---

### 2.7 Read All Memories

**What it is:**  
Fetch all memories for a user, with pagination.

**Endpoint:**  
- `GET /omi/import/memories?uid=...&limit=...&offset=...`

**Params:**  
- `uid` (required)
- `limit` (default 100, max 500)
- `offset` (for pagination)

**Response:**  
- `{ memories: [ ... ], nextCursor: ... }`

---

## 3. Backend Design (Express + Prisma)

### 3.1 Proposed Routes

| Feature                | Route                                 | Method | Handler Module      |
|------------------------|---------------------------------------|--------|--------------------|
| Real-time transcript   | /realtime/transcripts                 | POST   | transcriptHandler  |
| Memory import          | /omi/import/memories                  | POST   | memoryImport       |
| Memory list            | /omi/import/memories                  | GET    | memoryList         |
| Conversation import    | /omi/import/conversation              | POST   | conversationImport |
| Conversation list      | /omi/import/conversations             | GET    | conversationList   |
| Prompt runner          | /prompts/run                          | POST   | promptRunner       |

**DTOs:**  
- Use TypeScript types for request/response (see section 5).

### 3.2 State & Persistence

- **Transcript segments**: Table with (session_id, segment_id/hash, text, speaker, start, end, created_at)
- **Memories**: Table with (id, user_id, text, source, created_at)
- **Conversations**: Table with (id, user_id, title, status, created_at)
- **Prompt configs**: Table or config file (id, trigger, prompt, output_type)
- **Preferences**: Per-user and per-session preferences including activationRegex, activationSensitivity, mute, dndQuietHoursStart/End

**Indices:**  
- Unique (session_id, segment_id) for transcript segments
- Index on (user_id, created_at) for memories/conversations

### 3.3 Background Jobs

- Use background workers for:
  - Prompt-based memory creation (on transcript end)
  - Retry failed imports (with exponential backoff)

### 3.4 Idempotency & Dedup

- Use segment_id or hash for transcript deduplication.
- Use memory_id/conversation_id for import deduplication.

### 3.5 Security & Privacy

- All endpoints require auth (Bearer or session).
- Only allow access to own data (user_id scoping).
- PII: redact or encrypt sensitive fields as needed.

### 3.6 Telemetry

- Log all API calls, errors, and retries.
- Metrics: request counts, error rates, latency.
- Alerts: on 5xx spikes, rate limit triggers.

### 3.7 Rollout Plan

- Feature flags for new endpoints.
- Gradual migration: dual-write to new tables, then cut over.
- Validation: compare old/new data for consistency.
- Quiet hours and mute: gate activation and notifications via preferences.

---

## 3A. Voice Activation, Context, and AI Triggering

### 1. Keep `/omi-webhook` as the Main Endpoint
- The main webhook for OMI voice transcript delivery will remain `/omi-webhook` for compatibility with OMI AI devices and cloud.

### 2. Current Keyword/Trigger Phrase Logic
- The current system uses a set of hardcoded trigger phrases (e.g., “Hey Omi”, “Hey Assistant”, etc.) and a regex to detect them in transcript segments.
- The `listenMode` user preference controls activation:
  - `TRIGGER`: Only respond if a trigger phrase is detected.
  - `FOLLOWUP`: Allow follow-up questions for a short window after a response.
  - `ALWAYS`: Respond to all input (no trigger required).
- There is a cooldown and deduplication system to avoid repeated triggers in noisy environments.

### 3. Problems with Keyword-Only Activation
- In loud environments, false positives are common.
- Users may be frustrated by missed or accidental activations.
- Context (recent activity, conversation state, etc.) is not leveraged.

### 4. Improved Contextual Activation (Proposed)
- **Hybrid approach:** Use both trigger phrases and context to decide when to activate the AI.
- **Contextual cues:** 
  - If the user is in an active conversation or has recently interacted, allow more flexible activation (e.g., follow-up without trigger).
  - Use the `listenMode` and recent activity to adjust sensitivity.
  - Optionally, allow users to set stricter or looser activation in preferences.
- **Noise handling:** 
  - Use a confidence score or additional heuristics (e.g., segment speaker, background noise detection) to suppress accidental triggers.
  - Optionally, allow users to temporarily “mute” activation in the app.

### 5. Memory and Conversation Integration
- When a transcript is processed:
  - **Memories:** If the user has opted in, inject recent memories as context for the AI (already partially implemented).
  - **Conversations:** Maintain conversation state per session/user, so follow-ups are more coherent.
  - **Notifications:** Use the improved context to decide when to send notifications (e.g., only for “real” AI responses, not accidental triggers).

### 6. Implementation Steps
- **a. Refactor `/omi-webhook` logic:**
  - Modularize activation logic: separate trigger phrase detection, context evaluation, and deduplication.
  - Add a context evaluation step: check recent activity, conversation state, and user preferences before activating the AI.
  - Make the activation regex and logic configurable per user/session.
  - Implement quiet hours and mute: suppress activation/notifications during configured windows.
- **b. Enhance memory/conversation context:**
  - Always fetch and inject recent memories and conversation history when calling OpenAI.
  - Use the conversation slot/window system to keep context organized.
- **c. Improve notification logic:**
  - Only send notifications for valid, contextually-activated AI responses.
  - Add a “rate limit” or “quiet hours” feature if needed.
- **d. Update user preferences:**
  - Allow users to adjust activation sensitivity and listen mode in the app.
  - Optionally, expose a “mute” or “do not disturb” toggle.

### 7. Data Contracts and API
- No change to the `/omi-webhook` contract, but document the new context/activation logic in the implementation guide.
- Add/extend user preference endpoints for new settings.

### 8. Migration/Refactor Plan
- Move all activation/trigger logic into a dedicated module/service.
- Gradually roll out context-based activation behind a feature flag.
- Monitor false positive/negative rates and adjust heuristics as needed.

### 9. Example Flows
- **User says “Hey Omi, what’s the weather?”**  
  → Detected by trigger phrase, AI responds, memories and conversation context injected.
- **User follows up with “And tomorrow?” within 10 seconds**  
  → Contextual activation (no trigger phrase needed), AI responds in context.
- **User in a noisy environment, random speech detected**  
  → Context and deduplication logic suppresses accidental activation.

---

## 4. Mobile Integration Plan

### 4.1 API Client Changes (`mobile/lib/api.ts`)

- Add:
  - `apiRealtimeTranscript(session_id: string, uid: string, segments: TranscriptSegment[]): Promise<boolean>`
  - `apiImportMemories(uid: string, memories: MemoryItem[]): Promise<boolean>`
  - `apiListOmiConversations(uid: string, limit?: number, offset?: number, statuses?: string[]): Promise<ConversationItem[]>`
  - `apiListOmiMemories(uid: string, limit?: number, offset?: number): Promise<MemoryItem[]>`
  - Extend Preferences DTO with: `activationRegex`, `activationSensitivity`, `mute`, `dndQuietHoursStart`, `dndQuietHoursEnd`.

- Minimal UI changes:
  - Add "Sync from OMI" button in memories/conversations screens.
  - Show real-time transcript status in chat/meeting UI.

- Offline/queued:
  - Buffer transcript segments if offline, send when online.

---

## 5. Data Contracts (Final)

### 5.1 Transcript Segment

```typescript
type TranscriptSegment = {
  text: string;
  speaker: string;
  speakerId?: number;
  is_user?: boolean;
  start: number;
  end: number;
  segment_id?: string; // for idempotency
};
```

### 5.2 Memory Import

**Request:**
```json
{
  "uid": "abc123",
  "memories": [
    { "text": "My passport is in the top drawer", "source": "user" }
  ]
}
```
**Response:**
```json
{ "ok": true, "imported": 1 }
```

### 5.3 Conversation List

**Request:**
`GET /omi/import/conversations?uid=abc123&limit=50&statuses=active`

**Response:**
```json
{
  "ok": true,
  "conversations": [
    { "id": "c1", "title": "Trip planning", "status": "active", "created_at": "..." }
  ],
  "nextCursor": "..."
}
```

### 5.4 Pagination

- Use `limit` and `offset` or `cursor` for all list endpoints.
- `nextCursor` in response for pagination.

---

## 6. Migration and De-bloat Plan

### 6.1 What to Delete/Simplify

- Remove legacy OMI logic from `server.js` (e.g., old webhook handlers, duplicate memory/conversation logic).
- Move all OMI-related routes to `/omi/` or `/realtime/` modules.
- Remove in-memory session state for transcripts; use DB.
- Remove unused endpoints and bloat (e.g., old notification/event logic).
- **Refactor all activation/trigger logic into a dedicated module/service.**
- **Roll out context-based activation behind a feature flag.**

### 6.2 What to Keep

- Auth/session management
- Core user, memory, conversation models (refactored for new flows)
- OpenAI integration (modularized)

### 6.3 Migration Steps

1. Implement new endpoints in modules.
2. Dual-write to new tables while keeping old logic.
3. Add feature flags to switch over.
4. Validate new endpoints with test clients.
5. Remove old code after cutover.

---

## 7. Risks and Open Questions

- **OMI API changes**: Monitor for breaking changes in OMI endpoints.
- **Rate limits**: Ensure proper handling and backoff.
- **Audio streaming**: If required, may need a sidecar service.
- **Prompt config**: Decide on DB vs. file storage for prompt definitions.
- **Data reconciliation**: How to handle conflicts between local and OMI memories/conversations.
- **Privacy**: Ensure all PII is handled per policy.

---

## Sequence Diagrams

### 1. Real-Time Transcript Processing

```
Mobile/OMI Device
    |
    |--(audio)--> OMI Cloud
    |             |
    |<-(segments)-|
    |--POST /realtime/transcripts--> Express
    |                                |
    |<--200 OK-----------------------|
    |                                |
    |--(triggers prompt/memory logic)|
```

### 2. Prompt-Based Memory Creation

```
Transcript End
    |
    |--(trigger)--> Prompt Runner
    |                |
    |--(OpenAI call)-|
    |                |
    |<-(summary)-----|
    |--(save as memory)--> DB
```

### 3. Integration Import Sync

```
Express (cron/trigger)
    |
    |--GET /omi/import/conversations?uid=...--> OMI API
    |<--[conversations]------------------------|
    |--(upsert to local DB)-------------------|
```

---

**This guide is implementation-ready and covers all required features, data contracts, and migration steps.**
