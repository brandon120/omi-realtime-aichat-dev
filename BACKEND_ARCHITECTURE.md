# OMI Realtime AI Chat - Backend Architecture Documentation

## Overview

This document provides a comprehensive analysis of the backend architecture for the OMI Realtime AI Chat system. The backend is built with Express.js and serves as both a webhook endpoint for OMI voice interactions and a REST API for the Expo mobile application.

## System Architecture

### High-Level Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   OMI Platform  │    │   Mobile App    │    │   Backend API   │
│   (Voice)       │    │   (Expo/React)  │    │   (Express.js)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Webhook Calls  │    │  REST API Calls │    │  OpenAI API     │
│  /omi-webhook   │    │  /auth, /api/*  │    │  (GPT-4/5)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │   PostgreSQL    │
                    │   (Prisma ORM)  │
                    └─────────────────┘
```

## Backend Structure

### Core Files

- **`server.js`** - Main Express server (2,591 lines)
- **`package.json`** - Dependencies and scripts
- **`prisma/schema.prisma`** - Database schema definition
- **`prisma/migrations/`** - Database migration files
- **`env.example`** - Environment configuration template

### Dependencies

#### Production Dependencies
- **express** (^4.18.2) - Web framework
- **openai** (^5.20.2) - OpenAI API client
- **@prisma/client** (^6.16.1) - Database ORM
- **argon2** (^0.44.0) - Password hashing
- **cookie-parser** (^1.4.7) - Cookie parsing middleware
- **dotenv** (^16.3.1) - Environment variable management
- **nanoid** (^5.1.5) - ID generation
- **axios** (^1.6.0) - HTTP client

#### Development Dependencies
- **nodemon** (^3.0.1) - Development server
- **prisma** (^6.16.1) - Database toolkit

## Database Schema (Prisma)

### Core Models

#### User Management
```prisma
model User {
  id          String   @id @default(cuid())
  email       String   @unique
  passwordHash String
  displayName String?
  role        Role     @default(USER)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  // Relations
  authSessions     AuthSession[]
  omiUserLinks     OmiUserLink[]
  conversations    Conversation[]
  memories         Memory[]
  agentEvents      AgentEvent[]
  notificationEvents NotificationEvent[]
  userPreferences  UserPreference?
  userContextWindows UserContextWindow[]
}

model AuthSession {
  id          String   @id @default(cuid())
  userId      String
  sessionToken String  @unique
  expiresAt   DateTime?
  createdAt   DateTime @default(now())
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

#### OMI Integration
```prisma
model OmiUserLink {
  id                    String    @id @default(cuid())
  userId                String
  omiUserId             String    @unique
  isVerified            Boolean   @default(false)
  verificationCode      String?
  verificationExpiresAt DateTime?
  verificationAttempts  Int       @default(0)
  verifiedAt            DateTime?
  createdAt             DateTime  @default(now())
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model OmiSession {
  id          String   @id @default(cuid())
  omiSessionId String  @unique
  userId      String?
  lastSeenAt  DateTime @default(now())
  createdAt   DateTime @default(now())
  
  user             User?              @relation(fields: [userId], references: [id], onDelete: SetNull)
  conversations    Conversation[]
  transcriptSegments TranscriptSegment[]
  preferences      OmiSessionPreference?
}
```

#### Conversation Management
```prisma
model Conversation {
  id                   String   @id @default(cuid())
  userId               String?
  omiSessionId         String?
  openaiConversationId String?
  title                String?
  summary              String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  
  user             User?              @relation(fields: [userId], references: [id], onDelete: SetNull)
  omiSession       OmiSession?        @relation(fields: [omiSessionId], references: [id], onDelete: SetNull)
  messages         Message[]
  userContextWindows UserContextWindow[]
}

model Message {
  id             String       @id @default(cuid())
  conversationId String
  role           MessageRole
  text           String
  source         MessageSource
  createdAt      DateTime     @default(now())
  
  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
}
```

#### Context Management
```prisma
model UserContextWindow {
  id             String   @id @default(cuid())
  userId         String
  slot           Int      // 1-5
  conversationId String?
  isActive       Boolean  @default(false)
  createdAt      DateTime @default(now())
  
  user         User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  conversation Conversation? @relation(fields: [conversationId], references: [id], onDelete: SetNull)
  
  @@unique([userId, slot])
}
```

#### Memory & Task Management
```prisma
model Memory {
  id        String   @id @default(cuid())
  userId    String
  text      String
  createdAt DateTime @default(now())
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model AgentEvent {
  id        String   @id @default(cuid())
  userId    String
  type      String
  payload   Json?
  createdAt DateTime @default(now())
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

## API Endpoints

### Authentication Endpoints

#### POST `/auth/register`
- **Purpose**: User registration
- **Body**: `{ email, password, display_name? }`
- **Response**: `{ ok: true, session_token: string, user: User }`
- **Security**: Password hashed with Argon2

#### POST `/auth/login`
- **Purpose**: User authentication
- **Body**: `{ email, password }`
- **Response**: `{ ok: true, session_token: string, user: User }`
- **Security**: Session-based authentication

#### POST `/auth/logout`
- **Purpose**: Session termination
- **Response**: `{ ok: true }`
- **Security**: Clears session token

#### GET `/me`
- **Purpose**: Get current user profile
- **Response**: `{ ok: true, user: User, omi_links: OmiUserLink[] }`
- **Security**: Requires authentication

### Account Management Endpoints

#### GET `/account/profile`
- **Purpose**: Get user profile
- **Response**: `{ ok: true, user: User }`

#### PATCH `/account/profile`
- **Purpose**: Update user profile
- **Body**: `{ display_name?, email?, current_password? }`
- **Security**: Email change requires current password

#### POST `/account/password`
- **Purpose**: Change password
- **Body**: `{ current_password, new_password }`
- **Security**: Requires current password

#### GET `/account/sessions`
- **Purpose**: List active sessions
- **Response**: `{ ok: true, sessions: Session[] }`

#### POST `/account/sessions/revoke`
- **Purpose**: Revoke specific session
- **Body**: `{ session_token }`

#### POST `/account/sessions/revoke-others`
- **Purpose**: Revoke all other sessions

#### DELETE `/account`
- **Purpose**: Delete user account
- **Body**: `{ current_password }`
- **Security**: Requires current password

### OMI Integration Endpoints

#### POST `/link/omi/start`
- **Purpose**: Start OMI account linking
- **Body**: `{ omi_user_id }`
- **Response**: `{ ok: true, omi_user_id: string, dev_code?: string }`
- **Process**: Generates OTP, sends notification

#### POST `/link/omi/confirm`
- **Purpose**: Confirm OMI account linking
- **Body**: `{ omi_user_id, code, omi_session_id? }`
- **Response**: `{ ok: true }`
- **Process**: Verifies OTP, creates link

#### GET `/link/omi`
- **Purpose**: List OMI links
- **Response**: `{ ok: true, items: OmiUserLink[] }`

#### POST `/link/omi/resend`
- **Purpose**: Resend verification code
- **Body**: `{ omi_user_id }`

#### DELETE `/link/omi/unlink/:omi_user_id`
- **Purpose**: Unlink OMI account

### Conversation Management Endpoints

#### POST `/messages/send`
- **Purpose**: Send message to AI
- **Body**: `{ conversation_id?, slot?, text }`
- **Response**: `{ ok: true, conversation_id: string, assistant_text: string }`
- **Process**: 
  1. Validates conversation ownership
  2. Creates/updates OpenAI conversation
  3. Calls OpenAI API
  4. Persists messages
  5. Sends OMI notification

#### GET `/conversations`
- **Purpose**: List user conversations
- **Query**: `{ limit?, cursor? }`
- **Response**: `{ ok: true, items: Conversation[], nextCursor?: string }`

#### GET `/conversations/:id`
- **Purpose**: Get specific conversation
- **Response**: `{ ok: true, conversation: Conversation }`

#### GET `/conversations/:id/messages`
- **Purpose**: List conversation messages
- **Query**: `{ limit?, cursor? }`
- **Response**: `{ ok: true, items: Message[], nextCursor?: string }`

#### DELETE `/conversations/:id`
- **Purpose**: Delete conversation and messages

#### POST `/followups`
- **Purpose**: Create follow-up notification
- **Body**: `{ conversation_id?, message }`
- **Response**: `{ ok: true, delivered: boolean, followup_id: string }`

### Context Management Endpoints

#### GET `/spaces`
- **Purpose**: List available spaces
- **Response**: `{ ok: true, active: string, spaces: string[] }`
- **Spaces**: `['default', 'todos', 'memories', 'tasks', 'agent', 'friends', 'notifications']`

#### POST `/spaces/switch`
- **Purpose**: Switch active space
- **Body**: `{ space }`
- **Response**: `{ ok: true, active: string }`

#### GET `/windows`
- **Purpose**: List context windows (slots 1-5)
- **Response**: `{ ok: true, items: Window[] }`

#### POST `/windows/activate`
- **Purpose**: Activate specific window slot
- **Body**: `{ slot }`
- **Response**: `{ ok: true, active_slot: number }`

### Memory Management Endpoints

#### GET `/memories`
- **Purpose**: List user memories
- **Query**: `{ limit?, cursor? }`
- **Response**: `{ ok: true, items: Memory[], nextCursor?: string }`

#### POST `/memories`
- **Purpose**: Create memory
- **Body**: `{ text }`
- **Response**: `{ ok: true, memory: Memory }`

#### DELETE `/memories/:id`
- **Purpose**: Delete memory

### Task Management Endpoints

#### GET `/agent-events`
- **Purpose**: List agent events (tasks)
- **Query**: `{ limit?, cursor? }`
- **Response**: `{ ok: true, items: AgentEvent[], nextCursor?: string }`

#### POST `/agent-events`
- **Purpose**: Create agent event
- **Body**: `{ type, payload? }`
- **Response**: `{ ok: true, event: AgentEvent }`

#### PATCH `/agent-events/:id/complete`
- **Purpose**: Mark task as complete
- **Response**: `{ ok: true, event: AgentEvent }`

### Preferences Endpoints

#### GET `/preferences`
- **Purpose**: Get user preferences
- **Response**: `{ ok: true, preferences: Preferences }`

#### PATCH `/preferences`
- **Purpose**: Update user preferences
- **Body**: `{ listen_mode?, followup_window_ms?, meeting_transcribe?, inject_memories?, default_conversation_id? }`
- **Response**: `{ ok: true, preferences: Preferences }`

### OMI Import Endpoints

#### POST `/omi/import/conversation`
- **Purpose**: Import conversation to OMI
- **Body**: `{ uid, text, started_at?, finished_at?, language?, geolocation?, text_source?, text_source_spec? }`

#### POST `/omi/import/memories`
- **Purpose**: Import memories to OMI
- **Body**: `{ uid, text?, text_source?, text_source_spec?, memories? }`

#### GET `/omi/import/conversations`
- **Purpose**: Read conversations from OMI
- **Query**: `{ uid, limit?, offset?, include_discarded?, statuses? }`

#### GET `/omi/import/memories`
- **Purpose**: Read memories from OMI
- **Query**: `{ uid, limit?, offset? }`

### Webhook Endpoint

#### POST `/omi-webhook`
- **Purpose**: Main OMI voice interaction endpoint
- **Body**: `{ session_id, segments[], user_id?, end?, final?, is_final? }`
- **Process**:
  1. Accumulates transcript segments
  2. Handles voice OTP verification
  3. Processes different listen modes (TRIGGER, FOLLOWUP, ALWAYS)
  4. Manages conversation context
  5. Calls OpenAI API
  6. Persists data
  7. Sends response to OMI

### Utility Endpoints

#### GET `/health`
- **Purpose**: Health check
- **Response**: System status and configuration

#### GET `/health/db`
- **Purpose**: Database health check
- **Response**: `{ ok: boolean }`

#### GET `/help`
- **Purpose**: API documentation
- **Response**: Usage instructions and examples

#### GET `/rate-limit/:userId`
- **Purpose**: Check rate limit status
- **Response**: Rate limit information

#### GET `/metrics/activation`
- **Purpose**: Activation metrics
- **Response**: `{ ok: true, counters: object }`

## Core Functionality

### Voice Processing Pipeline

1. **Webhook Reception**: Receives voice segments from OMI
2. **Transcript Accumulation**: Builds complete transcript from segments
3. **Voice OTP Verification**: Handles account linking via voice
4. **Listen Mode Processing**: 
   - TRIGGER: Requires activation phrases
   - FOLLOWUP: Allows follow-up within time window
   - ALWAYS: Processes all input
5. **Intent Recognition**: Identifies user intents (menu, spaces, conversations, etc.)
6. **Context Management**: Manages spaces and conversation windows
7. **AI Processing**: Calls OpenAI API with conversation context
8. **Response Formatting**: Adds headers and footers with context
9. **Data Persistence**: Saves conversations and messages
10. **OMI Notification**: Sends response back to OMI

### Authentication & Security

- **Session-based authentication** with signed cookies
- **Password hashing** using Argon2
- **Rate limiting** for OMI notifications (10/hour per user)
- **CORS protection** with configurable origins
- **Input validation** and sanitization
- **SQL injection protection** via Prisma ORM

### OpenAI Integration

- **Primary API**: OpenAI Responses API with Conversations
- **Fallback**: Standard Chat Completions API
- **Model**: `gpt-5-mini-2025-08-07` (primary), `gpt-4o` (fallback)
- **Features**: Web search, conversation state, memory injection
- **Rate limiting**: Built-in OpenAI rate limiting

### Context Management

- **Spaces**: 7 different context spaces (default, todos, memories, tasks, agent, friends, notifications)
- **Windows**: 5 conversation slots per user
- **Memory Injection**: Optional memory context in AI responses
- **Session State**: Maintains conversation state per OMI session

## Mobile App Integration

### API Client (`mobile/lib/api.ts`)

The mobile app uses a comprehensive API client that handles:

- **Authentication**: Login, register, logout, session management
- **Conversations**: List, create, send messages, delete
- **Context Management**: Spaces, windows, preferences
- **Memory Management**: Create, list, delete memories
- **Task Management**: Create, list, complete tasks
- **OMI Integration**: Link accounts, manage connections

### Key Mobile App Features

1. **Authentication Flow**: Complete user registration and login
2. **Chat Interface**: Real-time conversation with AI
3. **Memory Management**: Store and retrieve personal memories
4. **Task Management**: Create and track tasks
5. **Context Switching**: Switch between different spaces and windows
6. **OMI Linking**: Connect voice interactions to web account
7. **Settings Management**: Configure preferences and account settings

### Data Flow

```
Mobile App → API Client → Express Server → Database
     ↓              ↓           ↓
  UI Updates ← Response ← Business Logic ← Data Persistence
```

## Environment Configuration

### Required Environment Variables

```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# OMI Configuration
OMI_APP_ID=your_omi_app_id_here
OMI_APP_SECRET=your_omi_app_secret_here

# Database
DATABASE_URL=postgres://user:password@host:port/dbname

# Feature Flags
ENABLE_USER_SYSTEM=true

# Security
SESSION_SECRET=change_me_in_production

# CORS
CORS_ORIGINS=http://localhost:8081,https://yourdomain.com
```

## Deployment Considerations

### Production Setup

1. **Database**: PostgreSQL with Prisma migrations
2. **Environment**: Node.js 18+ with PM2 or similar
3. **Security**: HTTPS, secure cookies, environment variables
4. **Monitoring**: Health checks, rate limiting, error handling
5. **Scaling**: Stateless design, database connection pooling

### Performance Optimizations

- **Connection pooling** for database connections
- **Rate limiting** to prevent abuse
- **Caching** for frequently accessed data
- **Async processing** for non-critical operations
- **Error handling** with graceful degradation

## Future Enhancement Areas

Based on the OMI documentation, potential improvements include:

1. **Enhanced Voice Processing**: Better voice command recognition
2. **Advanced Context Management**: More sophisticated context switching
3. **Real-time Features**: WebSocket support for live updates
4. **Analytics**: User interaction tracking and insights
5. **Integration Expansion**: More OMI platform features
6. **Performance**: Caching and optimization improvements
7. **Security**: Enhanced authentication and authorization
8. **Monitoring**: Comprehensive logging and metrics

This architecture provides a solid foundation for a real-time AI chat system that integrates voice interactions through OMI with a comprehensive mobile application interface.
