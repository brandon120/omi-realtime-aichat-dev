# Conversation State Setup Guide

## Current Status

The conversation state management feature has been implemented but requires a database to function. Without a database, the system operates in stateless mode.

## Requirements

For conversation state to work, you need:

1. **PostgreSQL Database** - The system uses Prisma ORM with PostgreSQL
2. **Environment Variables** - Configure `DATABASE_URL` 
3. **User System Enabled** - Set `ENABLE_USER_SYSTEM=true`

## Quick Setup

### 1. Database Configuration

Set your database URL in the environment:

```bash
# Example for local PostgreSQL
export DATABASE_URL="postgresql://user:password@localhost:5432/omi_db"

# Example for Railway PostgreSQL
export DATABASE_URL="postgresql://postgres:xxx@xxx.railway.app:5432/railway"
```

### 2. Run Database Migrations

```bash
# Generate Prisma client
npx prisma generate

# Apply migrations
npx prisma migrate deploy
```

### 3. Enable User System

```bash
export ENABLE_USER_SYSTEM=true
```

### 4. Configure Conversation State (Optional)

```bash
# Enable conversation state management
export OPENAI_CONVERSATION_STATE=true  # Default: true

# Store responses for continuity
export OPENAI_STORE_RESPONSES=true     # Default: true

# Token limits
export OPENAI_MAX_CONTEXT_TOKENS=500   # Default: 500
export OPENAI_WEBHOOK_MAX_TOKENS=300   # Default: 300
export OPENAI_WEBHOOK_TIMEOUT=8000     # Default: 8000ms
```

## Testing Without Database

If you want to test the basic functionality without a database:

1. **Stateless Mode**: The system will work but won't remember conversations between requests
2. **Memory Context**: Won't be available (requires database)
3. **User Preferences**: Will use defaults

## Testing With Database

Once database is configured:

```bash
# Test conversation continuity
node test-conversation-state.js

# Manual test with curl
SESSION="test-$(date +%s)"

# First message
curl -X POST http://localhost:3000/omi-webhook \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION\",
    \"segments\": [{
      \"text\": \"Hey Omi, my name is Alice\",
      \"is_user\": true,
      \"start\": 0,
      \"end\": 3
    }]
  }"

# Follow-up (should remember name)
curl -X POST http://localhost:3000/omi-webhook \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION\",
    \"segments\": [{
      \"text\": \"Hey Omi, what's my name?\",
      \"is_user\": true,
      \"start\": 5,
      \"end\": 7
    }]
  }"
```

## How It Works

### With Database (Full Features):
1. Creates/retrieves OpenAI conversation ID
2. Stores response IDs for chaining
3. Uses `previous_response_id` for context
4. Maintains conversation state across requests

### Without Database (Stateless):
1. Each request is independent
2. No conversation history
3. Uses only immediate context from request
4. Still provides intelligent responses

## Troubleshooting

### Issue: "Environment variable not found: DATABASE_URL"
**Solution**: Set the DATABASE_URL environment variable

### Issue: "Conversation not remembered"
**Check**:
1. Database is configured
2. `ENABLE_USER_SYSTEM=true`
3. Using same `session_id` across requests
4. Including trigger phrase (e.g., "Hey Omi")

### Issue: "Slow responses"
**Optimize**:
1. Reduce `OPENAI_MAX_CONTEXT_TOKENS`
2. Reduce `OPENAI_WEBHOOK_MAX_TOKENS`
3. Check database connection latency

## Architecture Notes

The conversation state system is designed to:
- Work with or without a database
- Gracefully degrade to stateless mode
- Maintain backward compatibility
- Preserve privacy between sessions

When a database is available, the system provides:
- Full conversation continuity
- User preferences
- Memory injection
- Response chaining

Without a database, it still provides:
- Intelligent responses
- Trigger phrase detection
- Basic conversation handling
- Fast response times