#!/usr/bin/env node

/**
 * Test script to verify the memory search fix
 * This script tests the updated memory search logic with the new thresholds
 */

const { v4: uuidv4 } = require('uuid');

// Updated memory search configuration (matching server.js)
const MEMORY_CONFIG = {
  SIMPLE_QUESTION_THRESHOLD: 20, // characters - reduced from 50
  MEMORY_SEARCH_THRESHOLD: 1 // minimum conversation length - reduced from 3
};

// Mock memory storage
const memoryStorage = new Map();
const conversationHistory = new Map();

// Add test memories
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
    },
    {
      id: uuidv4(),
      userId: 'test-user',
      content: 'I live in New York City',
      category: 'personal',
      timestamp: new Date().toISOString()
    }
  ];
  
  memoryStorage.set('test-user', testMemories);
  console.log('✅ Added test memories:', testMemories.length);
}

// Simulate the updated memory search logic
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
    .map(({ score, ...memory }) => memory);
}

// Test the updated memory search trigger logic
function testMemorySearchTrigger(question, historyLength = 0) {
  console.log(`\n🔍 Testing: "${question}"`);
  console.log(`📊 History length: ${historyLength}`);
  
  const questionLower = question.toLowerCase();
  const isSimpleQuestion = question.length < MEMORY_CONFIG.SIMPLE_QUESTION_THRESHOLD;
  const hasSubstantialHistory = historyLength > MEMORY_CONFIG.MEMORY_SEARCH_THRESHOLD;
  
  console.log(`📏 Question length: ${question.length} (threshold: ${MEMORY_CONFIG.SIMPLE_QUESTION_THRESHOLD})`);
  console.log(`📚 Is simple question: ${isSimpleQuestion}`);
  console.log(`📈 Has substantial history: ${hasSubstantialHistory}`);
  
  // Updated smart context detection - more inclusive
  const needsMemoryContext = (
    // Always search if question contains memory-related keywords (regardless of length)
    questionLower.includes('remember') || 
    questionLower.includes('what did') ||
    questionLower.includes('tell me about') ||
    questionLower.includes('do you know') ||
    questionLower.includes('my') ||
    questionLower.includes('i') ||
    questionLower.includes('you know') ||
    questionLower.includes('recall') ||
    questionLower.includes('remind') ||
    // Or if it's not a simple question and has some history
    (!isSimpleQuestion && hasSubstantialHistory) ||
    // Or if it's a personal question (contains personal pronouns)
    (!isSimpleQuestion && (questionLower.includes('my ') || questionLower.includes('i ')))
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
    if (isSimpleQuestion && !questionLower.includes('remember') && 
        !questionLower.includes('what did') &&
        !questionLower.includes('tell me about') &&
        !questionLower.includes('do you know') &&
        !questionLower.includes('my') &&
        !questionLower.includes('i') &&
        !questionLower.includes('you know') &&
        !questionLower.includes('recall') &&
        !questionLower.includes('remind')) {
      console.log('   - Question is too short and no memory keywords');
    }
    if (!hasSubstantialHistory && !questionLower.includes('my ') && !questionLower.includes('i ')) {
      console.log('   - No conversation history and no personal pronouns');
    }
  }
  
  return needsMemoryContext;
}

// Test cases
function runTests() {
  console.log('🧪 Testing Updated Memory Search Functionality');
  console.log('==============================================');
  console.log(`📊 New thresholds: ${MEMORY_CONFIG.SIMPLE_QUESTION_THRESHOLD} chars, ${MEMORY_CONFIG.MEMORY_SEARCH_THRESHOLD} history`);
  
  // Add test memories
  addTestMemories();
  
  // Test cases that should now work
  const testCases = [
    { question: "What do I like to eat?", historyLength: 0, expected: true },
    { question: "Remember my favorite food", historyLength: 0, expected: true },
    { question: "What did I say about programming?", historyLength: 0, expected: true },
    { question: "Tell me about my preferences", historyLength: 0, expected: true },
    { question: "Do you know what I like?", historyLength: 0, expected: true },
    { question: "My favorite things", historyLength: 0, expected: true },
    { question: "I need help with my work", historyLength: 0, expected: true },
    { question: "You know my schedule", historyLength: 0, expected: true },
    { question: "Recall my preferences", historyLength: 0, expected: true },
    { question: "Remind me about my meeting", historyLength: 0, expected: true },
    { question: "What's the weather?", historyLength: 0, expected: false },
    { question: "Short", historyLength: 0, expected: false },
    { question: "What do I like to eat?", historyLength: 2, expected: true },
    { question: "Help me", historyLength: 2, expected: true },
    { question: "I like programming", historyLength: 0, expected: true },
    { question: "My city is great", historyLength: 0, expected: true },
  ];
  
  let passed = 0;
  let total = testCases.length;
  
  testCases.forEach((testCase, index) => {
    const result = testMemorySearchTrigger(testCase.question, testCase.historyLength);
    const success = result === testCase.expected;
    if (success) {
      passed++;
      console.log(`✅ Test ${index + 1} PASSED`);
    } else {
      console.log(`❌ Test ${index + 1} FAILED - Expected: ${testCase.expected}, Got: ${result}`);
    }
  });
  
  console.log('\n📋 Test Results');
  console.log('================');
  console.log(`✅ Passed: ${passed}/${total} tests`);
  console.log(`📊 Success rate: ${Math.round((passed/total) * 100)}%`);
  
  if (passed === total) {
    console.log('🎉 All tests passed! Memory search fix is working correctly.');
  } else {
    console.log('⚠️ Some tests failed. Review the logic.');
  }
  
  console.log('\n🔧 Key Improvements Made:');
  console.log('1. Reduced character threshold from 50 to 20');
  console.log('2. Reduced history threshold from 3 to 1');
  console.log('3. Added more memory-related keywords');
  console.log('4. Made keyword detection work regardless of question length');
  console.log('5. Added personal pronoun detection for longer questions');
}

// Run the tests
runTests();