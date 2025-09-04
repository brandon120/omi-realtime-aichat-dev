// Test ChromaDB connection from Railway perspective
const { ChromaClient } = require('chromadb');

async function testRailwayChromaDB() {
  const chromaUrl = 'https://chroma-yfcv-production.up.railway.app';
  const authToken = 'of9z4zzy6m9prifjxevg1cfnen73a0jf';
  
  console.log('🔍 Testing ChromaDB from Railway perspective...');
  console.log('URL:', chromaUrl);
  console.log('Auth Token:', authToken ? 'Set' : 'Not set');
  
  try {
    // Test heartbeat endpoint
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const headers = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    console.log('📡 Testing heartbeat endpoint...');
    const response = await fetch(`${chromaUrl}/api/v1/heartbeat`, {
      signal: controller.signal,
      headers: headers
    });
    clearTimeout(timeoutId);
    
    console.log('📊 Response status:', response.status);
    console.log('📊 Response headers:', Object.fromEntries(response.headers.entries()));
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log('❌ Error response:', errorText);
      throw new Error(`ChromaDB server responded with status: ${response.status}`);
    }
    
    const responseText = await response.text();
    console.log('✅ Heartbeat response:', responseText);
    
    // Test ChromaDB client
    console.log('🔗 Testing ChromaDB client...');
    const clientConfig = { path: chromaUrl };
    if (authToken) {
      clientConfig.auth = {
        provider: 'token',
        credentials: authToken
      };
    }
    
    const chromaClient = new ChromaClient(clientConfig);
    console.log('✅ ChromaDB client created');
    
    // Test collection access
    const collection = await chromaClient.getOrCreateCollection({
      name: "omi_memories",
      metadata: { description: "Omi AI Chat Plugin Memory Storage" }
    });
    console.log('✅ Collection ready:', collection.name);
    
    console.log('🎉 All tests passed! ChromaDB is accessible from Railway.');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

testRailwayChromaDB();
