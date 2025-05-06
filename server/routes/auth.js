// server/routes/auth.js
const express = require('express');
const router = express.Router();
const { pool, rateLimiterMiddleware } = require('../utils');
const { v4: uuidv4 } = require('uuid');

// Login route - uses the existing signup verification or can be standalone
router.post('/login', rateLimiterMiddleware, async (req, res) => {
  try {
    const { handle, email, code } = req.body;
    
    let userId;
    
    // If code is provided, it's from the signup flow
    if (code) {
      // Check pending signup with code
      const pendingResult = await pool.query(
        'SELECT * FROM pending_signups WHERE (handle = $1 OR email = $2) AND verification_code = $3 AND expires_at > NOW()',
        [handle, email, code]
      );
      
      if (!pendingResult.rows[0]) {
        return res.status(401).json({ error: 'Invalid or expired code' });
      }
      
      // Get the user ID (should exist after verification)
      const userResult = await pool.query(
        'SELECT id FROM users WHERE handle = $1 OR email = $2',
        [handle, email]
      );
      
      if (!userResult.rows[0]) {
        return res.status(401).json({ error: 'User not found' });
      }
      
      userId = userResult.rows[0].id;
    } else {
      // For future: other login methods (email/password, etc.)
      return res.status(400).json({ error: 'Login method not implemented' });
    }
    
    // Create session
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 365 days
    const sessionId = uuidv4();
    
    await pool.query(
      'INSERT INTO sessions (id, user_id, expires_at, device_info) VALUES ($1, $2, $3, $4)',
      [sessionId, userId, expiresAt, req.body.deviceInfo || 'Unknown']
    );
    
    // Set HttpOnly cookie
    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      expires: expiresAt,
      sameSite: 'lax',
      path: '/'
    });
    
    // Get user handle for response
    const userResult = await pool.query(
      'SELECT handle FROM users WHERE id = $1',
      [userId]
    );
    
    return res.json({ 
      success: true, 
      handle: userResult.rows[0].handle 
    });
  } catch (error) {
    console.error('Error in login:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Check auth status
router.get('/me', async (req, res) => {
  try {
    const sessionId = req.cookies?.session;
    
    if (!sessionId) {
      return res.json({ authenticated: false });
    }
    
    const result = await pool.query(
      `SELECT s.user_id, u.handle, u.email 
       FROM sessions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.id = $1 AND s.expires_at > NOW()`,
      [sessionId]
    );
    
    if (!result.rows[0]) {
      res.clearCookie('session');
      return res.json({ authenticated: false });
    }
    
    return res.json({
      authenticated: true,
      user: {
        id: result.rows[0].user_id,
        handle: result.rows[0].handle,
        email: result.rows[0].email
      }
    });
  } catch (error) {
    console.error('Error checking auth:', error);
    return res.status(500).json({ error: 'Auth error' });
  }
});

// Logout route
router.post('/logout', async (req, res) => {
  try {
    const sessionId = req.cookies?.session;
    
    if (sessionId) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    }
    
    res.clearCookie('session');
    return res.json({ success: true });
  } catch (error) {
    console.error('Error in logout:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
