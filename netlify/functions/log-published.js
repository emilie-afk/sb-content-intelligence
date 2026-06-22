/**
 * Netlify Function: log-published
 *
 * Called when a video is marked as published in the dashboard.
 * Writes a pre-filled row to the Video Tracker Google Sheet
 * and marks the opportunity as Published in Supabase.
 *
 * POST body: { opportunityId, postUrl, platform, publishedOn, topic, format }
 */

const { createClient } = require('@supabase/supabase-js');
const { google }       = require('googleapis');

const SHEET_NAME = 'SB Videos';

// Column positions matching video-tracker-script.gs V object
const V = {
  POST_URL: 1, PLATFORM: 2, PUBLISHED_ON: 3, TOPIC: 4, FORMAT: 5,
  // F–O left blank (metrics + review filled later by team)
  SUBMITTED: 16,
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { opportunityId, postUrl, platform, publishedOn, topic, format } =
      JSON.parse(event.body);

    if (!postUrl) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Post URL is required' }),
      };
    }

    const errors = [];

    // ── 1. Write row to Video Tracker sheet ───────────────────────────────
    const sheetId       = process.env.GOOGLE_VIDEO_TRACKER_ID;
    const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
      : null;

    if (sheetId && serviceAccount) {
      try {
        const auth   = new google.auth.GoogleAuth({
          credentials: serviceAccount,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const row = new Array(16).fill('');
        row[V.POST_URL     - 1] = postUrl    || '';
        row[V.PLATFORM     - 1] = platform   || '';
        row[V.PUBLISHED_ON - 1] = publishedOn || new Date().toISOString().slice(0, 10);
        row[V.TOPIC        - 1] = topic      || '';
        row[V.FORMAT       - 1] = format     || '';
        row[V.SUBMITTED    - 1] = '— add metrics in 5–7 days';

        await sheets.spreadsheets.values.append({
          spreadsheetId:   sheetId,
          range:           `${SHEET_NAME}!A:A`,
          valueInputOption:'USER_ENTERED',
          insertDataOption:'INSERT_ROWS',
          resource:        { values: [row] },
        });
      } catch (sheetErr) {
        console.warn('Sheet write failed:', sheetErr.message);
        errors.push('Sheet: ' + sheetErr.message);
      }
    } else {
      errors.push('GOOGLE_VIDEO_TRACKER_ID or GOOGLE_SERVICE_ACCOUNT_JSON not set');
    }

    // ── 2. Mark opportunity as Published in Supabase ──────────────────────
    if (opportunityId) {
      try {
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY
        );
        await supabase.from('opportunities').update({
          reviewer_decision: 'Published',
          reviewed_at:       new Date().toISOString(),
        }).eq('id', opportunityId);
      } catch (dbErr) {
        console.warn('Supabase update failed:', dbErr.message);
        errors.push('DB: ' + dbErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: errors.length === 0,
        errors:  errors.length ? errors : undefined,
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
