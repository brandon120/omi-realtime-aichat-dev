# Railway PgVector Migration Guide

## 🚀 Complete Migration from ChromaDB to PgVector

This guide will help you migrate from ChromaDB to PostgreSQL with pgvector on Railway for better reliability and performance.

## Step 1: Add PostgreSQL to Railway

### 1.1 Add PostgreSQL Service
1. Go to your Railway project dashboard
2. Click **"New Service"**
3. Select **"Database"** → **"PostgreSQL"**
4. Railway will automatically provision a PostgreSQL instance with pgvector extension

### 1.2 Get Database URL
1. Click on the PostgreSQL service
2. Go to **"Variables"** tab
3. Copy the `DATABASE_URL` value (it looks like: `postgresql://user:pass@host:port/db`)

## Step 2: Update Environment Variables

### 2.1 Add to Main Service
Go to your main app service and add these environment variables:

```env
DATABASE_URL=postgresql://user:pass@host:port/db
VECTOR_STORAGE_TYPE=pgvector
```

### 2.2 Optional: Keep ChromaDB as Fallback
If you want to keep ChromaDB as a fallback, also set:
```env
CHROMA_URL=your-chromadb-url
CHROMA_AUTH_TOKEN=your-chromadb-token
```

## Step 3: Deploy the Updated Code

The code has already been updated to support pgvector. Simply:

1. **Commit and push** your changes to your repository
2. **Railway will automatically deploy** the updated code
3. **Monitor the deployment logs** to ensure pgvector initializes correctly

## Step 4: Verify the Migration

### 4.1 Check Health Endpoint
Visit your app's health endpoint:
```
https://your-app.railway.app/health
```

You should see:
```json
{
  "memory_status": {
    "storage_type": "pgvector",
    "pgvector_ready": true,
    "chroma_client": "not_initialized",
    "memories_collection": "not_ready"
  }
}
```

### 4.2 Test Memory Features
1. **Send a test webhook** to `/omi-webhook` with memory content
2. **Check memory stats** at `/memories/USER_ID/stats`
3. **Verify search functionality** works correctly

### 4.3 Run Test Script (Optional)
If you want to run a comprehensive test:

```bash
# Set environment variables
export DATABASE_URL="your-database-url"
export OPENAI_KEY="your-openai-key"

# Run the test
node test-pgvector.js
```

## Step 5: Monitor and Optimize

### 5.1 Check Railway Logs
Monitor your app logs for:
- ✅ `"Memory storage initialized with PgVector"`
- ✅ `"Using PgVector for semantic search"`
- ❌ Any database connection errors

### 5.2 Performance Monitoring
- **Query Performance**: PgVector queries are typically faster than ChromaDB
- **Memory Usage**: Lower memory usage compared to ChromaDB
- **Reliability**: Better uptime and consistency

## Benefits of PgVector Migration

### ✅ **Reliability**
- **99.9%+ uptime** with Railway PostgreSQL
- **ACID compliance** for data consistency
- **Automatic backups** handled by Railway

### ✅ **Performance**
- **Faster queries** with optimized indexes
- **Better scaling** with connection pooling
- **Lower latency** with Railway's network

### ✅ **Cost Efficiency**
- **Lower cost** than external vector services
- **No additional service fees**
- **Better resource utilization**

### ✅ **Developer Experience**
- **Familiar SQL interface** for debugging
- **Easy data inspection** with standard tools
- **Better error messages** and logging

## Troubleshooting

### Common Issues

#### 1. Database Connection Error
```
❌ Failed to initialize PgVector: connection refused
```
**Solution:**
- Check that `DATABASE_URL` is correct
- Verify PostgreSQL service is running in Railway
- Check Railway logs for database service status

#### 2. pgvector Extension Error
```
❌ extension "vector" does not exist
```
**Solution:**
- Railway PostgreSQL includes pgvector by default
- If you're using a custom PostgreSQL, enable the extension:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ```

#### 3. OpenAI API Error
```
❌ Error generating embedding: API key invalid
```
**Solution:**
- Verify `OPENAI_KEY` is set correctly
- Check that the API key has sufficient credits
- Ensure the key has access to embedding models

#### 4. Memory Search Not Working
**Solution:**
- Check that embeddings are being generated
- Verify the search function is using pgvector
- Check Railway logs for search errors

### Debug Commands

#### Check Database Connection
```bash
# Connect to your Railway PostgreSQL
railway connect postgres

# Test pgvector extension
SELECT * FROM pg_extension WHERE extname = 'vector';
```

#### Check Memory Storage
```bash
# View memory table structure
\d omi_memories

# Check memory count
SELECT COUNT(*) FROM omi_memories;

# View recent memories
SELECT id, user_id, content, created_at FROM omi_memories ORDER BY created_at DESC LIMIT 5;
```

## Rollback Plan (If Needed)

If you need to rollback to ChromaDB:

1. **Set environment variables:**
   ```env
   VECTOR_STORAGE_TYPE=chromadb
   CHROMA_URL=your-chromadb-url
   CHROMA_AUTH_TOKEN=your-chromadb-token
   ```

2. **Redeploy** your application

3. **Monitor logs** to ensure ChromaDB initializes

## Support

If you encounter issues:

1. **Check Railway logs** for detailed error messages
2. **Verify environment variables** are set correctly
3. **Test database connection** using Railway CLI
4. **Review the test script** output for specific errors

The pgvector implementation provides a much more reliable and cost-effective solution for vector storage on Railway compared to ChromaDB.