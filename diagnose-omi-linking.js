#!/usr/bin/env node

// Diagnostic script for OMI linking issues
const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const SESSION_TOKEN = process.env.SESSION_TOKEN || '';

async function diagnose() {
  console.log('🔍 OMI Linking Diagnostic');
  console.log('==========================');
  console.log(`API URL: ${API_URL}`);
  console.log(`Session Token: ${SESSION_TOKEN ? 'Provided' : 'Not provided'}`);
  console.log('');
  
  // Test 1: Check if endpoint exists
  console.log('Test 1: Checking if endpoint exists...');
  try {
    const response = await axios.post(
      `${API_URL}/link/omi/start`,
      {},
      { 
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log(`✅ Endpoint exists - Status: ${response.status}`);
    console.log(`Response:`, response.data);
  } catch (error) {
    console.log('❌ Endpoint not reachable:', error.message);
    return;
  }
  
  // Test 2: Check with empty body
  console.log('\nTest 2: Testing with empty body...');
  try {
    const response = await axios.post(
      `${API_URL}/link/omi/start`,
      {},
      { 
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log(`Status: ${response.status}`);
    console.log(`Response:`, response.data);
    
    if (response.status === 503) {
      console.log('ℹ️  Database not configured - this is expected without DATABASE_URL');
    } else if (response.status === 401) {
      console.log('ℹ️  Authentication required - this is expected without session token');
    } else if (response.status === 400) {
      console.log('ℹ️  Validation error - checking what field is missing...');
    }
  } catch (error) {
    console.log('Error:', error.message);
  }
  
  // Test 3: Check with omi_user_id
  console.log('\nTest 3: Testing with omi_user_id...');
  try {
    const response = await axios.post(
      `${API_URL}/link/omi/start`,
      { omi_user_id: 'test-device-' + Date.now() },
      { 
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log(`Status: ${response.status}`);
    console.log(`Response:`, response.data);
  } catch (error) {
    console.log('Error:', error.message);
  }
  
  // Test 4: Check with authentication if token provided
  if (SESSION_TOKEN) {
    console.log('\nTest 4: Testing with authentication...');
    try {
      const response = await axios.post(
        `${API_URL}/link/omi/start`,
        { omi_user_id: 'test-device-' + Date.now() },
        { 
          validateStatus: () => true,
          headers: { 
            'Content-Type': 'application/json',
            'Cookie': `sid=${SESSION_TOKEN}`
          }
        }
      );
      console.log(`Status: ${response.status}`);
      console.log(`Response:`, response.data);
      
      if (response.status === 200) {
        console.log('✅ Endpoint working correctly with authentication!');
      } else if (response.status === 503) {
        console.log('ℹ️  Database not configured');
      } else if (response.status === 401) {
        console.log('⚠️  Session token might be invalid or expired');
      }
    } catch (error) {
      console.log('Error:', error.message);
    }
    
    // Test 5: Check session validity
    console.log('\nTest 5: Checking session validity...');
    try {
      const response = await axios.get(
        `${API_URL}/me`,
        { 
          validateStatus: () => true,
          headers: { 
            'Cookie': `sid=${SESSION_TOKEN}`
          }
        }
      );
      console.log(`Status: ${response.status}`);
      if (response.status === 200) {
        console.log('✅ Session is valid');
        console.log('User:', response.data.user?.email || response.data.user);
      } else {
        console.log('⚠️  Session check failed:', response.data);
      }
    } catch (error) {
      console.log('Error:', error.message);
    }
  }
  
  // Summary
  console.log('\n📊 Diagnostic Summary');
  console.log('=====================');
  console.log('Possible issues causing 400 error:');
  console.log('1. Missing or invalid omi_user_id in request body');
  console.log('2. Database is configured but has schema issues');
  console.log('3. Rate limiting is blocking requests');
  console.log('4. Request body is not properly formatted JSON');
  console.log('');
  console.log('To fix:');
  console.log('1. Ensure request includes: {"omi_user_id": "your-device-id"}');
  console.log('2. Include authentication token in Cookie or Authorization header');
  console.log('3. If database is configured, check Prisma schema is up to date');
  console.log('4. Check server logs for detailed error messages');
}

diagnose().catch(console.error);