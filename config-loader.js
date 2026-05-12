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

  async function loadStudyToolConfig() {
    var response;
    try {
      response = await fetch(CONFIG_ENDPOINT, { cache: 'no-store' });
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

    var supabaseUrl = payload && payload.supabaseUrl ? String(payload.supabaseUrl).trim() : '';
    var supabaseAnonKey = payload && payload.supabaseAnonKey ? String(payload.supabaseAnonKey).trim() : '';

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
