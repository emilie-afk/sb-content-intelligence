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

    // ── 2. Create published_videos row in Supabase ───────────────────────
    // This is the source of truth for the Published Results page.
    // Metrics (views/likes etc.) are filled in later by the daily sync.
    let publishedVideoId = null;
    try {
      // Look up brief_id from opportunity (for script linking below)
      let briefId = null;
      if (opportunityId) {
        const { data: opp } = await supabase
          .from('opportunities')
          .select('brief_id')
          .eq('id', opportunityId)
          .single();
        briefId = opp?.brief_id || null;
      }

      const { data: pubVideo, error: pubErr } = await supabase
        .from('published_videos')
        .insert({
          video_url:        postUrl,
          platform:         platform  || null,
          topic:            topic     || null,
          publish_datetime: publishedOn
            ? new Date(publishedOn + 'T00:00:00').toISOString()
            : new Date().toISOString(),
          cluster_id:       clusterId || null,
          brief_id:         briefId   || null,
        })
        .select('id')
        .single();

      if (pubErr) {
        console.warn('published_videos insert failed:', pubErr.message);
        errors.push('DB insert: ' + pubErr.message);
      } else {
        publishedVideoId = pubVideo?.id || null;
      }
    } catch (insertErr) {
      console.warn('published_videos insert error:', insertErr.message);
      errors.push('DB insert: ' + insertErr.message);
    }

    // ── 3. Auto-link script to published_videos ───────────────────────────
    // Walk opportunity → brief → script_outputs to find the script used.
    if (publishedVideoId && opportunityId) {
      try {
        const { data: opp } = await supabase
          .from('opportunities')
          .select('brief_id')
          .eq('id', opportunityId)
          .single();

        if (opp?.brief_id) {
          const { data: scripts } = await supabase
            .from('script_outputs')
            .select('id')
            .eq('brief_id', opp.brief_id)
            .in('review_status', ['Approved', 'Used in production', 'Draft'])
            .order('updated_at', { ascending: false })
            .limit(1);

          if (scripts?.[0]) {
            const linkedScriptId = scripts[0].id;

            await supabase.from('script_outputs').update({
              review_status: 'Used in production',
            }).eq('id', linkedScriptId);

            await supabase.from('published_videos').update({
              script_output_id: linkedScriptId,
            }).eq('id', publishedVideoId);
          }
        }
      } catch (linkErr) {
        console.warn('Script link failed (non-fatal):', linkErr.message);
      }
    }

    // ── 5. Mark opportunity as Published + close cluster ─────────────────
    if (opportunityId || clusterId) {
      try {
        if (opportunityId) {
          await supabase.from('opportunities').update({
            reviewer_decision: 'Published',
            reviewed_at:       new Date().toISOString(),
          }).eq('id', opportunityId);
        }

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
