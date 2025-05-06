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

// Check if a handle is available
router.get('/check-handle/:handle', rateLimiterMiddleware, async (req, res) => {
  try {
    const handle = req.params.handle.toLowerCase();
    
    // Check if handle is valid format
    if (!/^[a-z0-9_-]+$/.test(handle)) {
      return res.status(400).json({ 
        error: 'Handle can only contain lowercase letters, numbers, hyphens and underscores' 
      });
    }
    
    // Check if handle is already taken
    const [userCheck, pendingCheck] = await Promise.all([
      pool.query('SELECT 1 FROM users WHERE handle = $1', [handle]),
      pool.query('SELECT 1 FROM pending_signups WHERE handle = $1 AND expires_at > NOW()', [handle])
    ]);
    
    const isAvailable = userCheck.rows.length === 0 && pendingCheck.rows.length === 0;
    
    return res.json({ available: isAvailable });
  } catch (error) {
    console.error('Error checking handle:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Initial signup - send verification code
router.post('/', rateLimiterMiddleware, async (req, res) => {
  try {
    const { handle, email } = req.body;
    
    // Validate input
    if (!handle || !email) {
      return res.status(400).json({ error: 'Handle and email are required' });
    }
    
    const normalizedHandle = handle.toLowerCase();
    
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
    
    // Check if handle or email is already taken
    const [userCheck, pendingCheck] = await Promise.all([
      pool.query('SELECT 1 FROM users WHERE handle = $1 OR email = $2', [normalizedHandle, email]),
      pool.query('SELECT 1 FROM pending_signups WHERE (handle = $1 OR email = $2) AND expires_at > NOW()', [normalizedHandle, email])
    ]);
    
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Handle or email already taken' });
    }
    
    if (pendingCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Verification already in progress for this handle or email' });
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
