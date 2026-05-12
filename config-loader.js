/* =============================================================
   File: config-loader.js
   Loads server-provided configuration from Netlify Functions.
   ============================================================= */

'use strict';

(function () {
  var CONFIG_ENDPOINT = '/.netlify/functions/app-config';

  async function parseJsonSafe(res) {
    try {
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  function firstNonEmpty(values) {
    for (var i = 0; i < values.length; i += 1) {
      var value = values[i];
      if (value === null || value === undefined) continue;
      var trimmed = String(value).trim();
      if (trimmed) return trimmed;
    }
    return '';
  }

  async function loadStudyToolConfig() {
    var response;
    try {
      response = await fetch(CONFIG_ENDPOINT, {
        cache: 'no-cache',
        headers: { 'Cache-Control': 'no-cache' },
      });
    } catch (err) {
      throw new Error('Unable to reach configuration endpoint. Check your Netlify functions.');
    }

    var payload = await parseJsonSafe(response);

    if (!response.ok) {
      var msg = payload && payload.error
        ? payload.error
        : 'Server misconfiguration: missing Supabase env vars.';
      throw new Error(msg);
    }

    if (!payload) {
      throw new Error('Config endpoint returned invalid JSON. Ensure the Netlify function is deployed.');
    }

    var supabaseUrl = firstNonEmpty([
      payload.supabaseUrl,
      payload.SUPABASE_URL,
      window.SUPABASE_URL,
    ]);
    var supabaseAnonKey = firstNonEmpty([
      payload.supabaseAnonKey,
      payload.supabaseKey,
      payload.SUPABASE_ANON_KEY,
      window.SUPABASE_ANON_KEY,
    ]);

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Server misconfiguration: missing Supabase env vars.');
    }

    return {
      supabaseUrl: supabaseUrl,
      supabaseAnonKey: supabaseAnonKey,
      appName: payload && payload.appName ? payload.appName : (window.APP_NAME || 'StudyTool'),
      defaultQuizTime: Number(payload && payload.defaultQuizTime) || window.DEFAULT_QUIZ_TIME || 1800,
    };
  }

  window.loadStudyToolConfig = loadStudyToolConfig;
})();
