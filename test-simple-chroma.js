// Simple ChromaDB test without embedding functions
const { ChromaClient } = require('chromadb');

async function testSimpleChroma() {
  const chromaUrl = 'https://chroma-yfcv-production.up.railway.app';
  const authToken = 'of9z4zzy6m9prifjxevg1cfnen73a0jf';
  
  console.log('🔍 Testing simple ChromaDB connection...');
  
  try {
    const clientConfig = { path: chromaUrl };
    if (authToken) {
      clientConfig.auth = {
        provider: 'token',
        credentials: authToken
      };
    }
    
    const chromaClient = new ChromaClient(clientConfig);
    console.log('✅ ChromaDB client created');
    
    // Try to get existing collection
    const collection = await chromaClient.getCollection({
      name: "omi_memories"
    });
    console.log('✅ Collection retrieved:', collection.name);
    
    // Try a simple query without embedding function
    const results = await collection.query({
      queryTexts: ["test"],
      nResults: 1
    });
    console.log('✅ Query successful:', results);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

testSimpleChroma();
