#!/usr/bin/env node

// Test script for live chat functionality
const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const SESSION_TOKEN = process.env.SESSION_TOKEN || '';

async function testCurrentConversation() {
  console.log('Testing /conversations/current endpoint...');
  
  try {
    const response = await axios.get(`${API_URL}/conversations/current`, {
      headers: {
        'Cookie': `sid=${SESSION_TOKEN}`
      }
    });
    
    console.log('✅ Current conversation response:', JSON.stringify(response.data, null, 2));
    
    if (response.data.conversation) {
      console.log(`Found active conversation: ${response.data.conversation.id}`);
      console.log(`Messages: ${response.data.messages?.length || 0}`);
    } else {
      console.log('No active conversation found');
    }
    
    return response.data;
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    return null;
  }
}

async function testStreamEndpoint() {
  console.log('\nTesting /conversations/current/stream endpoint...');
  console.log('Listening for live updates (press Ctrl+C to stop)...');
  
  const EventSource = require('eventsource');
  const eventSource = new EventSource(`${API_URL}/conversations/current/stream?sid=${SESSION_TOKEN}`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('📨 Received event:', data);
  };
  
  eventSource.onerror = (error) => {
    console.error('❌ Stream error:', error);
    eventSource.close();
  };
  
  // Keep listening for 30 seconds then close
  setTimeout(() => {
    console.log('Closing stream connection...');
    eventSource.close();
    process.exit(0);
  }, 30000);
}

async function main() {
  if (!SESSION_TOKEN) {
    console.error('Please set SESSION_TOKEN environment variable');
    console.log('You can get this from your browser cookies after logging in');
    process.exit(1);
  }
  
  console.log(`Testing API at: ${API_URL}`);
  console.log(`Using session token: ${SESSION_TOKEN.substring(0, 10)}...`);
  console.log('');
  
  const current = await testCurrentConversation();
  
  if (current) {
    await testStreamEndpoint();
  }
}

// Check if eventsource is installed
try {
  require('eventsource');
} catch (e) {
  console.log('Installing eventsource package for testing...');
  require('child_process').execSync('npm install eventsource', { stdio: 'inherit' });
}

main().catch(console.error);