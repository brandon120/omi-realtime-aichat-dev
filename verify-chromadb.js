// Script to verify ChromaDB setup for Omi AI Chat Plugin
const { ChromaClient } = require('chromadb');

async function verifyChromaDB() {
  const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';
  const chromaAuthToken = process.env.CHROMA_AUTH_TOKEN;
  
  console.log('🔍 Verifying ChromaDB setup...');
  console.log('ChromaDB URL:', chromaUrl);
  console.log('Auth Token:', chromaAuthToken ? 'Set' : 'Not set');
  
  try {
    // Test connection with authentication
    const headers = {};
    if (chromaAuthToken) {
      headers['Authorization'] = `Bearer ${chromaAuthToken}`;
    }
    
    const response = await fetch(`${chromaUrl}/api/v1/heartbeat`, { headers });
    if (!response.ok) {
      throw new Error(`ChromaDB not accessible: ${response.status}`);
    }
    console.log('✅ ChromaDB is accessible');
    
    // Connect to ChromaDB with authentication
    const clientConfig = { path: chromaUrl };
    if (chromaAuthToken) {
      clientConfig.auth = {
        provider: 'token',
        credentials: chromaAuthToken
      };
    }
    
    const chromaClient = new ChromaClient(clientConfig);
    console.log('✅ ChromaDB client connected');
    
    // Check if the collection exists
    try {
      const existingCollection = await chromaClient.getCollection({
        name: "omi_memories"
      });
      console.log('✅ Collection "omi_memories" already exists');
      console.log('📊 Collection metadata:', existingCollection.metadata);
    } catch (error) {
      if (error.message.includes('not found')) {
        console.log('⚠️ Collection "omi_memories" does not exist, will be created automatically');
      } else {
        throw error;
      }
    }
    
    // Create or get the collection with intelligent migration
    const { OpenAIEmbeddingFunction } = require('chromadb');
    
    const embeddingFunction = new OpenAIEmbeddingFunction({
      openai_api_key: process.env.OPENAI_KEY
    });
    
    let collection;
    try {
      // Try to get existing collection first
      collection = await chromaClient.getCollection({
        name: "omi_memories"
      });
      
      // Test if the collection works with embedding function
      try {
        await collection.query({
          queryTexts: ["test"],
          nResults: 1
        });
        console.log('📚 Using existing collection with embedding function');
      } catch (queryError) {
        if (queryError.message.includes('Bad request') || queryError.message.includes('400')) {
          console.log('🔄 Collection needs migration, but skipping for verification test');
          console.log('⚠️ In production, this would migrate the collection with data preservation');
        } else {
          throw queryError;
        }
      }
    } catch (error) {
      if (error.message.includes('not found')) {
        // Collection doesn't exist, create it with embedding function
        collection = await chromaClient.createCollection({
          name: "omi_memories",
          metadata: { description: "Omi AI Chat Plugin Memory Storage" },
          embeddingFunction: embeddingFunction
        });
        console.log('📚 Created new collection with OpenAI embedding function');
      } else {
        throw error;
      }
    }
    
    console.log('✅ Collection "omi_memories" is ready');
    console.log('📊 Collection metadata:', collection.metadata);
    
    // Test adding a sample document
    const testId = 'test-' + Date.now();
    await collection.add({
      ids: [testId],
      documents: ['This is a test memory'],
      metadatas: [{ 
        userId: 'test-user', 
        category: 'test', 
        timestamp: new Date().toISOString(),
        source: 'conversation'
      }]
    });
    console.log('✅ Test document added successfully');
    
    // Test querying
    const results = await collection.query({
      queryTexts: ['test memory'],
      nResults: 1
    });
    console.log('✅ Query test successful, found:', results.documents[0].length, 'documents');
    
    // Clean up test document
    await collection.delete({ ids: [testId] });
    console.log('✅ Test document cleaned up');
    
    console.log('\n🎉 ChromaDB is properly configured for Omi AI Chat Plugin!');
    console.log('✅ Ready for deployment');
    
  } catch (error) {
    console.error('❌ ChromaDB verification failed:', error.message);
    console.log('\nTroubleshooting:');
    console.log('1. Make sure CHROMA_URL is set correctly');
    console.log('2. Verify your ChromaDB service is running');
    console.log('3. Check that the URL is accessible');
    console.log('4. Ensure ChromaDB is properly deployed');
  }
}

verifyChromaDB();
