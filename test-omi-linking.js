#!/usr/bin/env node

// Test script for OMI device linking
const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const SESSION_TOKEN = process.env.SESSION_TOKEN || '';

async function testWithAuth() {
  // Test with authentication (requires session token)
  if (!SESSION_TOKEN) {
    console.log('⚠️  No SESSION_TOKEN provided, testing without auth');
    return false;
  }
  
  console.log('Testing with authentication...');
  
  const omiUserId = 'test-device-' + Date.now();
  
  try {
    // Start linking
    console.log(`\n1. Starting OMI link for device: ${omiUserId}`);
    const startResponse = await axios.post(
      `${API_URL}/link/omi/start`,
      { omi_user_id: omiUserId },
      { headers: { Cookie: `sid=${SESSION_TOKEN}` } }
    );
    
    console.log('✅ Start response:', startResponse.data);
    
    if (startResponse.data.dev_code) {
      console.log(`📝 Dev code received: ${startResponse.data.dev_code}`);
      
      // Confirm linking
      console.log('\n2. Confirming OMI link with code...');
      const confirmResponse = await axios.post(
        `${API_URL}/link/omi/confirm`,
        { 
          omi_user_id: omiUserId,
          code: startResponse.data.dev_code
        },
        { headers: { Cookie: `sid=${SESSION_TOKEN}` } }
      );
      
      console.log('✅ Confirm response:', confirmResponse.data);
      
      // Check user profile
      console.log('\n3. Checking user profile for linked device...');
      const meResponse = await axios.get(
        `${API_URL}/me`,
        { headers: { Cookie: `sid=${SESSION_TOKEN}` } }
      );
      
      if (meResponse.data.omi_links) {
        const linkedDevice = meResponse.data.omi_links.find(l => l.omiUserId === omiUserId);
        if (linkedDevice) {
          console.log('✅ Device found in profile:', linkedDevice);
        } else {
          console.log('❌ Device not found in profile');
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    return false;
  }
}

async function testWithoutAuth() {
  console.log('\nTesting without authentication...');
  
  try {
    // Should fail without auth
    console.log('\n1. Attempting to start link without auth...');
    const response = await axios.post(
      `${API_URL}/link/omi/start`,
      { omi_user_id: 'test-device' }
    );
    console.log('❌ Should have failed but got:', response.data);
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('✅ Correctly rejected without auth (401)');
    } else {
      console.log('❓ Got error:', error.response?.status, error.response?.data);
    }
  }
}

async function testInvalidRequests() {
  if (!SESSION_TOKEN) return;
  
  console.log('\n\nTesting invalid requests...');
  
  // Test missing omi_user_id
  try {
    console.log('\n1. Testing missing omi_user_id...');
    await axios.post(
      `${API_URL}/link/omi/start`,
      {},
      { headers: { Cookie: `sid=${SESSION_TOKEN}` } }
    );
    console.log('❌ Should have failed');
  } catch (error) {
    if (error.response?.status === 400) {
      console.log('✅ Correctly rejected missing omi_user_id');
    } else {
      console.log('❓ Got error:', error.response?.status, error.response?.data);
    }
  }
  
  // Test invalid code
  try {
    console.log('\n2. Testing invalid confirmation code...');
    await axios.post(
      `${API_URL}/link/omi/confirm`,
      { 
        omi_user_id: 'test-device-invalid',
        code: '000000'
      },
      { headers: { Cookie: `sid=${SESSION_TOKEN}` } }
    );
    console.log('❌ Should have failed');
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 400) {
      console.log('✅ Correctly rejected invalid code');
    } else {
      console.log('❓ Got error:', error.response?.status, error.response?.data);
    }
  }
}

async function main() {
  console.log('🔗 OMI Device Linking Test');
  console.log('===========================');
  console.log(`API URL: ${API_URL}`);
  console.log(`Session: ${SESSION_TOKEN ? SESSION_TOKEN.substring(0, 10) + '...' : 'None'}`);
  
  // Test without auth
  await testWithoutAuth();
  
  // Test with auth if token provided
  if (SESSION_TOKEN) {
    await testWithAuth();
    await testInvalidRequests();
  } else {
    console.log('\n📝 To test authenticated endpoints, provide SESSION_TOKEN:');
    console.log('   SESSION_TOKEN=your-token-here node test-omi-linking.js');
    console.log('\n   You can get the token from browser cookies after logging in');
  }
  
  console.log('\n✨ Test completed!');
}

main().catch(console.error);