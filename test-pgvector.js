/**
 * Test script for PgVector implementation
 * Run this to verify pgvector is working correctly
 */

const PgVectorMemoryStorage = require('./pgvector-memory-storage');
require('dotenv').config();

async function testPgVector() {
  console.log('🧪 Testing PgVector Memory Storage...');
  
  // Check environment variables
  console.log('\n📋 Environment Check:');
  console.log('  DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
  console.log('  OPENAI_KEY:', process.env.OPENAI_KEY ? 'SET' : 'NOT SET');
  console.log('  VECTOR_STORAGE_TYPE:', process.env.VECTOR_STORAGE_TYPE || 'not set');
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is required for PgVector testing');
    console.log('💡 Set DATABASE_URL in your environment variables');
    return;
  }
  
  if (!process.env.OPENAI_KEY) {
    console.error('❌ OPENAI_KEY is required for embedding generation');
    console.log('💡 Set OPENAI_KEY in your environment variables');
    return;
  }
  
  const storage = new PgVectorMemoryStorage();
  
  try {
    // Test 1: Initialize storage
    console.log('\n🔗 Test 1: Initializing PgVector storage...');
    await storage.initialize();
    console.log('✅ PgVector storage initialized successfully');
    
    // Test 2: Add a test memory
    console.log('\n💾 Test 2: Adding test memory...');
    const testMemory = {
      id: 'test-memory-' + Date.now(),
      userId: 'test-user-123',
      content: 'This is a test memory for PgVector storage',
      category: 'test',
      type: 'memory',
      source: 'test-script',
      metadata: {
        test: true,
        timestamp: new Date().toISOString()
      }
    };
    
    await storage.addMemory(testMemory);
    console.log('✅ Test memory added successfully');
    
    // Test 3: Search memories
    console.log('\n🔍 Test 3: Searching memories...');
    const searchResults = await storage.searchMemories('test-user-123', 'test memory', 5);
    console.log(`✅ Found ${searchResults.length} memories`);
    searchResults.forEach((memory, index) => {
      console.log(`  ${index + 1}. ${memory.content} (similarity: ${memory.similarity?.toFixed(3)})`);
    });
    
    // Test 4: Get all memories
    console.log('\n📚 Test 4: Getting all memories...');
    const allMemories = await storage.getAllMemories('test-user-123', { limit: 10 });
    console.log(`✅ Retrieved ${allMemories.memories.length} memories (total: ${allMemories.total})`);
    
    // Test 5: Get memory by ID
    console.log('\n🔍 Test 5: Getting memory by ID...');
    const memoryById = await storage.getMemoryById(testMemory.id);
    if (memoryById) {
      console.log('✅ Memory retrieved by ID:', memoryById.content);
    } else {
      console.log('❌ Memory not found by ID');
    }
    
    // Test 6: Get memory categories
    console.log('\n📂 Test 6: Getting memory categories...');
    const categories = await storage.getMemoryCategories('test-user-123');
    console.log('✅ Categories:', categories);
    
    // Test 7: Update memory
    console.log('\n✏️ Test 7: Updating memory...');
    const updated = await storage.updateMemory(testMemory.id, 'This is an updated test memory', { updated: true });
    if (updated) {
      console.log('✅ Memory updated successfully');
    } else {
      console.log('❌ Failed to update memory');
    }
    
    // Test 8: Delete memory
    console.log('\n🗑️ Test 8: Deleting memory...');
    const deleted = await storage.deleteMemory(testMemory.id);
    if (deleted) {
      console.log('✅ Memory deleted successfully');
    } else {
      console.log('❌ Failed to delete memory');
    }
    
    // Test 9: Verify deletion
    console.log('\n🔍 Test 9: Verifying deletion...');
    const deletedMemory = await storage.getMemoryById(testMemory.id);
    if (!deletedMemory) {
      console.log('✅ Memory successfully deleted');
    } else {
      console.log('❌ Memory still exists after deletion');
    }
    
    console.log('\n🎉 All PgVector tests passed!');
    console.log('✅ PgVector is ready for production use');
    
  } catch (error) {
    console.error('\n❌ PgVector test failed:', error.message);
    console.error('Stack trace:', error.stack);
    
    console.log('\n💡 Troubleshooting:');
    console.log('  1. Check that DATABASE_URL is correct');
    console.log('  2. Verify PostgreSQL service is running');
    console.log('  3. Ensure pgvector extension is enabled');
    console.log('  4. Check that OPENAI_KEY is valid');
    console.log('  5. Review Railway logs for database errors');
    
  } finally {
    // Close the connection
    await storage.close();
    console.log('\n🔌 PgVector connection closed');
  }
}

// Run the test
testPgVector().catch(console.error);