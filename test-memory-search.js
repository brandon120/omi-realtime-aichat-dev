#!/usr/bin/env node

/**
 * Test script to demonstrate memory search functionality
 * This script will help identify why memory search isn't working
 */

const { v4: uuidv4 } = require('uuid');

// Simulate the memory search logic from server.js
const MEMORY_CONFIG = {
  SIMPLE_QUESTION_THRESHOLD: 50, // characters
  MEMORY_SEARCH_THRESHOLD: 3 // minimum conversation length to search memories
};

// Mock memory storage (simulating what happens when PgVector is not available)
const memoryStorage = new Map();
const conversationHistory = new Map();

// Add some test memories
function addTestMemories() {
  const testMemories = [
    {
      id: uuidv4(),
      userId: 'test-user',
      content: 'I like pizza and Italian food',
      category: 'preferences',
      timestamp: new Date().toISOString()
    },
    {
      id: uuidv4(),
      userId: 'test-user',
      content: 'My favorite programming language is JavaScript',
      category: 'work',
      timestamp: new Date().toISOString()
    },
    {
      id: uuidv4(),
      userId: 'test-user',
      content: 'I have a meeting tomorrow at 2 PM',
      category: 'schedule',
      timestamp: new Date().toISOString()
    }
  ];
  
  memoryStorage.set('test-user', testMemories);
  console.log('✅ Added test memories:', testMemories.length);
}

// Simulate the memory search logic
function searchMemoriesLocally(userId, query, limit = 5) {
  const userMemories = memoryStorage.get(userId) || [];
  if (userMemories.length === 0) {
    return [];
  }

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);
  
  // Score memories based on keyword matches
  const scoredMemories = userMemories.map(memory => {
    const contentLower = memory.content.toLowerCase();
    let score = 0;
    
    // Exact phrase match (highest score)
    if (contentLower.includes(queryLower)) {
      score += 10;
    }
    
    // Individual word matches
    queryWords.forEach(word => {
      if (contentLower.includes(word)) {
        score += 1;
      }
    });
    
    // Category match bonus
    if (memory.category && queryLower.includes(memory.category.toLowerCase())) {
      score += 2;
    }
    
    return { ...memory, score };
  });
  
  // Sort by score and return top results
  return scoredMemories
    .filter(memory => memory.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...memory }) => memory); // Remove score from final result
}

// Simulate the memory search trigger logic
function testMemorySearchTrigger(question, historyLength = 0) {
  console.log(`\n🔍 Testing memory search trigger for: "${question}"`);
  console.log(`📊 History length: ${historyLength}`);
  
  const questionLower = question.toLowerCase();
  const isSimpleQuestion = question.length < MEMORY_CONFIG.SIMPLE_QUESTION_THRESHOLD;
  const hasSubstantialHistory = historyLength > MEMORY_CONFIG.MEMORY_SEARCH_THRESHOLD;
  
  console.log(`📏 Question length: ${question.length} (threshold: ${MEMORY_CONFIG.SIMPLE_QUESTION_THRESHOLD})`);
  console.log(`📚 Is simple question: ${isSimpleQuestion}`);
  console.log(`📈 Has substantial history: ${hasSubstantialHistory}`);
  
  // Smart context detection - only search when likely to be beneficial
  const needsMemoryContext = !isSimpleQuestion && (
    questionLower.includes('remember') || 
    questionLower.includes('what did') ||
    questionLower.includes('tell me about') ||
    questionLower.includes('do you know') ||
    questionLower.includes('my') ||
    questionLower.includes('i') ||
    hasSubstantialHistory
  );
  
  console.log(`🧠 Needs memory context: ${needsMemoryContext}`);
  
  if (needsMemoryContext) {
    console.log('✅ Memory search would be triggered');
    const results = searchMemoriesLocally('test-user', question, 3);
    console.log(`🔍 Found ${results.length} relevant memories:`);
    results.forEach((memory, index) => {
      console.log(`  ${index + 1}. ${memory.content} (${memory.category})`);
    });
  } else {
    console.log('❌ Memory search would be skipped');
    console.log('💡 Reasons:');
    if (isSimpleQuestion) console.log('   - Question is too short');
    if (!hasSubstantialHistory) console.log('   - Insufficient conversation history');
    if (!questionLower.includes('remember') && 
        !questionLower.includes('what did') &&
        !questionLower.includes('tell me about') &&
        !questionLower.includes('do you know') &&
        !questionLower.includes('my') &&
        !questionLower.includes('i')) {
      console.log('   - No memory-related keywords detected');
    }
  }
  
  return needsMemoryContext;
}

// Test cases
function runTests() {
  console.log('🧪 Testing Memory Search Functionality');
  console.log('=====================================');
  
  // Add test memories
  addTestMemories();
  
  // Test cases
  const testCases = [
    { question: "What do I like to eat?", historyLength: 0 },
    { question: "Remember my favorite food", historyLength: 0 },
    { question: "What did I say about programming?", historyLength: 0 },
    { question: "Tell me about my preferences", historyLength: 0 },
    { question: "Do you know what I like?", historyLength: 0 },
    { question: "My favorite things", historyLength: 0 },
    { question: "I need help", historyLength: 0 },
    { question: "What's the weather?", historyLength: 0 },
    { question: "Short", historyLength: 0 },
    { question: "What do I like to eat?", historyLength: 5 }, // With history
    { question: "Help me", historyLength: 5 }, // With history
  ];
  
  testCases.forEach((testCase, index) => {
    testMemorySearchTrigger(testCase.question, testCase.historyLength);
  });
  
  console.log('\n📋 Summary');
  console.log('==========');
  console.log('Memory search triggers when:');
  console.log('1. Question is longer than 50 characters AND');
  console.log('2. Contains memory-related keywords OR has substantial conversation history');
  console.log('\nMemory-related keywords:');
  console.log('- remember, what did, tell me about, do you know, my, i');
  console.log('\nTo fix memory search not working:');
  console.log('1. Use longer questions (>50 characters)');
  console.log('2. Include memory-related keywords');
  console.log('3. Have conversation history (>3 messages)');
  console.log('4. Ensure memories are actually saved first');
}

// Run the tests
runTests();