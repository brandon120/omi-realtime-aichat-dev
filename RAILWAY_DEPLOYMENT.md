# Railway Deployment Guide for Omi AI Chat Plugin

## Prerequisites

Before deploying to Railway, you need to set up the following services:

### 1. ChromaDB Vector Database
ChromaDB is required for the memory features. You have several options:

#### Option A: Railway ChromaDB Service (Recommended)
1. In your Railway project, add a new service
2. Search for "ChromaDB" in the service catalog
3. Deploy the ChromaDB service
4. Note the internal URL (e.g., `http://chromadb:8000`)

#### Option B: External ChromaDB Service
1. Deploy ChromaDB to a cloud provider (AWS, GCP, Azure)
2. Use a service like [Chroma Cloud](https://www.trychroma.com/) or [Pinecone](https://www.pinecone.io/)
3. Get the connection URL

#### Option C: Local ChromaDB (Development Only)
```bash
docker run -p 8000:8000 chromadb/chroma:latest
```

### 2. Environment Variables

Set these environment variables in your Railway project:

#### Required Variables:
- `OPENAI_KEY` - Your OpenAI API key
- `OMI_APP_ID` - Your Omi application ID
- `OMI_APP_SECRET` - Your Omi application secret
- `CHROMA_URL` - ChromaDB connection URL (e.g., `http://chromadb:8000`)

#### Optional Variables:
- `PORT` - Server port (default: 3000)

## Deployment Steps

### 1. Connect Repository
1. Go to [Railway](https://railway.app/)
2. Create a new project
3. Connect your GitHub repository
4. Select the repository containing this code

### 2. Add ChromaDB Service
1. In your Railway project dashboard
2. Click "New Service"
3. Search for "ChromaDB" or "Vector Database"
4. Deploy the service
5. Note the internal URL

### 3. Set Environment Variables
1. Go to your main service settings
2. Add the environment variables listed above
3. Set `CHROMA_URL` to your ChromaDB service URL

### 4. Deploy
1. Railway will automatically deploy when you push to your main branch
2. Check the deployment logs for any errors
3. Verify the service is running

## Verification

### 1. Health Check
Visit: `https://your-app.railway.app/health`

You should see:
```json
{
  "status": "OK",
  "memory_system": {
    "vector_store": "ChromaDB",
    "status": "active"
  }
}
```

### 2. Test Memory Features
1. Send a webhook to `/omi-webhook` with a test message
2. Try the memory commands:
   - "Hey Omi, my name is John"
   - "save to memory"
   - "Hey Omi, what's my name?"

## Troubleshooting

### Common Issues:

#### 1. ChromaDB Connection Error
```
❌ Failed to initialize ChromaDB: ChromaDB server not available
```
**Solution:** Check that `CHROMA_URL` is set correctly and ChromaDB service is running.

#### 2. OpenAI API Key Error
```
❌ OPENAI_API_KEY environment variable is missing
```
**Solution:** Set the `OPENAI_KEY` environment variable in Railway.

#### 3. Memory Features Not Working
**Solution:** Ensure ChromaDB is properly connected and the health check shows `"status": "active"`.

### Debug Commands:

#### Check Environment Variables:
```bash
railway run env
```

#### View Logs:
```bash
railway logs
```

#### Connect to Service:
```bash
railway shell
```

## Production Considerations

### 1. Scaling
- ChromaDB can handle multiple concurrent connections
- Consider using a managed ChromaDB service for production
- Monitor memory usage and database size

### 2. Security
- Use strong API keys
- Enable HTTPS (Railway provides this automatically)
- Consider rate limiting for production use

### 3. Monitoring
- Set up monitoring for ChromaDB connection
- Monitor OpenAI API usage and costs
- Track memory storage growth

### 4. Backup
- ChromaDB data is persistent in Railway
- Consider regular backups for production data
- Export memories periodically if needed

## Support

If you encounter issues:
1. Check the Railway deployment logs
2. Verify all environment variables are set
3. Test ChromaDB connection independently
4. Check the health endpoint for system status

## Example Railway Configuration

```yaml
# railway.json (optional)
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node server.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 100,
    "restartPolicyType": "ON_FAILURE"
  }
}
```

This configuration ensures:
- Automatic builds using Nixpacks
- Health checks on the `/health` endpoint
- Automatic restarts on failure
- Proper startup command
