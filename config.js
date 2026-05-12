// =============================================================
// File: config.js
// StudyTool — Supabase Configuration
// Copy this file, fill in your real keys, and deploy.
// DO NOT commit real keys to version control.
// =============================================================

// Your Supabase project URL  (Project Settings → API → Project URL)
window.SUPABASE_URL = window.SUPABASE_URL || 'https://your-project-ref.supabase.co';

// Your Supabase anon/public key (Project Settings → API → anon public)
window.SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || 'your-anon-key-here';

// Displayed in the browser tab and header
window.APP_NAME = window.APP_NAME || 'StudyTool';

// Default quiz time limit in seconds (1800 = 30 minutes)
window.DEFAULT_QUIZ_TIME = window.DEFAULT_QUIZ_TIME || 1800;

(function validateConfig() {
  var placeholderUrl = 'https://your-project-ref.supabase.co';
  var placeholderKey = 'your-anon-key-here';
  var url = (window.SUPABASE_URL || '').trim();
  var key = (window.SUPABASE_ANON_KEY || '').trim();
  var errors = [];

  if (!url || url === placeholderUrl) {
    errors.push('Supabase URL is missing. Update window.SUPABASE_URL in config.js.');
  }
  if (!key || key === placeholderKey) {
    errors.push('Supabase anon key is missing. Update window.SUPABASE_ANON_KEY in config.js.');
  }

  window.STUDYTOOL_CONFIG_VALID = errors.length === 0;
  window.STUDYTOOL_CONFIG_ERRORS = errors;
})();
