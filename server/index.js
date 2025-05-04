// index.js - Main Express app for Fly.io deployment
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const Sentry = require('@sentry/node');
const { pool, rateLimiterMiddleware, authMiddleware } = require('./utils');

// Import route modules
const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const draftsRoutes = require('./routes/drafts');
const commentsRoutes = require('./routes/comments');
const newsletterRoutes = require('./routes/newsletter');
const feedsRoutes = require('./routes/feeds');

// Import serverless adapters for SSR pages
const postPage = require('./postPage');
const timelinePage = require('./timelinePage');
const searchPage = require('./searchPage');
const composePage = require('./composePage');
const sitemap = require('./sitemap');

// Create Express app
const app = express();

// Initialize Sentry with just the minimal required options
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: true, 
  environment: process.env.NODE_ENV || 'development'
});

// Basic Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true })); // for HTMX

// CORS middleware
app.use(cors({
  origin: ['https://maxua.com', 'http://localhost:8888', 'http://localhost:3000'],
  credentials: true, // Allow cookies to be sent
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Database connection warm-up
let dbConnected = false;
const checkDatabaseConnection = async () => {
  try {
    if (!dbConnected) {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        console.log('Database connection established');
        dbConnected = true;
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error('Database connection error:', err);
    dbConnected = false;
  }
};

// Call immediately and then set interval
checkDatabaseConnection();
setInterval(checkDatabaseConnection, 60000); // Check every minute

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/welcome.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    dbConnected
  });
});


// Add this test route after your other routes to test Sentry
app.get('/api/debug-sentry', (req, res) => {
  try {
    throw new Error('Testing Sentry integration');
  } catch (error) {
    Sentry.captureException(error);
    res.status(200).json({
      message: 'Sentry test error triggered',
      note: 'Check your Sentry dashboard to confirm this error was captured'
    });
  }
});

// Add this error handler before starting the server
app.use((err, req, res, next) => {
  Sentry.captureException(err);
  console.error('Unhandled error:', err);
  res.status(500).send(`<h1>500 - Server Error</h1><p>${err.message || 'Something went wrong'}</p>`);
});

// Mount the route modules
app.use('/api/auth', authRoutes);
app.use('/api', postsRoutes); // Will handle /publish, /views, /topics 
app.use('/api/comments', commentsRoutes);
app.use('/api/drafts', draftsRoutes);
app.use('/api', newsletterRoutes); // Will handle /subscribe, /confirmSubscription, /unsubscribe
app.use('/', feedsRoutes); // Will handle /rss

// STATIC paths - from Netlify
const path = require('path');

// For specific file types, set longer cache times
app.use('/css', express.static(path.join(__dirname, '../public/css'), {
  //maxAge: '1d'
}));

app.use('/js', express.static(path.join(__dirname, '../public/js'), {
  //maxAge: '1d' 
}));

app.use('/images', express.static(path.join(__dirname, '../public/images'), {
  maxAge: '1y' // Cache images for a year
}));

// Catch-all fallback for other static files (e.g. favicon, robots.txt)
app.use(express.static(path.join(__dirname, '../public')));

// My substack newsletter archive

app.get(['/newsletter_archive/'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/newsletter_archive/index.html'));
});

// Serve static HTML files from public directory
app.get('/:page.html', (req, res, next) => {
  const page = req.params.page;
  const filePath = path.join(__dirname, '../public', `${page}.html`);
  
  // Check if the file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      // File doesn't exist, move to next handler
      return next();
    }
    // File exists, send it
    res.sendFile(filePath);
  });
});

// Special case for root-level admin and other pages
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.get('/test_auth', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/test_auth.html'));
});

// Add routes for any other pages that need direct handling
app.get('/books', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/books.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/about.html'));
});

app.get('/zsu', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/zsu.html'));
});

// Create adapter for SSR page handlers
function createServerlessAdapter(pageHandler) {
  return async (req, res) => {
    try {
      // Create a compatible event object that mimics the serverless function event
      const event = {
        path: req.path,
        httpMethod: req.method,
        headers: req.headers,
        queryStringParameters: req.query,
        body: req.body ? JSON.stringify(req.body) : null,
        // Ensure cookies are properly passed
        cookies: req.cookies || {},
        // Add path parameters from Express
        pathParameters: req.params,
        // Add the original URL (some handlers might use this)
        rawUrl: req.originalUrl
      };
      
      // Call the existing page handler
      const result = await pageHandler.handler(event, {});
      
      // If the handler returns nothing or undefined, handle gracefully
      if (!result) {
        console.error(`Handler returned empty result for ${req.path}`);
        return res.status(500).send('<h1>500 - Server Error</h1><p>No response from handler</p>');
      }
      
      // Handle redirect responses
      if (result.statusCode >= 300 && result.statusCode < 400 && result.headers?.Location) {
        return res.redirect(result.statusCode, result.headers.Location);
      }
      
      // Set status code from the result
      res.status(result.statusCode || 200);
      
      // Set headers from the result
      if (result.headers) {
        Object.entries(result.headers).forEach(([key, value]) => {
          // Skip setting null or undefined headers
          if (value != null) {
            res.set(key, value);
          }
        });
      }
      
      // Send the response body
      if (result.body) {
        res.send(result.body);
      } else {
        // Handle empty body
        res.end();
      }
    } catch (error) {
      console.error(`Error handling ${req.path}:`, error);
      res.status(500).send(`<h1>500 - Server Error</h1><p>${error.message}</p>`);
    }
  };
}

// Set up SSR routes using the adapter
app.get('/search', createServerlessAdapter(searchPage));
app.get('/p/:id', createServerlessAdapter(postPage));
app.get('/', createServerlessAdapter(timelinePage));
app.get('/t/:topic', createServerlessAdapter(timelinePage));
app.get('/compose', createServerlessAdapter(composePage));
app.get('/sitemap.xml', createServerlessAdapter(sitemap));

const translationRoutes = require('./routes/translation');
app.use('/api', translationRoutes);

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
