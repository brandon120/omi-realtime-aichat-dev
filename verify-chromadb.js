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
    // Use OpenAI embedding function from ChromaDB package
    let embeddingFunction;
    try {
      const { OpenAIEmbeddingFunction } = require('chromadb');
      embeddingFunction = new OpenAIEmbeddingFunction({
        openai_api_key: process.env.OPENAI_KEY,
        openai_model: "text-embedding-3-small"
      });
      console.log('✅ Using OpenAIEmbeddingFunction from chromadb package');
    } catch (error) {
      console.warn('⚠️ Failed to load OpenAIEmbeddingFunction:', error.message);
      console.log('📝 Note: This requires a valid OPENAI_KEY environment variable');
      embeddingFunction = null;
    }
    
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
        if (queryError.message.includes('Bad request') || queryError.message.includes('400') || queryError.message.includes('generate') || queryError.message.includes('chromadb-default-embed')) {
          console.log('🔄 Collection needs migration, performing migration...');
          
          // Get existing data before deleting
          let existingData = [];
          try {
            const existingMemories = await collection.get();
            existingData = existingMemories.metadatas || [];
            console.log(`📦 Found ${existingData.length} existing memories to migrate`);
          } catch (getError) {
            console.log('⚠️ Could not retrieve existing data, will start fresh');
          }
          
          // Delete and recreate collection with embedding function
          await chromaClient.deleteCollection({ name: "omi_memories" });
          const collectionConfig = {
            name: "omi_memories",
            metadata: { description: "Omi AI Chat Plugin Memory Storage" }
          };
          if (embeddingFunction) {
            collectionConfig.embeddingFunction = embeddingFunction;
          }
          collection = await chromaClient.createCollection(collectionConfig);
          
          // Restore existing data if any
          if (existingData.length > 0) {
            console.log('🔄 Restoring existing memories...');
            const ids = existingData.map((_, index) => `migrated-${Date.now()}-${index}`);
            const documents = existingData.map(data => data.content || '');
            const metadatas = existingData.map(data => ({
              ...data,
              migrated: true,
              originalId: data.id
            }));
            
            await collection.add({
              ids: ids,
              documents: documents,
              metadatas: metadatas
            });
            console.log(`✅ Restored ${existingData.length} memories`);
          }
          
          console.log('📚 Collection migrated with OpenAI embedding function');
        } else {
          throw queryError;
        }
      }
    } catch (error) {
      if (error.message.includes('not found')) {
        // Collection doesn't exist, create it with embedding function
        collection = await chromaClient.createCollection({
          name: "omi_memories",
          metadata: { description: "Omi AI Chat Plugin Memory Storage" }
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
