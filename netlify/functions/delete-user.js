// =============================================================
// File: netlify/functions/delete-user.js
// StudyTool — Serverless function to delete student accounts.
//
// Environment variables required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// =============================================================

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Server misconfiguration: missing Supabase env vars.' });
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return json(401, { error: 'Missing authorization token.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body.' });
  }

  const userId = String(body.userId || '').trim();
  if (!userId) {
    return json(400, { error: 'userId is required.' });
  }

  const adminSb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: callerData, error: callerError } = await adminSb.auth.getUser(token);
  const caller = callerData?.user;
  if (callerError || !caller) {
    return json(401, { error: 'Invalid or expired session.' });
  }
  if (caller.id === userId) {
    return json(400, { error: 'Admins cannot delete their own account here.' });
  }

  const { data: callerProfile, error: callerProfileError } = await adminSb
    .from('profiles')
    .select('role')
    .eq('id', caller.id)
    .maybeSingle();

  if (callerProfileError) {
    return json(500, { error: callerProfileError.message });
  }
  if (callerProfile?.role !== 'admin') {
    return json(403, { error: 'Admin access required.' });
  }

  const { data: targetProfile, error: targetProfileError } = await adminSb
    .from('profiles')
    .select('role,email')
    .eq('id', userId)
    .maybeSingle();

  if (targetProfileError) {
    return json(500, { error: targetProfileError.message });
  }
  if (!targetProfile) {
    return json(404, { error: 'User profile not found.' });
  }
  if (targetProfile.role === 'admin') {
    return json(400, { error: 'Admin accounts cannot be deleted from the students list.' });
  }

  const { error: deleteError } = await adminSb.auth.admin.deleteUser(userId);
  if (deleteError) {
    return json(400, { error: deleteError.message });
  }

  return json(200, {
    message: 'Student account deleted.',
    userId,
    email: targetProfile.email || null,
  });
};
