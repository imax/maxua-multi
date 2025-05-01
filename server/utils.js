// functions/utils.js
require('dotenv').config();
const crypto = require('crypto');
const Sentry = require('@sentry/node');
const { Pool } = require('pg');

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
    // Check for development environment bypass
    const isDevEnvironment = process.env.CONTEXT === 'dev' || 
                           (req.headers.host && (req.headers.host.includes('localhost') || 
                                               req.headers.host.includes('127.0.0.1')));
    
    if (isDevEnvironment && req.headers['x-dev-bypass'] === 'true') {
      return next();
    }
    
    // Get session ID from cookie or query parameter
    const sessionId = req.cookies?.auth_token || req.query.sessionId;
    
    if (!sessionId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Check session validity
    const result = await pool.query(
      'SELECT id FROM sessions WHERE id = $1 AND expires_at > NOW()',
      [sessionId]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    
    // Authentication successful
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
};

// Add a keep-alive mechanism
setInterval(async () => {
  try {
    const client = await pool.connect()
    try {
      await client.query('SELECT 1') // Keep connection warm
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('Error during keep-alive ping', err)
  }
}, 60000) // Every minute

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

module.exports = { 
  pool, 
  wrap, 
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
