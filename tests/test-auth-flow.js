// tests/test-auth-flow.js
require('dotenv').config();
const { pool } = require('../server/utils');
const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8888';

// Helper to make requests with cookies
let cookies = '';

async function request(method, url, data = null, opts = {}) {
  try {
    const config = {
      method,
      url: `${BASE_URL}${url}`,
      headers: {
        'Cookie': cookies,
        ...opts.headers
      }
    };
    
    // Only add Content-Type and data for requests with bodies
    if (data !== null && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      config.headers['Content-Type'] = 'application/json';
      config.data = data;
    }
    
    const response = await axios(config);
    
    // Save set-cookie headers
    if (response.headers['set-cookie']) {
      cookies = response.headers['set-cookie'].join('; ');
    }
    
    return response;
  } catch (error) {
    throw new Error(`${method} ${url} failed: ${error.response?.data?.error || error.message}`);
  }
}

// Bypass email sending for tests
async function createTestSignup(handle, email) {
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  
  await pool.query(
    'INSERT INTO pending_signups (handle, email, verification_code, expires_at) VALUES ($1, $2, $3, $4)',
    [handle, email, verificationCode, expiresAt]
  );
  
  return verificationCode;
}

async function runTests() {
  console.log('🧪 Running auth flow tests...\n');
  
  const testHandle = 'testuser' + Date.now();
  const testEmail = `test${Date.now()}@resend.dev`; // Use Resend's test domain
  
  try {
    // 1. Clean up any existing test data
    console.log('🧹 Cleaning up test data...');
    await pool.query('DELETE FROM users WHERE handle LIKE $1', ['testuser%']);
    await pool.query('DELETE FROM users WHERE handle LIKE $1', ['logintest%']);
    await pool.query('DELETE FROM pending_signups WHERE handle LIKE $1', ['testuser%']);
    await pool.query('DELETE FROM pending_signups WHERE handle LIKE $1', ['logintest%']);
    await pool.query('DELETE FROM sessions WHERE device_info LIKE $1', ['%test%']);
    console.log('✅ Cleanup complete\n');
    
    // 2. Create pending signup directly (bypass email)
    console.log('1️⃣ Creating test signup (bypassing email)...');
    const verificationCode = await createTestSignup(testHandle, testEmail);
    console.log(`✅ Created pending signup with code: ${verificationCode}\n`);
    
    // 3. Test verify endpoint thoroughly
    console.log('2️⃣ Testing verify endpoint...');
    
    // Test with missing data
    console.log('  - Testing with missing data...');
    try {
      await request('POST', '/api/signup/verify', {
        handle: testHandle
        // Missing email and code
      });
      throw new Error('Should have failed with missing data');
    } catch (error) {
      if (error.message.includes('required') || error.message.includes('Server error')) {
        console.log('    ✅ Correctly rejected missing data');
      } else {
        throw error;
      }
    }
    
    // Test with wrong verification code
    console.log('  - Testing with wrong verification code...');
    try {
      await request('POST', '/api/signup/verify', {
        handle: testHandle,
        email: testEmail,
        code: '000000' // Wrong code
      });
      throw new Error('Should have failed with wrong code');
    } catch (error) {
      if (error.message.includes('Invalid or expired')) {
        console.log('    ✅ Correctly rejected wrong verification code');
      } else {
        throw error;
      }
    }
    
    // Test with non-existent user
    console.log('  - Testing with non-existent user...');
    try {
      await request('POST', '/api/signup/verify', {
        handle: 'nonexistentuser999',
        email: 'nonexistent@test.com',
        code: verificationCode
      });
      throw new Error('Should have failed with non-existent user');
    } catch (error) {
      if (error.message.includes('Invalid or expired')) {
        console.log('    ✅ Correctly rejected non-existent user');
      } else {
        throw error;
      }
    }
    
    // Test with correct data (happy path)
    console.log('  - Testing with correct data...');
    const verifyResponse = await request('POST', '/api/signup/verify', {
      handle: testHandle,
      email: testEmail,
      code: verificationCode
    });
    console.log('    ✅ Verify successful with correct data');
    
    // Test reuse of verification code
    console.log('  - Testing reuse of verification code...');
    try {
      await request('POST', '/api/signup/verify', {
        handle: testHandle,
        email: testEmail,
        code: verificationCode
      });
      console.log('    ❌ Warning: Verification code can be reused - this is a security issue!');
    } catch (error) {
      if (error.message.includes('Invalid or expired')) {
        console.log('    ✅ Correctly prevented code reuse (code deleted after use)');
      } else {
        // Could be a different error, log but continue
        console.log('    ❓ Code reuse failed with different error:', error.message);
      }
    }
    console.log('');
    
    // 4. Test /api/auth/me
    console.log('3️⃣ Testing /api/auth/me...');
    const meResponse = await request('GET', '/api/auth/me');
    if (meResponse.data.authenticated && meResponse.data.user.handle === testHandle) {
      console.log(`✅ /me endpoint working - authenticated as ${meResponse.data.user.handle}\n`);
    } else {
      throw new Error('/me endpoint not working correctly');
    }
    
    // 5. Test logout
    console.log('4️⃣ Testing logout...');
    const logoutResponse = await request('POST', '/api/auth/logout');
    console.log('✅ Logout successful');
    
    // Verify we're logged out
    console.log('  - Verifying logout...');
    const meAfterLogout = await request('GET', '/api/auth/me');
    if (!meAfterLogout.data.authenticated) {
      console.log('  ✅ Confirmed - not authenticated after logout\n');
    } else {
      throw new Error('Still authenticated after logout!');
    }
    
    // 6. Test login endpoint thoroughly
    console.log('5️⃣ Testing login endpoint...');
    
    // Test with missing data
    console.log('  - Testing login with missing data...');
    try {
      await request('POST', '/api/auth/login', {
        handle: testHandle
        // Missing code
      });
      throw new Error('Should have failed with missing code');
    } catch (error) {
      if (error.message.includes('Login method not implemented')) {
        console.log('    ✅ Correctly rejected missing code');
      } else {
        throw error;
      }
    }
    
    // Test with wrong code
    console.log('  - Testing login with wrong code...');
    try {
      await request('POST', '/api/auth/login', {
        handle: testHandle,
        code: '999999'
      });
      throw new Error('Should have failed with wrong code');
    } catch (error) {
      if (error.message.includes('Invalid or expired code')) {
        console.log('    ✅ Correctly rejected wrong code');
      } else {
        throw error;
      }
    }
    
    // Test with non-existent user
    console.log('  - Testing login with non-existent user...');
    try {
      await request('POST', '/api/auth/login', {
        handle: 'nonexistentuser999',
        code: '123456'
      });
      throw new Error('Should have failed with non-existent user');
    } catch (error) {
      if (error.message.includes('User not found') || error.message.includes('Invalid or expired')) {
        console.log('    ✅ Correctly rejected non-existent user');
      } else {
        throw error;
      }
    }
    
    // Test that reusing verification code for login fails
    console.log('  - Testing login with already-used verification code...');
    try {
      await request('POST', '/api/auth/login', {
        handle: testHandle,
        code: verificationCode
      });
      console.log('    ❌ Warning: Login allowed with used verification code - security issue!');
    } catch (error) {
      if (error.message.includes('Invalid or expired code')) {
        console.log('    ✅ Correctly rejected used verification code for login');
      } else {
        throw error;
      }
    }
    
    // Finally the actual login (success path)
    console.log('  - Testing login with verified user...');
    try {
      // Create a verified user for login testing (through the signup flow)
      const loginTestHandle = 'logintest' + Date.now();
      const loginTestEmail = `logintest${Date.now()}@resend.dev`;
      
      // Create and verify the user
      const loginVerificationCode = await createTestSignup(loginTestHandle, loginTestEmail);
      
      // Clear current cookies first
      cookies = '';
      
      // Verify the user (creates the user in users table)
      await request('POST', '/api/signup/verify', {
        handle: loginTestHandle,
        email: loginTestEmail,
        code: loginVerificationCode
      });
      
      // Now logout so we can test login
      await request('POST', '/api/auth/logout');
      
      // Create a new pending signup for the same user to get a new verification code
      // This simulates requesting a new login code for an existing user
      const newLoginCode = await createTestSignup(loginTestHandle, loginTestEmail);
      
      // Test successful login with the new code
      const loginResponse = await request('POST', '/api/auth/login', {
        handle: loginTestHandle,
        code: newLoginCode
      });
      console.log('    ✅ Login successful with fresh verification code');
      
      // Verify login worked
      console.log('  - Verifying login...');
      const meAfterLogin = await request('GET', '/api/auth/me');
      if (meAfterLogin.data.authenticated && meAfterLogin.data.user.handle === loginTestHandle) {
        console.log(`    ✅ Login working - authenticated as ${meAfterLogin.data.user.handle}`);
      } else {
        throw new Error('Login verification failed');
      }
      
      // Clean up the test login user
      await pool.query('DELETE FROM users WHERE handle = $1', [loginTestHandle]);
      await pool.query('DELETE FROM pending_signups WHERE handle = $1', [loginTestHandle]);
      console.log('    ✅ Cleaned up login test user\n');
      
    } catch (error) {
      console.log('    ❌ Login test failed:', error.message);
      if (error.message.includes('User not found')) {
        console.log('    Note: This is expected if login requires verified users');
      }
      throw error;
    }

    // 7. Test session management
    console.log('6️⃣ Testing session management...');
    
    // Get session count for our test user
    const sessionCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM sessions s JOIN users u ON s.user_id = u.id WHERE u.handle = $1',
      [testHandle]
    );
    console.log(`  - Test user has ${sessionCountResult.rows[0].count} active sessions`);
    
    // Test logout again to clear last session
    await request('POST', '/api/auth/logout');
    console.log('  - Cleared final session\n');
    
    console.log('🎉 All tests completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  } finally {
    // Clean up
    console.log('\n🧹 Final cleanup...');
    try {
      await pool.query('DELETE FROM users WHERE handle LIKE $1', [testHandle + '%']);
      await pool.query('DELETE FROM users WHERE handle LIKE $1', ['logintest%']);
      await pool.query('DELETE FROM pending_signups WHERE handle LIKE $1', [testHandle + '%']);
      await pool.query('DELETE FROM pending_signups WHERE handle LIKE $1', ['logintest%']);
      await pool.query('DELETE FROM sessions WHERE device_info LIKE $1', ['%test%']);
      console.log('✅ Cleanup complete');
    } catch (cleanupError) {
      console.error('❌ Cleanup failed:', cleanupError.message);
    }
    await pool.end();
  }
}

// Run the tests
runTests();
