#!/usr/bin/env node

// Test script for conversation state management
const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const SESSION_ID = process.env.SESSION_ID || 'test-session-' + Date.now();

async function sendWebhookRequest(segments, sessionId = SESSION_ID) {
  try {
    const response = await axios.post(`${API_URL}/omi-webhook`, {
      session_id: sessionId,
      segments: segments
    }, {
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
    return null;
  }
}

async function testConversationContinuity() {
  console.log('🧪 Testing Conversation State Management');
  console.log('=========================================');
  console.log(`Session ID: ${SESSION_ID}`);
  console.log(`API URL: ${API_URL}`);
  console.log('');
  
  // Test 1: Initial conversation
  console.log('Test 1: Starting new conversation...');
  const response1 = await sendWebhookRequest([
    {
      text: "Hi Omi, I'm testing the conversation feature. My name is TestUser.",
      is_user: true,
      start: 0,
      end: 5
    }
  ]);
  
  if (response1) {
    console.log('✅ Response 1:', response1.message || 'No message');
    console.log('');
  }
  
  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 2: Follow-up question (should remember context)
  console.log('Test 2: Sending follow-up (should remember context)...');
  const response2 = await sendWebhookRequest([
    {
      text: "What's my name?",
      is_user: true,
      start: 10,
      end: 12
    }
  ]);
  
  if (response2) {
    console.log('✅ Response 2:', response2.message || 'No message');
    const hasContext = response2.message && 
                      (response2.message.includes('TestUser') || 
                       response2.message.toLowerCase().includes('you mentioned') ||
                       response2.message.toLowerCase().includes('you said'));
    console.log(`Context maintained: ${hasContext ? '✅ YES' : '❌ NO'}`);
    console.log('');
  }
  
  // Test 3: Another follow-up
  console.log('Test 3: Another follow-up question...');
  const response3 = await sendWebhookRequest([
    {
      text: "Can you tell me about conversation state management?",
      is_user: true,
      start: 15,
      end: 20
    }
  ]);
  
  if (response3) {
    console.log('✅ Response 3:', response3.message || 'No message');
    console.log('');
  }
  
  // Test 4: New session (should NOT have previous context)
  const newSessionId = 'test-session-' + (Date.now() + 1000);
  console.log(`Test 4: New session (${newSessionId})...`);
  const response4 = await sendWebhookRequest([
    {
      text: "What's my name?",
      is_user: true,
      start: 25,
      end: 27
    }
  ], newSessionId);
  
  if (response4) {
    console.log('✅ Response 4:', response4.message || 'No message');
    const hasNoContext = response4.message && 
                        !response4.message.includes('TestUser') &&
                        (response4.message.toLowerCase().includes("don't know") ||
                         response4.message.toLowerCase().includes("haven't") ||
                         response4.message.toLowerCase().includes("not sure") ||
                         response4.message.toLowerCase().includes("tell me"));
    console.log(`New session has no context: ${hasNoContext ? '✅ YES' : '❌ NO'}`);
    console.log('');
  }
  
  // Summary
  console.log('=========================================');
  console.log('🎯 Test Summary:');
  console.log('- Conversation state management is working if:');
  console.log('  1. Response 2 remembers the name from Response 1');
  console.log('  2. Response 4 (new session) does NOT remember the name');
  console.log('');
  console.log('This ensures conversation continuity within a session');
  console.log('while maintaining privacy between different sessions.');
}

// Performance test
async function testPerformance() {
  console.log('\n📊 Performance Test');
  console.log('===================');
  
  const times = [];
  const sessionId = 'perf-test-' + Date.now();
  
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    const response = await sendWebhookRequest([
      {
        text: `Question ${i + 1}: Tell me a short fact.`,
        is_user: true,
        start: i * 5,
        end: i * 5 + 3
      }
    ], sessionId);
    const duration = Date.now() - start;
    times.push(duration);
    
    console.log(`Request ${i + 1}: ${duration}ms ${response ? '✅' : '❌'}`);
    
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
  const maxTime = Math.max(...times);
  const minTime = Math.min(...times);
  
  console.log('\nPerformance Results:');
  console.log(`Average: ${avgTime.toFixed(0)}ms`);
  console.log(`Min: ${minTime}ms`);
  console.log(`Max: ${maxTime}ms`);
  console.log(`${avgTime < 5000 ? '✅ Good performance' : '⚠️ Consider optimization'}`);
}

async function main() {
  console.log('OpenAI Conversation State Management Test');
  console.log('==========================================\n');
  
  await testConversationContinuity();
  await testPerformance();
  
  console.log('\n✨ Test completed!');
}

main().catch(console.error);