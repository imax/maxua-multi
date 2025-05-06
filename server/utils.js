// functions/utils.js
require('dotenv').config();
const crypto = require('crypto');
const Sentry = require('@sentry/node');
const { Pool } = require('pg');

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10, // Limit max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  
  // Add connection handling
  async onConnect(client) {
    // Set session parameters once per connection to optimize common operations
    await client.query('SET statement_timeout = 5000') // 5 second query timeout
  },
  
  // Log connection issues for debugging
  onError: (err, client) => {
    console.error('Unexpected error on idle client', err)
  }
});

const authMiddleware = async (req, res, next) => {
  try {
    const sessionId = req.cookies?.session;
    
    if (!sessionId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const result = await pool.query(
      'SELECT user_id FROM sessions WHERE id = $1 AND expires_at > NOW()',
      [sessionId]
    );
    
    if (!result.rows[0]) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired' });
    }
    
    req.userId = result.rows[0].user_id;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Auth error' });
  }
};

// server/utils.js - add session creation function
const { v4: uuidv4 } = require('uuid');

/**
 * Create a session for a user and set the cookie
 * @param {number} userId - The user ID
 * @param {Response} res - The Express response object
 * @param {string} deviceInfo - Information about the device
 * @returns {Promise<string>} The session ID
 */
async function createSession(userId, res, deviceInfo = 'Unknown device') {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 365 days
  
  // Insert session into database
  await pool.query(
    'INSERT INTO sessions (id, user_id, expires_at, device_info) VALUES ($1, $2, $3, $4)',
    [sessionId, userId, expiresAt, deviceInfo]
  );
  
  // Set HttpOnly cookie
  res.cookie('session', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    expires: expiresAt,
    sameSite: 'lax',
    path: '/'
  });
  
  return sessionId;
}

const rateLimits = new Map();

function rateLimit(key, limit = 5, windowMs = 60000) {
  const now = Date.now();
  const bucket = rateLimits.get(key) || [];
  const recent = bucket.filter(ts => now - ts < windowMs);

  if (recent.length >= limit) return false;

  recent.push(now);
  rateLimits.set(key, recent);
  return true;
}

const rateLimiterMiddleware = (req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  const key = `express-api:${ip}`;
  
  if (!rateLimit(key, 20, 60000)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  
  next();
};

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
}

/**
 * Compute a content hash based on data for ETag generation
 * @param {Object|Array} data - Data to generate hash from
 * @returns {string} - Hash string
 */
function computeContentHash(data) {
  // For posts/timelines, we care about IDs and timestamps
  let hashSource = '';
  
  if (Array.isArray(data)) {
    // For collections (like posts in timeline)
    hashSource = data.map(item => 
      `${item.id}:${new Date(item.created_at).getTime()}`
    ).join('|');
  } else if (data && data.id) {
    // For single items (like a post)
    hashSource = `${data.id}:${new Date(data.created_at).getTime()}`;
  } else {
    // Fallback for other data types
    hashSource = JSON.stringify(data);
  }
  
  // Create an MD5 hash (fast and sufficient for caching)
  return crypto.createHash('md5').update(hashSource).digest('hex');
}

/**
 * Get optimized cache headers based on content
 * @param {Object|Array} data - Data to generate ETag from
 * @returns {Object} - Cache headers
 */

function getETagHeaders(data = {}) {
  const contentHash = computeContentHash(data);
  const headers = {
    'Content-Type': 'text/html',
    'ETag': `"${contentHash}"`,
    'Vary': 'Accept-Encoding'
  };
  
  // Add Cache-Control headers -- unless we're in dev mode
  if (!isDevEnvironment()) {
    // XXX we need a better caching strategy
    // headers['Cache-Control'] = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
    headers['Pragma'] = 'no-cache';
  } else {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
    headers['Pragma'] = 'no-cache';
  }
  
  return headers;
}

function wrap(handler) {
  return async (event, context) => {
    const headers = getCorsHeaders();
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    try {
      return await handler(event, context, headers);
    } catch (err) {
      console.error('Unhandled error:', err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message || 'Server error' }),
      };
    }
  };
}

/**
 * Format a date in a clean, concise way
 * @param {string} dateStr - ISO date string
 * @return {string} Formatted date
 */
function formatDate(dateStr) {
  const date = new Date(dateStr);
  
  // 11/4/2025, 16:28:46
  const options = { 
    year: 'numeric', 
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Europe/Kyiv'
  };
  
  return date.toLocaleString('en-GB', options);
}

function escapeHTML(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function linkify(text = '') {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return escapeHTML(text).replace(urlRegex, url => 
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

function getIdFromPath(path, prefix) {
  if (!prefix) throw new Error('Missing prefix for getIdFromPath');
  const match = path.match(new RegExp(`${prefix}(\\d+)`));
  return match ? match[1] : null;
}

function isDevEnvironment() {
  return process.env.CONTEXT === 'dev';
}

/**
 * Safely capture errors with Sentry
 * @param {Error} error - The error to capture
 * @param {Object} contextData - Additional context data
 */
function captureError(error, contextData = {}) {
  try {
    // Add additional context if provided
    if (Object.keys(contextData).length > 0) {
      Sentry.configureScope(scope => {
        Object.entries(contextData).forEach(([key, value]) => {
          scope.setExtra(key, value);
        });
      });
    }
    
    // Capture the error
    Sentry.captureException(error);
    
    // Always log to console as well for local visibility
    console.error(error);
  } catch (sentryError) {
    // Fallback if Sentry capture fails
    console.error('Original error:', error);
    console.error('Error capturing with Sentry:', sentryError);
  }
}

function closePool() {
  return pool.end();
}

async function sendEmail({ to, subject, text, html = null, reply_to = null }) {
  if (!to || !subject || !text) {
    throw new Error('Missing required fields: to, subject or text');
  }

  // Generate better HTML from plain text if not provided
  const generatedHtml = html || formatTextToHtml(text);

  // Build the email payload
  const emailPayload = {
    from: 'Max Ischenko <hello@maxua.com>',
    to,
    subject,
    text,
    html: generatedHtml
  };

  // Add reply_to if provided 
  if (reply_to) {
    emailPayload.replyTo = reply_to;
  }

  const { data, error } = await resend.emails.send(emailPayload);

  if (error) throw new Error(error.message);
  return data.id;
}

/**
 * Convert plain text with newlines to properly formatted HTML
 * @param {string} text - Plain text content
 * @returns {string} - Formatted HTML
 */
function formatTextToHtml(text) {
  if (!text) return '';
  
  // Split by double newlines to identify paragraphs
  const paragraphs = text.split(/\n\s*\n/);
  
  // Convert each paragraph to HTML and join
  return paragraphs
    .map(para => {
      // Skip empty paragraphs
      if (!para.trim()) return '';
      
      // Replace single newlines with <br> tags within paragraphs
      const formattedPara = para.replace(/\n/g, '<br>');
      
      return `<p>${formattedPara}</p>`;
    })
    .filter(Boolean) // Remove empty paragraphs
    .join('\n');
}

/**
 * Create a verification code and send it via email
 * @param {string} handle - User's handle
 * @param {string} email - User's email
 * @param {string} purpose - 'signup' or 'login' to customize the email
 * @returns {Promise<string>} The generated verification code
 */
async function sendOTPEmail(handle, email, purpose = 'signup') {

  console.log("sendOTPEmail", handle, email, purpose);

  // Generate verification code and set expiration (15 minutes)
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  
  // Store in pending_signups
  await pool.query(
    'INSERT INTO pending_signups (handle, email, verification_code, expires_at) VALUES ($1, $2, $3, $4)',
    [handle, email, verificationCode, expiresAt]
  );

  if (process.env.NODE_ENV !== 'production') {
    console.log(`Verification code for ${purpose}: ${handle}, ${email}, ${verificationCode}`);
  }
  
  // Customize email based on purpose
  const title = purpose === 'signup' 
    ? 'Complete your signup for maxua.com'
    : 'Log in to maxua.com';
    
  const subject = purpose === 'signup'
    ? 'Your verification code'
    : 'Your login verification code';
  
  // Send verification email
  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${title}</h2>
      <p>Your verification code is:</p>
      <div style="font-size: 24px; font-weight: bold; padding: 15px; background: #f5f5f5; border-radius: 8px; text-align: center; letter-spacing: 4px;">
        ${verificationCode}
      </div>
      <p style="color: #666; font-size: 14px; margin-top: 20px;">
        This code expires in 15 minutes.<br>
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  `;
  
  await sendEmail({
    to: email,
    subject,
    text: `Your verification code is: ${verificationCode}\n\nThis code expires in 15 minutes.`,
    html: emailHtml
  });
  
  return verificationCode;
}

module.exports = { 
  pool, 
  wrap, 
  sendEmail,
  createSession,
  sendOTPEmail,
  rateLimit,
  getCorsHeaders, 
  getETagHeaders,
  escapeHTML, 
  linkify, 
  formatDate,
  getIdFromPath, 
  isDevEnvironment,
  captureError,
  authMiddleware,
  rateLimiterMiddleware,
  closePool
};
