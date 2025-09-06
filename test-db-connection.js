#!/usr/bin/env node

/**
 * Test database connection
 */

require('dotenv').config();
const PgVectorMemoryStorage = require('./pgvector-memory-storage');

async function testDatabaseConnection() {
  console.log('🔗 Testing database connection...');
  console.log('📊 DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT_SET');
  
  try {
    const pgVectorStorage = new PgVectorMemoryStorage();
    await pgVectorStorage.initialize();
    console.log('✅ Database connection successful!');
    
    // Test adding a memory
    console.log('🧪 Testing memory operations...');
    const testMemory = {
      id: 'test-memory-' + Date.now(),
      userId: 'test-user',
      content: 'This is a test memory for database connection',
      category: 'test',
      metadata: { test: true }
    };
    
    await pgVectorStorage.addMemory(testMemory);
    console.log('✅ Memory added successfully!');
    
    // Test searching memories
    const searchResults = await pgVectorStorage.searchMemories('test-user', 'test memory', 5);
    console.log('✅ Memory search successful! Found:', searchResults.length, 'memories');
    
    // Test deleting the memory
    const deleted = await pgVectorStorage.deleteMemory(testMemory.id);
    console.log('✅ Memory deletion successful:', deleted);
    
    await pgVectorStorage.close();
    console.log('✅ Database connection closed successfully!');
    
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.error('📋 Full error:', error);
  }
}

testDatabaseConnection();