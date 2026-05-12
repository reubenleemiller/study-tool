/* =============================================================
   File: netlify/functions/app-config.js
   Returns runtime configuration for the StudyTool frontend.
   ============================================================= */

'use strict';

exports.handler = async () => {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    APP_NAME,
    DEFAULT_QUIZ_TIME,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Server misconfiguration: missing Supabase env vars.' }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=300',
    },
    body: JSON.stringify({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      appName: APP_NAME || null,
      defaultQuizTime: DEFAULT_QUIZ_TIME || null,
    }),
  };
};
