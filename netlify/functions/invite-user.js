// =============================================================
// File: netlify/functions/invite-user.js
// StudyTool — Serverless function to invite users via Supabase Admin API.
//
// Environment variables required (set in Netlify UI → Site settings → Environment):
//   SUPABASE_URL              — your project URL
//   SUPABASE_SERVICE_ROLE_KEY — service-role secret (never expose client-side)
// =============================================================

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Validate env vars
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server misconfiguration: missing Supabase env vars.' }),
    };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { email, name = '', redirectTo } = body;
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email is required.' }) };
  }
  if (!redirectTo) {
    return { statusCode: 400, body: JSON.stringify({ error: 'redirectTo is required.' }) };
  }

  // Create admin Supabase client (service role — server-side only)
  const adminSb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Invite user via Supabase Admin API
  const { data, error } = await adminSb.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { full_name: name },
  });

  if (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }

  // Optionally create a profile row so it shows in the users tab immediately
  await adminSb.from('profiles').upsert({
    id:        data.user.id,
    email:     data.user.email,
    full_name: name,
    role:      'student',
  }, { onConflict: 'id' });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Invitation sent successfully.', userId: data.user.id }),
  };
};
