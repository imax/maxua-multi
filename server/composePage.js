// functions/composePage.js
const { pool, getCorsHeaders, getETagHeaders } = require('./utils');
const templateEngine = require('./templateEngine');

/**
 * Handler for the compose page
 */
exports.handler = async (event, context) => {
  try {
    // Get query parameters
    const query = event.queryStringParameters || {};
    const draftId = query.draft || null;
    
    // XXX Check user authentication
    const isUserAuthenticated = true; 
    
    if (!isUserAuthenticated) {
      // Redirect to the home page if not authenticated
      return {
        statusCode: 302,
        headers: {
          'Location': '/',
          'Cache-Control': 'no-cache'
        },
        body: ''
      };
    }
    
    // Fetch topics
    const topics = await fetchTopics();
    
    // Fetch all drafts
    const drafts = await fetchDrafts();
    
    // If a specific draft ID was provided, get its content
    let currentDraft = null;
    if (draftId) {
      currentDraft = await fetchDraft(draftId);
    }
    
    // Prepare template data
    const templateData = {
      topics,
      drafts,
      currentDraft,
      pageTitle: 'Compose - Max Ischenko'
    };
    
    // Render the page
    const html = templateEngine.render('compose', templateData);
    
    return {
      statusCode: 200,
      headers: {
        ...getCorsHeaders(),
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: html
    };
  } catch (error) {
    console.error('Error rendering compose page:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: `<h1>500 - Server Error</h1><p>${error.message}</p>`
    };
  }
};

/**
 * Fetch all available topics
 */
async function fetchTopics() {
  try {
    const result = await pool.query(`
      SELECT * FROM topics ORDER BY name ASC
    `);
    
    return result.rows;
  } catch (err) {
    console.error('Error fetching topics:', err);
    return [];
  }
}

/**
 * Fetch all drafts
 */
async function fetchDrafts() {
  try {
    const result = await pool.query(`
      SELECT d.*, t.name as topic_name, t.slug as topic_slug
      FROM drafts d
      LEFT JOIN topics t ON d.topic_id = t.id
      ORDER BY d.updated_at DESC
    `);
    
    return result.rows.map(formatDraft);
  } catch (err) {
    console.error('Error fetching drafts:', err);
    return [];
  }
}

/**
 * Fetch a specific draft
 */
async function fetchDraft(draftId) {
  try {
    const result = await pool.query(
      `SELECT d.*, t.name as topic_name, t.slug as topic_slug
       FROM drafts d
       LEFT JOIN topics t ON d.topic_id = t.id
       WHERE d.id = $1`,
      [draftId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return formatDraft(result.rows[0]);
  } catch (err) {
    console.error('Error fetching draft:', err);
    return null;
  }
}

/**
 * Format draft data for the template
 */
function formatDraft(draft) {
  return {
    ...draft,
    previewContent: draft.content.length > 60 
      ? draft.content.substring(0, 60) + '...' 
      : draft.content,
    formattedDate: new Date(draft.updated_at).toLocaleString()
  };
}
