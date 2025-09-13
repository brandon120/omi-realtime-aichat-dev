# Omi Real-Time AI Chat Plugin

A Node.js backend plugin for Omi that provides real-time AI chat capabilities using OpenAI's Responses API (gpt-4o / gpt-4o-mini) with Conversations for stateful chats. When users say "hey omi" followed by a question, the plugin processes the question and sends the response back to the user via Omi's notification system.

## 🚀 Features

- **Voice Activation**: Listens for transcripts starting with "hey omi"
- **Responses + Conversations**: Uses OpenAI's Responses API with Conversations for per-session context
- **Real-time Notifications**: Sends responses back to users through Omi's notification API
- **Error Handling**: Comprehensive error handling and logging
- **Health Monitoring**: Built-in health check endpoint
- **Railway Ready**: Optimized for Railway deployment

## 📋 Prerequisites

- Node.js 18+ installed
- OpenAI API key
- Omi App ID and App Secret
- Railway account (for deployment)

## 🛠️ Local Setup

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

Edit `.env` with your actual API keys (prefer `OPENAI_API_KEY`; `OPENAI_KEY` is also supported):

```env
OPENAI_API_KEY=sk-your-openai-api-key-here
# (optional fallback)
# OPENAI_KEY=sk-your-openai-api-key-here
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

## 🚀 Railway Deployment

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
railway variables set OPENAI_API_KEY=sk-your-openai-api-key-here
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

## 🔌 Omi Plugin Registration

### 1. Access Omi Plugin Dashboard

1. Go to [Omi Plugin Dashboard](https://omi.me/plugins)
2. Click "Create New Plugin"

### 2. Plugin Configuration

- **Plugin Name**: Omi AI Chat
- **Description**: Real-time AI chat using GPT-4
- **Webhook URL**: `https://your-app-name.railway.app/omi-webhook`
- **Trigger Phrase**: `hey omi`
- **Permissions**: 
  - Read transcripts
  - Send notifications

### 3. Webhook Payload Format

The plugin expects webhook payloads in this format:

```json
{
  "session_id": "o0qOP4YkbEUWKE3Vk0hXMnVzH9I3",
  "segments": [
    {
      "id": "6b0b382f-cb57-465c-88e6-baa8de28c455",
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
  "omi_status": 200
}
```

## 📊 Monitoring and Health Checks

### Health Check Endpoint

```
GET /health
```

Returns server status and confirms the plugin is running.

### Logging

The plugin provides comprehensive logging:
- 📥 Incoming webhooks
- 🤖 AI processing status
- 📤 Omi notification status
- ❌ Error details
- ⚠️ Environment variable warnings

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
- **Model**: `gpt-4`
- **Max Tokens**: 500
- **Temperature**: 0.7
- **System Prompt**: "You are a helpful AI assistant. Provide clear, concise, and helpful responses."

### Omi API Configuration

The plugin uses Omi's official notification API:
- **Endpoint**: `/v2/integrations/{app_id}/notification`
- **Method**: POST
- **Authentication**: Bearer token with App Secret
- **Parameters**: `uid` and `message` as query parameters

## 🚨 Error Handling

The plugin handles various error scenarios:

- **Missing Fields**: Returns 400 for incomplete webhook data
- **API Errors**: Handles OpenAI and Omi API errors gracefully
- **Network Issues**: Retries and provides clear error messages
- **Validation**: Ensures transcripts start with "hey omi"

## 🔒 Security Considerations

- API keys are stored as environment variables
- Input validation prevents malicious payloads
- HTTPS enforced in production (Railway)
- Rate limiting can be added if needed

## 🧪 Testing

### Manual Testing

1. Start the server locally
2. Send test webhook payloads
3. Verify OpenAI responses
4. Check Omi notification delivery

### Automated Testing

```bash
# Run tests (if implemented)
npm test
```

## 📈 Scaling and Performance

- **Stateless**: No database dependencies
- **Async Processing**: Non-blocking webhook handling
- **Railway Auto-scaling**: Automatically scales based on traffic
- **Response Time**: Typically 2-5 seconds for full request cycle

## 🆘 Troubleshooting

### Common Issues

1. **Environment Variables Not Set**
   - Check Railway variables are configured
   - Verify `.env` file exists locally

2. **OpenAI API Errors**
   - Verify API key is valid
   - Check OpenAI account has credits
   - Ensure API key has GPT-4 access

3. **Omi Notification Failures**
   - Verify Omi App ID and App Secret are correct
   - Check user_id format
   - Ensure plugin has notification permissions

4. **Webhook Not Receiving Data**
   - Verify webhook URL in Omi plugin settings
   - Check Railway deployment status
   - Test with health check endpoint

### Debug Mode

Enable verbose logging by setting:

```bash
railway variables set DEBUG=true
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

For issues and questions:
- Check the troubleshooting section above
- Review Railway deployment logs
- Open an issue on GitHub
- Contact Omi support for plugin-specific issues

---

**Happy coding with Omi! 🎉**
