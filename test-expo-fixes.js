#!/usr/bin/env node

const axios = require('axios');

const API_URL = process.env.API_URL || 'https://omi-realtime-aichat-dev-production.up.railway.app';
const TEST_TOKEN = process.env.TEST_TOKEN || 'test-session-token';

async function testEndpoints() {
  console.log('Testing Expo App Endpoints...\n');
  
  const client = axios.create({
    baseURL: API_URL,
    headers: {
      'Cookie': `sid=${TEST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    validateStatus: () => true // Don't throw on any status
  });
  
  // Test 1: /conversations/current
  console.log('1. Testing /conversations/current...');
  try {
    const res = await client.get('/conversations/current');
    console.log(`   Status: ${res.status}`);
    if (res.status === 200) {
      console.log(`   ✓ Response has 'ok': ${res.data.ok}`);
      console.log(`   ✓ Has conversation: ${!!res.data.conversation}`);
    } else {
      console.log(`   ✗ Error: ${JSON.stringify(res.data)}`);
    }
  } catch (err) {
    console.log(`   ✗ Request failed: ${err.message}`);
  }
  
  // Test 2: /conversations/current/stream (SSE)
  console.log('\n2. Testing /conversations/current/stream (SSE)...');
  try {
    const url = `${API_URL}/conversations/current/stream?sid=${TEST_TOKEN}`;
    console.log(`   URL: ${url}`);
    
    // Just test that we can connect (HEAD request)
    const res = await axios.head(url, {
      validateStatus: () => true,
      headers: {
        'Origin': 'https://omi-dev-aichat.netlify.app'
      }
    });
    console.log(`   Status: ${res.status}`);
    console.log(`   CORS Header: ${res.headers['access-control-allow-origin'] || 'NOT SET'}`);
  } catch (err) {
    console.log(`   ✗ Request failed: ${err.message}`);
  }
  
  // Test 3: /memories/import/omi
  console.log('\n3. Testing /memories/import/omi...');
  try {
    const res = await client.post('/memories/import/omi', {});
    console.log(`   Status: ${res.status}`);
    if (res.status === 400 && res.data.error) {
      console.log(`   ✓ Returns proper error format: ${res.data.error}`);
    } else if (res.status === 200) {
      console.log(`   ✓ Success: imported ${res.data.imported} memories`);
    } else {
      console.log(`   ✗ Unexpected response: ${JSON.stringify(res.data)}`);
    }
  } catch (err) {
    console.log(`   ✗ Request failed: ${err.message}`);
  }
  
  // Test 4: /agent-events
  console.log('\n4. Testing /agent-events...');
  try {
    const res = await client.get('/agent-events?limit=50');
    console.log(`   Status: ${res.status}`);
    if (res.status === 200) {
      console.log(`   ✓ Response has 'ok': ${res.data.ok}`);
      console.log(`   ✓ Has events array: ${Array.isArray(res.data.events)}`);
    } else {
      console.log(`   ✗ Error: ${JSON.stringify(res.data)}`);
    }
  } catch (err) {
    console.log(`   ✗ Request failed: ${err.message}`);
  }
  
  // Test 5: Check health
  console.log('\n5. Testing /health...');
  try {
    const res = await axios.get(`${API_URL}/health`);
    console.log(`   Status: ${res.status}`);
    console.log(`   ✓ Server healthy: ${res.data.status}`);
    console.log(`   ✓ Uptime: ${Math.round(res.data.uptime)}s`);
  } catch (err) {
    console.log(`   ✗ Request failed: ${err.message}`);
  }
  
  console.log('\n✅ Tests complete!');
}

testEndpoints().catch(console.error);