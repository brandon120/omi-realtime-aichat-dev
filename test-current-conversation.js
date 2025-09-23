#!/usr/bin/env node

// Test script for /conversations/current endpoint
const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const SESSION_TOKEN = process.env.SESSION_TOKEN || '';

async function testCurrentConversation() {
  console.log('🔍 Testing /conversations/current endpoint');
  console.log('=========================================');
  console.log(`API URL: ${API_URL}`);
  console.log(`Session Token: ${SESSION_TOKEN ? 'Provided' : 'Not provided'}`);
  console.log('');
  
  if (!SESSION_TOKEN) {
    console.log('❌ No session token provided');
    console.log('Usage: SESSION_TOKEN=your-token node test-current-conversation.js');
    console.log('');
    
    // Test without auth to verify endpoint exists
    try {
      const response = await axios.get(
        `${API_URL}/conversations/current`,
        { validateStatus: () => true }
      );
      
      if (response.status === 401) {
        console.log('✅ Endpoint exists and requires authentication (expected)');
      } else if (response.status === 503) {
        console.log('⚠️  Database not configured');
      } else {
        console.log(`Unexpected response: ${response.status}`, response.data);
      }
    } catch (error) {
      console.error('❌ Endpoint error:', error.message);
    }
    return;
  }
  
  // Test with authentication
  console.log('Testing with authentication...\n');
  
  try {
    const response = await axios.get(
      `${API_URL}/conversations/current`,
      {
        headers: {
          'Cookie': `sid=${SESSION_TOKEN}`
        },
        validateStatus: () => true
      }
    );
    
    console.log(`Response Status: ${response.status}`);
    
    if (response.status === 200) {
      console.log('✅ Success!');
      console.log('Response:', JSON.stringify(response.data, null, 2));
      
      if (response.data.conversation) {
        console.log('\n📝 Current Conversation:');
        console.log(`  ID: ${response.data.conversation.id}`);
        console.log(`  Title: ${response.data.conversation.title || 'No title'}`);
        console.log(`  Created: ${response.data.conversation.createdAt}`);
        console.log(`  Session: ${response.data.sessionId || 'No session'}`);
        
        if (response.data.messages && response.data.messages.length > 0) {
          console.log(`\n💬 Recent Messages (${response.data.messages.length}):`);
          response.data.messages.slice(0, 3).forEach(msg => {
            console.log(`  [${msg.role}]: ${msg.text.substring(0, 50)}...`);
          });
        }
      } else {
        console.log('\n📭 No current conversation found');
        console.log('This could mean:');
        console.log('  1. User has no conversations yet');
        console.log('  2. No OMI sessions linked to this user');
        console.log('  3. Conversations not properly linked to user');
        
        if (response.data.sessionId) {
          console.log(`\nFound session: ${response.data.sessionId}`);
        }
      }
    } else if (response.status === 401) {
      console.log('❌ Authentication failed - session token may be invalid');
    } else if (response.status === 500) {
      console.log('❌ Server error:', response.data);
      if (response.data.stack && response.data.stack.includes('recentSession')) {
        console.log('\n⚠️  The recentSession error should be fixed now.');
        console.log('Make sure the server has been restarted with the latest code.');
      }
    } else {
      console.log('Unexpected response:', response.data);
    }
  } catch (error) {
    console.error('❌ Request failed:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

async function testSessionLinking() {
  if (!SESSION_TOKEN) return;
  
  console.log('\n\n🔗 Testing Session Linking');
  console.log('===========================');
  
  const testSessionId = 'test-session-' + Date.now();
  
  try {
    // Link a test session
    console.log(`Linking session: ${testSessionId}`);
    const linkResponse = await axios.post(
      `${API_URL}/sessions/link`,
      { session_id: testSessionId },
      {
        headers: {
          'Cookie': `sid=${SESSION_TOKEN}`,
          'Content-Type': 'application/json'
        },
        validateStatus: () => true
      }
    );
    
    if (linkResponse.status === 200) {
      console.log('✅ Session linked successfully');
      console.log('Response:', linkResponse.data);
    } else {
      console.log(`❌ Failed to link session: ${linkResponse.status}`);
      console.log('Response:', linkResponse.data);
    }
  } catch (error) {
    console.error('❌ Session linking failed:', error.message);
  }
}

async function main() {
  await testCurrentConversation();
  await testSessionLinking();
  
  console.log('\n✨ Test completed!');
  console.log('\nNext steps:');
  console.log('1. Link your OMI device using /link/omi/start');
  console.log('2. Send messages through /omi-webhook with your session_id');
  console.log('3. Check /conversations/current to see live updates');
}

main().catch(console.error);