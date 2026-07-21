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
const { requireUserRole, CORS_HEADERS } = require("./_auth");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SHEET_NAME = 'SB Videos';

// Column positions — 18-column layout:
//   A  Post URL   B  Platform   C  Published On   D  Topic   E  Format
//   F  Day1Views  G  Day2Views  H  Day3Views
//   I  Likes  J  Comments  K  Saves  L  Shares  M  Follows  N  Checked On
//   O  Rating  P  What Worked  Q  Improve  R  Submitted
const V = {
  POST_URL: 1, PLATFORM: 2, PUBLISHED_ON: 3, TOPIC: 4, FORMAT: 5,
  // F–Q left blank (metrics filled by daily scraper, review by team)
  SUBMITTED: 18,
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authError = await requireUserRole(event, supabase, ["admin", "owner", "assistant"]);
  if (authError) return authError;

  try {
    const { opportunityId, clusterId, postUrl, platform, publishedOn, topic, format } =
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

        const row = new Array(18).fill('');
        row[V.POST_URL     - 1] = postUrl    || '';
        row[V.PLATFORM     - 1] = platform   || '';
        row[V.PUBLISHED_ON - 1] = publishedOn || new Date().toISOString().slice(0, 10);
        row[V.TOPIC        - 1] = topic      || '';
        row[V.FORMAT       - 1] = format     || '';
        row[V.SUBMITTED    - 1] = '— metrics auto-synced daily';

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

    // ── 2. Mark opportunity as Published + close cluster in Supabase ──────
    if (opportunityId || clusterId) {
      try {
        if (opportunityId) {
          await supabase.from('opportunities').update({
            reviewer_decision: 'Published',
            reviewed_at:       new Date().toISOString(),
          }).eq('id', opportunityId);
        }

        // Close the source cluster — drops it off Discovery and Today board,
        // and signals the AI learning loop that this topic has been covered.
        if (clusterId) {
          await supabase.from('discovery_clusters').update({
            status:          'Published',
            reviewer_status: 'Published',
          }).eq('id', clusterId);
        }
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
