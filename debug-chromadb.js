// Debug ChromaDB connection with detailed logging
const { ChromaClient } = require('chromadb');

async function debugChromaDB() {
  const chromaUrl = process.env.CHROMA_URL || 'https://chroma-yfcv-production.up.railway.app';
  const authToken = process.env.CHROMA_AUTH_TOKEN || 'of9z4zzy6m9prifjxevg1cfnen73a0jf';
  
  console.log('🔍 Debugging ChromaDB Connection...');
  console.log('Environment Variables:');
  console.log('  CHROMA_URL:', process.env.CHROMA_URL ? 'SET' : 'NOT SET');
  console.log('  CHROMA_AUTH_TOKEN:', process.env.CHROMA_AUTH_TOKEN ? 'SET' : 'NOT SET');
  console.log('  OPENAI_KEY:', process.env.OPENAI_KEY ? 'SET' : 'NOT SET');
  console.log('');
  
  console.log('Using values:');
  console.log('  URL:', chromaUrl);
  console.log('  Auth Token:', authToken ? 'Present' : 'Missing');
  console.log('');
  
  try {
    // Test 1: Basic connectivity
    console.log('📡 Test 1: Testing basic connectivity...');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
    
    const headers = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    console.log('  Headers:', headers);
    console.log('  Full URL:', `${chromaUrl}/api/v1/heartbeat`);
    
    const response = await fetch(`${chromaUrl}/api/v1/heartbeat`, {
      signal: controller.signal,
      headers: headers,
      method: 'GET'
    });
    clearTimeout(timeoutId);
    
    console.log('  Response Status:', response.status);
    console.log('  Response Headers:', Object.fromEntries(response.headers.entries()));
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log('  Error Response:', errorText);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const responseText = await response.text();
    console.log('  ✅ Heartbeat successful:', responseText);
    console.log('');
    
    // Test 2: ChromaDB Client Creation
    console.log('🔗 Test 2: Creating ChromaDB client...');
    const clientConfig = { path: chromaUrl };
    if (authToken) {
      clientConfig.auth = {
        provider: 'token',
        credentials: authToken
      };
    }
    
    console.log('  Client Config:', JSON.stringify(clientConfig, null, 2));
    
    const chromaClient = new ChromaClient(clientConfig);
    console.log('  ✅ ChromaDB client created successfully');
    console.log('');
    
    // Test 3: Collection Access
    console.log('📚 Test 3: Accessing collection...');
    const collection = await chromaClient.getOrCreateCollection({
      name: "omi_memories",
      metadata: { description: "Omi AI Chat Plugin Memory Storage" }
    });
    console.log('  ✅ Collection ready:', collection.name);
    console.log('  Collection metadata:', collection.metadata);
    console.log('');
    
    // Test 4: Embedding Generation (if OpenAI key is available)
    if (process.env.OPENAI_KEY) {
      console.log('🧠 Test 4: Testing embedding generation...');
      try {
        const { OpenAI } = require('openai');
        const openai = new OpenAI({
          apiKey: process.env.OPENAI_KEY,
        });
        
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: "test embedding"
        });
        
        console.log('  ✅ Embedding generated, dimension:', embeddingResponse.data[0].embedding.length);
      } catch (embeddingError) {
        console.log('  ⚠️ Embedding test failed:', embeddingError.message);
      }
    } else {
      console.log('  ⚠️ Skipping embedding test - OPENAI_KEY not set');
    }
    
    console.log('');
    console.log('🎉 All tests passed! ChromaDB is fully functional.');
    
  } catch (error) {
    console.error('');
    console.error('❌ Debug failed:');
    console.error('  Error Type:', error.constructor.name);
    console.error('  Error Message:', error.message);
    console.error('  Error Code:', error.code);
    console.error('  Error Cause:', error.cause);
    
    if (error.stack) {
      console.error('  Stack Trace:');
      console.error(error.stack);
    }
    
    console.error('');
    console.error('🔧 Troubleshooting suggestions:');
    console.error('  1. Check if CHROMA_URL is correct');
    console.error('  2. Verify CHROMA_AUTH_TOKEN is valid');
    console.error('  3. Ensure ChromaDB service is running on Railway');
    console.error('  4. Check Railway logs for ChromaDB service');
    console.error('  5. Verify network connectivity from your deployment');
  }
}

debugChromaDB();
