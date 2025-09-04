# Omi Real-Time AI Chat Plugin

A Node.js Express backend plugin for Omi that provides real-time AI chat capabilities using OpenAI's GPT-4 model with web search. When users say "hey omi" followed by a question, the plugin automatically processes the question through GPT-4 and sends the response back to the user via Omi's notification system.

## Architecture Overview

```
┌─────────────┐    ┌─────────────────┐    ┌─────────────┐    ┌─────────────┐
│   Omi AI   │───▶│  Express Server │───▶│  OpenAI    │───▶│   Omi      │
│  Webhook   │    │                 │    │  GPT-4o    │    │Notification│
└─────────────┘    └─────────────────┘    └─────────────┘    └─────────────┘
                          │
                          ▼
                   ┌─────────────────┐
                   │ Session Manager │
                   │ Rate Limiter    │
                   │ Transcript Store│
                   └─────────────────┘
```

### **Core Components**
- **Webhook Handler**: Processes incoming Omi transcript data
- **AI Service**: Manages OpenAI API interactions with web search
- **Notification Service**: Handles Omi API communication
- **Session Manager**: Tracks conversation context and cleanup
- **Rate Limiter**: Prevents API abuse (10 notifications/hour per user)

## Features

- **Voice Activation**: Listens for transcripts starting with "hey omi"
- **Smart Detection**: Natural language processing for AI interaction detection
- **GPT-4o Integration**: Uses OpenAI's latest model with web search capabilities
- **Real-time Notifications**: Sends responses back to users through Omi's notification API
- **Rate Limiting**: Intelligent rate limiting to prevent API errors
- **Session Management**: Maintains conversation context and automatic cleanup
- **Error Handling**: Comprehensive error handling and logging
- **Health Monitoring**: Built-in health check and monitoring endpoints
- **Railway Ready**: Optimized for Railway deployment with auto-scaling

## Prerequisites

- Node.js 18+ installed
- OpenAI API key with GPT-4o access
- Omi App ID and App Secret
- Railway account (for deployment)

## Local Setup

### 1. Clone and Install Dependencies

```bash
git clone <your-repo-url>
cd omi-realtime-aichat
npm install
```

### 2. Environment Configuration

Copy the environment template and configure your API keys:

```bash
cp env.example .env
```

Edit `.env` with your actual API keys:

```env
OPENAI_KEY=sk-your-openai-api-key-here
OMI_APP_ID=your_omi_app_id_here
OMI_APP_SECRET=your_omi_app_secret_here
PORT=3000
```

### 3. Run Locally

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

The server will start on `http://localhost:3000`

### 4. Test the Webhook

You can test the webhook locally using curl or Postman:

```bash
curl -X POST http://localhost:3000/omi-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test_session_123",
    "segments": [
      {
        "id": "test_segment_1",
        "text": "hey omi what is the weather like today?",
        "speaker": "SPEAKER_1",
        "speaker_id": 1,
        "is_user": false,
        "start": 0,
        "end": 5
      }
    ]
  }'
```

## Railway Deployment

### 1. Install Railway CLI

```bash
npm install -g @railway/cli
```

### 2. Login to Railway

```bash
railway login
```

### 3. Initialize Railway Project

```bash
railway init
```

### 4. Set Environment Variables

```bash
railway variables set OPENAI_KEY=sk-your-openai-api-key-here
railway variables set OMI_APP_ID=your_omi_app_id_here
railway variables set OMI_APP_SECRET=your_omi_app_secret_here
```

### 5. Deploy

```bash
railway up
```

### 6. Get Your Webhook URL

```bash
railway domain
```

Your webhook URL will be: `https://your-app-name.railway.app/omi-webhook`

## Omi Plugin Registration

### 1. Access Omi Plugin Dashboard

1. Go to [Omi Plugin Dashboard](https://omi.me/plugins)
2. Click "Create New Plugin"

### 2. Plugin Configuration

- **Plugin Name**: Omi AI Chat
- **Description**: Real-time AI chat using GPT-4 with web search
- **Webhook URL**: `https://your-app-name.railway.app/omi-webhook`
- **Trigger Phrase**: `hey omi` (or natural language questions)
- **Permissions**: 
  - Read transcripts
  - Send notifications

### 3. Webhook Payload Format

The plugin expects webhook payloads in this format:

```json
{
  "session_id": "session_abc123xyz789",
  "segments": [
    {
      "id": "seg_abc123def456",
      "text": "What's the weather like in Sydney?",
      "speaker": "SPEAKER_1",
      "speaker_id": 1,
      "is_user": false,
      "start": 5.624041808510637,
      "end": 7.533829765957446
    }
  ]
}
```

### 4. Response Format

The plugin responds with:

```json
{
  "success": true,
  "message": "Question processed and response sent to Omi",
  "question": "what is artificial intelligence?",
  "ai_response": "Artificial intelligence (AI) is...",
  "omi_response": { "status": "success" },
  "session_id": "session_abc123xyz789"
}
```

## API Reference

### Health Check
```
GET /health
```
Returns server status, configuration, and rate limiting information.

### Help & Instructions
```
GET /help
```
Provides usage instructions, trigger phrases, and examples.

### Rate Limit Status
```
GET /rate-limit/:userId
```
Shows rate limit status for a specific user.

### Main Webhook
```
POST /omi-webhook
```
Processes incoming Omi transcript data and generates AI responses.

## 🔧 Configuration Options

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `OPENAI_KEY` | OpenAI API key | Yes | - |
| `OMI_APP_ID` | Omi App ID | Yes | - |
| `OMI_APP_SECRET` | Omi App Secret | Yes | - |
| `PORT` | Server port | No | 3000 |

### OpenAI Configuration

The plugin uses these GPT-4 settings:
- **Model**: `gpt-4o` (latest with web search)
- **Web Search**: Built-in `web_search_preview` tool
- **Fallback**: Regular chat completion if Responses API fails
- **System Prompt**: Optimized for helpful, accurate responses

### Omi API Configuration

The plugin uses Omi's official notification API:
- **Endpoint**: `/v2/integrations/{app_id}/notification`
- **Method**: POST
- **Authentication**: Bearer token with App Secret
- **Parameters**: `uid` and `message` as query parameters

## Error Handling

The plugin handles various error scenarios:

- **Missing Fields**: Returns 400 for incomplete webhook data
- **API Errors**: Handles OpenAI and Omi API errors gracefully
- **Rate Limiting**: Prevents notification spam with intelligent limits
- **Network Issues**: Retries and provides clear error messages
- **Validation**: Ensures transcripts contain valid AI interaction triggers

## Security Considerations

- API keys are stored as environment variables
- Input validation prevents malicious payloads
- HTTPS enforced in production (Railway)
- Rate limiting prevents API abuse
- Session cleanup prevents memory leaks

## Testing

### Manual Testing

1. Start the server locally
2. Send test webhook payloads
3. Verify OpenAI responses
4. Check Omi notification delivery

### Automated Testing

```bash
# Test OpenAI Responses API integration
node test-responses-api.js

# Test rate limiting functionality
node test-rate-limit.js
```

## Scaling and Performance

- **Stateless**: No database dependencies
- **Async Processing**: Non-blocking webhook handling
- **Railway Auto-scaling**: Automatically scales based on traffic
- **Response Time**: Typically 2-5 seconds for full request cycle
- **Memory Management**: Automatic session and rate limit cleanup
- **Web Search**: Built-in for current information without external APIs

## Troubleshooting

### Common Issues

1. **Environment Variables Not Set**
   - Check Railway variables are configured
   - Verify `.env` file exists locally

2. **OpenAI API Errors**
   - Verify API key is valid
   - Check OpenAI account has credits
   - Ensure API key has GPT-4o access

3. **Omi Notification Failures**
   - Verify Omi App ID and App Secret are correct
   - Check user_id format
   - Ensure plugin has notification permissions

4. **Webhook Not Receiving Data**
   - Verify webhook URL in Omi plugin settings
   - Check Railway deployment status
   - Test with health check endpoint

5. **Rate Limiting Issues**
   - Check `/rate-limit/:userId` endpoint
   - Wait for hourly reset or implement higher limits

### Debug Mode

Enable verbose logging by setting:

```bash
railway variables set DEBUG=true
```

## Future Enhancements

- **Modular Architecture**: Separate services for AI, notifications, and sessions
- **Plugin System**: Support for custom AI tools and integrations
- **Multi-Platform**: Slack, Discord, and other chat platform support
- **User Management**: Session tracking and user preferences
- **Analytics**: Usage metrics and performance monitoring
- **Caching**: Redis integration for improved response times

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- Check the troubleshooting section above
- Review Railway deployment logs
- Open an issue on GitHub
- Contact Omi support for plugin-specific issues

---

