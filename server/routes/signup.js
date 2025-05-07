// server/routes/signup.js
const express = require('express');
const router = express.Router();
const { pool, rateLimiterMiddleware, createSession, sendOTPEmail } = require('../utils');

// List of reserved handles that cannot be used by users
const RESERVED_HANDLES = [
  'admin', 'about', 'login', 'logout', 'signup', 'api', 
  'compose', 'settings', 'profile', 'discover', 'search',
  'explore', 'dashboard', 't', 'p', 'help', 'support',
  'privacy', 'terms', 'tos', 'reset', 'password', 'blog',
  'tag', 'tags', 'topic', 'topics', 'post', 'posts',
  'feed', 'rss', 'xml', 'sitemap', 'robots', 'static',
  'public', 'assets', 'images', 'css', 'js', 'img'
];

/**
 * Validate handle and check availability in one step
 * @param {string} handle - User handle to validate
 * @returns {Promise<Object>} - Either {valid: true, normalizedHandle} or {valid: false, error: 'message'}
 */
async function validateAndCheckHandle(handle) {
  // Step 1: Basic format validation
  if (!handle) {
    return { valid: false, error: 'Handle is required' };
  }
  
  const normalizedHandle = handle.toLowerCase();
  
  // Check minimum length
  if (normalizedHandle.length < 4) {
    return { valid: false, error: 'Handle must be at least 4 characters long' };
  }
  
  // Check if handle is valid format
  if (!/^[a-z0-9_-]+$/.test(normalizedHandle)) {
    return { valid: false, error: 'Handle can only contain lowercase letters, numbers, hyphens and underscores' };
  }
  
  // Check if handle is reserved
  if (RESERVED_HANDLES.includes(normalizedHandle)) {
    return { valid: false, error: 'This handle cannot be used' };
  }
  
  // Step 2: Check availability in database
  try {
    const [userCheck, pendingCheck] = await Promise.all([
      pool.query('SELECT 1 FROM users WHERE handle = $1', [normalizedHandle]),
      pool.query('SELECT 1 FROM pending_signups WHERE handle = $1 AND expires_at > NOW()', [normalizedHandle])
    ]);
    
    if (userCheck.rows.length > 0) {
      return { valid: false, error: 'Handle is already taken' };
    }
    
    if (pendingCheck.rows.length > 0) {
      return { valid: false, error: 'Handle is already pending verification' };
    }
    
    // All checks passed
    return { valid: true, normalizedHandle };
  } catch (error) {
    console.error('Error checking handle availability:', error);
    throw error;
  }
}

/**
 * Check if an email is already registered or pending verification
 * @param {string} email - Email address
 * @returns {Promise<Object>} - Either {valid: true} or {valid: false, error: 'message'}
 */
async function checkEmailAvailability(email) {
  if (!email) {
    return { valid: false, error: 'Email is required' };
  }
  
  try {
    const [userCheck, pendingCheck] = await Promise.all([
      pool.query('SELECT 1 FROM users WHERE email = $1', [email]),
      pool.query('SELECT 1 FROM pending_signups WHERE email = $1 AND expires_at > NOW()', [email])
    ]);
    
    if (userCheck.rows.length > 0) {
      return { valid: false, error: 'Email is already registered' };
    }
    
    if (pendingCheck.rows.length > 0) {
      return { valid: false, error: 'Email is already pending verification' };
    }
    
    return { valid: true };
  } catch (error) {
    console.error('Error checking email availability:', error);
    throw error;
  }
}

// Check if a handle is available
router.get('/check-handle/:handle', rateLimiterMiddleware, async (req, res) => {
  try {
    const handle = req.params.handle;
    
    // Validate handle and check availability in one step
    const validation = await validateAndCheckHandle(handle);
    
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    
    return res.json({ available: true });
  } catch (error) {
    console.error('Error checking handle:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Initial signup - send verification code
router.post('/', rateLimiterMiddleware, async (req, res) => {
  try {
    const { handle, email } = req.body;
    
    // Both handle and email are required
    if (!handle || !email) {
      return res.status(400).json({ error: 'Handle and email are required' });
    }
    
    // Validate handle and check availability in one step
    const handleValidation = await validateAndCheckHandle(handle);
    if (!handleValidation.valid) {
      return res.status(400).json({ error: handleValidation.error });
    }
    
    // Check email availability
    const emailValidation = await checkEmailAvailability(email);
    if (!emailValidation.valid) {
      return res.status(400).json({ error: emailValidation.error });
    }
    
    // Send verification code
    await sendOTPEmail(handleValidation.normalizedHandle, email, 'signup');
    
    return res.json({ 
      success: true, 
      message: 'Verification code sent to your email' 
    });
  } catch (error) {
    console.error('Error in signup:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Verify code and create account
router.post('/verify', rateLimiterMiddleware, async (req, res) => {
  try {
    const { handle, email, code } = req.body;
    
    // Validate input
    if (!handle || !email || !code) {
      return res.status(400).json({ error: 'Handle, email, and verification code are required' });
    }
    
    const normalizedHandle = handle.toLowerCase();
    
    // Find pending user with matching code
    const result = await pool.query(
      'SELECT * FROM pending_signups WHERE handle = $1 AND email = $2 AND verification_code = $3 AND expires_at > NOW()',
      [normalizedHandle, email, code]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }
    
    // Start transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create the user
      await client.query(
        'INSERT INTO users (handle, email) VALUES ($1, $2)',
        [normalizedHandle, email]
      );
      
      // Delete the pending user record
      await client.query(
        'DELETE FROM pending_signups WHERE handle = $1 AND email = $2',
        [normalizedHandle, email]
      );
      
      await client.query('COMMIT');

      const userResult = await pool.query(
        'SELECT id FROM users WHERE handle = $1',
        [normalizedHandle]
      );
      
      const userId = userResult.rows[0].id;
      await createSession(userId, res, 'Signup device');
      
      // Return success with the handle to redirect
      return res.json({ 
        success: true, 
        handle: normalizedHandle 
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error verifying signup:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
