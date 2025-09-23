#!/usr/bin/env node

/**
 * Test script for webhook performance
 * Usage: node test-webhook-performance.js [webhook-url]
 */

const axios = require('axios');

const WEBHOOK_URL = process.argv[2] || 'http://localhost:3000/omi-webhook';
const SESSION_ID = `test-session-${Date.now()}`;

// Sample transcript data
const createTestPayload = (segmentCount = 5) => ({
  session_id: SESSION_ID,
  segments: Array.from({ length: segmentCount }, (_, i) => ({
    id: `seg-${i}`,
    text: i === 0 ? 'Hey Omi, what is the weather today?' : `Additional context segment ${i}`,
    speaker: 'User',
    speaker_id: 0,
    is_user: true,
    start: i * 2.0,
    end: (i + 1) * 2.0
  }))
});

async function testWebhookPerformance() {
  console.log('Testing webhook performance...\n');
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
  console.log(`Session ID: ${SESSION_ID}\n`);
  
  const results = [];
  const testCases = [
    { name: 'Small payload (5 segments)', segments: 5 },
    { name: 'Medium payload (20 segments)', segments: 20 },
    { name: 'Large payload (50 segments)', segments: 50 }
  ];
  
  for (const testCase of testCases) {
    console.log(`Testing: ${testCase.name}`);
    
    const payload = createTestPayload(testCase.segments);
    const startTime = Date.now();
    
    try {
      const response = await axios.post(
        `${WEBHOOK_URL}?session_id=${SESSION_ID}`,
        payload,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000 // 60 second timeout
        }
      );
      
      const duration = Date.now() - startTime;
      
      results.push({
        testCase: testCase.name,
        segments: testCase.segments,
        duration: `${duration}ms`,
        status: response.status,
        hasResponse: !!response.data.message
      });
      
      console.log(`✓ Response time: ${duration}ms`);
      console.log(`  Status: ${response.status}`);
      console.log(`  AI Response: ${response.data.message ? 'Yes' : 'No'}\n`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      results.push({
        testCase: testCase.name,
        segments: testCase.segments,
        duration: `${duration}ms`,
        status: error.response?.status || 'ERROR',
        error: error.code || error.message
      });
      
      console.log(`✗ Failed after: ${duration}ms`);
      console.log(`  Error: ${error.code || error.message}\n`);
    }
    
    // Wait between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Check queue status
  console.log('Checking queue status...');
  try {
    const statusResponse = await axios.get(`${WEBHOOK_URL}/queue-status`);
    console.log('Queue Status:', JSON.stringify(statusResponse.data, null, 2));
  } catch (error) {
    console.log('Could not fetch queue status:', error.message);
  }
  
  // Summary
  console.log('\n=== Performance Test Summary ===');
  console.table(results);
  
  const avgDuration = results
    .filter(r => !r.error)
    .map(r => parseInt(r.duration))
    .reduce((a, b, i, arr) => a + b / arr.length, 0);
  
  if (avgDuration) {
    console.log(`\nAverage response time: ${Math.round(avgDuration)}ms`);
    
    if (avgDuration > 30000) {
      console.log('⚠️  WARNING: Response times are still very high (>30s)');
      console.log('   This may cause 499 errors from Omi');
    } else if (avgDuration > 10000) {
      console.log('⚠️  Response times are high (>10s) but should avoid 499 errors');
    } else {
      console.log('✓  Response times are good (<10s)');
    }
  }
}

// Run the test
testWebhookPerformance().catch(console.error);