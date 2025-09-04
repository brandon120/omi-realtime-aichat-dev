// Test script to verify ChromaDB connection
const { ChromaClient } = require('chromadb');

async function testChromaDB() {
  // Replace this with your actual Railway ChromaDB URL
  const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';
  
  console.log('Testing ChromaDB connection...');
  console.log('ChromaDB URL:', chromaUrl);
  
  try {
    // Test basic connection
    const response = await fetch(`${chromaUrl}/api/v1/heartbeat`);
    console.log('✅ ChromaDB heartbeat response:', response.status);
    
    if (!response.ok) {
      throw new Error(`ChromaDB server responded with status: ${response.status}`);
    }
    
    // Test ChromaDB client
    const chromaClient = new ChromaClient({
      path: chromaUrl
    });
    
    // Test collection creation
    const collection = await chromaClient.getOrCreateCollection({
      name: "test_memories",
      metadata: { description: "Test collection" }
    });
    
    console.log('✅ ChromaDB client connected successfully');
    console.log('✅ Collection created/retrieved:', collection.name);
    
    // Test adding a document
    const testId = 'test-' + Date.now();
    await collection.add({
      ids: [testId],
      documents: ['This is a test document'],
      metadatas: [{ test: true, timestamp: new Date().toISOString() }]
    });
    
    console.log('✅ Test document added successfully');
    
    // Test querying
    const results = await collection.query({
      queryTexts: ['test document'],
      nResults: 1
    });
    
    console.log('✅ Query test successful, found:', results.documents[0].length, 'documents');
    
    console.log('\n🎉 All ChromaDB tests passed! Your setup is working correctly.');
    
  } catch (error) {
    console.error('❌ ChromaDB test failed:', error.message);
    console.log('\nTroubleshooting:');
    console.log('1. Make sure CHROMA_URL is set correctly');
    console.log('2. Verify your Railway ChromaDB service is running');
    console.log('3. Check that the URL is accessible from your network');
  }
}

testChromaDB();
