// server/routes/signup.js
const express = require('express');
const router = express.Router();
const { pool, rateLimiterMiddleware, createSession, sendOTPEmail } = require('../utils');

// List of reserved handles that cannot be used by users
const RESERVED_HANDLES = [
  'admin', 'about', 'login', 'logout', 'signup', 
  'compose', 'settings', 'profile', 'discover', 'search',
  'explore', 'dashboard', 'help', 'support',
  'privacy', 'terms', 'reset', 'password', 'blog',
  'tags', 'topic', 'topics', 'post', 'posts',
  'feed', 'sitemap', 'robots', 'static',
  'public', 'assets', 'images'
  // no need to add anything shorter than 4 characters
];

// Initial signup - send verification code
router.post('/', rateLimiterMiddleware, async (req, res) => {
  try {
    const { handle, email } = req.body;
    
    // Validate input
    if (!handle || !email) {
      return res.status(400).json({ error: 'Handle and email are required' });
    }
    
    const normalizedHandle = handle.toLowerCase();

    // Check minimum length
    if (normalizedHandle.length < 4) {
      return res.status(400).json({ error: 'Handle must be at least 4 characters long' });
    }
    
    // Check if handle is valid format
    if (!/^[a-z0-9_-]+$/.test(normalizedHandle)) {
      return res.status(400).json({ 
        error: 'Handle can only contain lowercase letters, numbers, hyphens and underscores' 
      });
    }
    
    // Check if handle is reserved
    if (RESERVED_HANDLES.includes(normalizedHandle)) {
      return res.status(400).json({ error: 'This handle is cannot be used' });
    }
    
    const userCheck = await pool.query(
      'SELECT 1 FROM users WHERE handle = $1 OR email = $2',
      [normalizedHandle, email]
    );

    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Handle or email already taken' });
    }

    const pendingCheck = await pool.query(
      'SELECT 1 FROM pending_signups WHERE (handle = $1 OR email = $2) AND expires_at > NOW()',
      [normalizedHandle, email]
    );
    
    if (pendingCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Verification is already pending' });
    }
    
    await sendOTPEmail(normalizedHandle, email, 'signup');
    
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
