/* =============================================================
   File: main.js
   StudyTool — Main Application Logic
   Pure HTML/CSS/JS, no build step required.
   ============================================================= */

'use strict';

// ============================================================
// SECTION 1: App Config & Global State
// ============================================================

const APP = {
  name:             window.APP_NAME         || 'StudyTool',
  supabaseUrl:      window.SUPABASE_URL,
  supabaseKey:      window.SUPABASE_ANON_KEY,
  defaultQuizTime:  window.DEFAULT_QUIZ_TIME || 1800,
};

// Supabase client (UMD global exposed by the CDN script)
const sb = window.supabase.createClient(APP.supabaseUrl, APP.supabaseKey);

// Mutable application state
const state = {
  user:        null,   // Supabase auth user object
  profile:     null,   // Row from `profiles` table
  quiz:        null,   // Active quiz payload
  quizTimer:   null,   // setInterval handle for countdown
};

// ============================================================
// SECTION 2: Utility Helpers
// ============================================================

/** Format seconds → "MM:SS" */
function formatTime(sec) {
  const m = Math.floor(Math.abs(sec) / 60).toString().padStart(2, '0');
  const s = (Math.abs(sec) % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/** Human-readable date */
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Grade from percentage */
function getGrade(pct) {
  if (pct >= 90) return { grade: 'A+', emoji: '🏆' };
  if (pct >= 80) return { grade: 'A',  emoji: '⭐' };
  if (pct >= 70) return { grade: 'B',  emoji: '👍' };
  if (pct >= 60) return { grade: 'C',  emoji: '📚' };
  return { grade: 'D', emoji: '💪' };
}

/** Safe HTML escape */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Shuffle array (Fisher-Yates) */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Show/hide full-page preloader */
function showPreloader() {
  document.getElementById('preloader')?.classList.remove('hidden');
}
function hidePreloader() {
  setTimeout(() => document.getElementById('preloader')?.classList.add('hidden'), 280);
}

/** Toggle button loading state (shows embedded spinner) */
function btnLoading(btn, on) {
  if (!btn) return;
  btn.classList.toggle('loading', on);
  btn.disabled = on;
}

/** Toast notification */
function toast(msg, type = 'info', ms = 3800) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${esc(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideInRight 0.3s ease reverse';
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** Render KaTeX math in a DOM element */
function renderKaTeX(el) {
  if (!el || typeof renderMathInElement === 'undefined') return;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true  },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true  },
      ],
      throwOnError: false,
    });
  } catch (e) {
    console.warn('KaTeX:', e);
  }
}

// ============================================================
// SECTION 3: Modal System
// ============================================================

/**
 * Display a dismissible modal.
 * @param {object} opts  { title, body, actions:[{id,label,cls,handler}], onClose }
 */
function showModal({ title, body, actions = [], onClose } = {}) {
  const container = document.getElementById('modal-container');
  if (!container) return;

  const actionsBtns = actions.map(a =>
    `<button class="btn ${a.cls || 'btn-outline'}" data-mid="${esc(a.id)}">
       <span class="btn-spinner"></span>
       <span class="btn-text">${esc(a.label)}</span>
     </button>`
  ).join('');

  container.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <h2 class="modal-title" id="modal-title">${esc(title)}</h2>
          <button class="modal-close" id="modal-close-x" aria-label="Close modal">×</button>
        </div>
        <div class="modal-body">${body}</div>
        ${actions.length ? `<div class="modal-actions">${actionsBtns}</div>` : ''}
      </div>
    </div>`;

  function close() {
    container.innerHTML = '';
    if (typeof onClose === 'function') onClose();
  }

  document.getElementById('modal-close-x')
    .addEventListener('click', close);
  document.getElementById('modal-overlay')
    .addEventListener('click', e => { if (e.target === e.currentTarget) close(); });

  actions.forEach(a => {
    const btn = container.querySelector(`[data-mid="${a.id}"]`);
    if (btn && typeof a.handler === 'function') {
      btn.addEventListener('click', () => a.handler(btn, close));
    }
  });

  return { close };
}

function closeModal() {
  document.getElementById('modal-container').innerHTML = '';
}

// ============================================================
// SECTION 4: Router
// ============================================================

const PUBLIC_ROUTES  = new Set(['/login', '/set-password']);
const ADMIN_ROUTES   = new Set(['/admin']);

async function navigate(path) {
  window.location.hash = '#' + path;
}

async function router() {
  showPreloader();
  closeModal();

  // Detect Supabase email-link tokens in the URL hash
  const rawHash = window.location.hash || '';
  if (rawHash.includes('type=invite') || rawHash.includes('type=recovery')) {
    // Let Supabase SDK process the tokens, then load session
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      state.user = session.user;
      await loadProfile();
    }
    await renderSetPasswordPage();
    hidePreloader();
    return;
  }

  const path = rawHash.split('#')[1]?.split('?')[0] || '/login';

  // Auth guard
  if (!PUBLIC_ROUTES.has(path) && !state.user) {
    hidePreloader();
    navigate('/login');
    return;
  }
  if (path === '/login' && state.user) {
    hidePreloader();
    navigate('/dashboard');
    return;
  }
  if (ADMIN_ROUTES.has(path) && state.profile?.role !== 'admin') {
    hidePreloader();
    toast('Access denied — admin only.', 'error');
    navigate('/dashboard');
    return;
  }

  const renderers = {
    '/login':        renderLoginPage,
    '/set-password': renderSetPasswordPage,
    '/dashboard':    renderDashboard,
    '/quiz':         renderQuizPage,
    '/history':      renderHistoryPage,
    '/admin':        renderAdminPage,
  };

  const fn = renderers[path];
  if (fn) {
    await fn();
  } else {
    navigate(state.user ? '/dashboard' : '/login');
  }

  hidePreloader();
}

window.addEventListener('hashchange', router);

// ============================================================
// SECTION 5: Auth — Login / Register
// ============================================================

async function renderLoginPage() {
  document.getElementById('root').innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">
          <h1>📚 ${esc(APP.name)}</h1>
          <p>Your interactive study companion</p>
        </div>

        <div class="auth-tabs" role="tablist">
          <button class="auth-tab active" id="tab-login"    role="tab" aria-selected="true">Sign In</button>
          <button class="auth-tab"        id="tab-register" role="tab" aria-selected="false">Register</button>
        </div>

        <div id="auth-alert" class="auth-error" role="alert"></div>

        <!-- ─── Sign-in form ─── -->
        <form id="login-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="li-email">Email</label>
            <input class="form-input" type="email" id="li-email"
                   placeholder="you@example.com" required autocomplete="email" />
          </div>
          <div class="form-group">
            <label class="form-label" for="li-password">Password</label>
            <input class="form-input" type="password" id="li-password"
                   placeholder="••••••••" required autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-full btn-lg" id="login-submit-btn">
            <span class="btn-spinner"></span>
            <span class="btn-text">Sign In</span>
          </button>
          <div class="text-center mt-2">
            <button type="button" class="btn btn-ghost btn-sm" id="forgot-btn">
              Forgot password?
            </button>
          </div>
        </form>

        <!-- ─── Register form ─── -->
        <form id="register-form" style="display:none" novalidate>
          <div class="form-group">
            <label class="form-label" for="reg-name">Full Name</label>
            <input class="form-input" type="text" id="reg-name"
                   placeholder="Your full name" required autocomplete="name" />
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-email">Email</label>
            <input class="form-input" type="email" id="reg-email"
                   placeholder="you@example.com" required autocomplete="email" />
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-password">Password</label>
            <input class="form-input" type="password" id="reg-password"
                   placeholder="Minimum 8 characters" required minlength="8" autocomplete="new-password" />
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-confirm">Confirm Password</label>
            <input class="form-input" type="password" id="reg-confirm"
                   placeholder="Repeat your password" required autocomplete="new-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-full btn-lg" id="reg-submit-btn">
            <span class="btn-spinner"></span>
            <span class="btn-text">Create Account</span>
          </button>
        </form>
      </div>
    </div>`;

  // ── Tab switching ──
  function setTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('tab-login').classList.toggle('active', isLogin);
    document.getElementById('tab-register').classList.toggle('active', !isLogin);
    document.getElementById('tab-login').setAttribute('aria-selected', isLogin);
    document.getElementById('tab-register').setAttribute('aria-selected', !isLogin);
    document.getElementById('login-form').style.display    = isLogin ? '' : 'none';
    document.getElementById('register-form').style.display = isLogin ? 'none' : '';
    clearAlert();
  }
  document.getElementById('tab-login').addEventListener('click',    () => setTab('login'));
  document.getElementById('tab-register').addEventListener('click', () => setTab('register'));

  // ── Sign in ──
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn   = document.getElementById('login-submit-btn');
    const email = document.getElementById('li-email').value.trim();
    const pass  = document.getElementById('li-password').value;
    clearAlert();
    btnLoading(btn, true);
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    btnLoading(btn, false);
    if (error) showAlert('Invalid login credentials. Please try again.');
    // Success → onAuthStateChange handles redirect
  });

  // ── Register ──
  document.getElementById('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn     = document.getElementById('reg-submit-btn');
    const name    = document.getElementById('reg-name').value.trim();
    const email   = document.getElementById('reg-email').value.trim();
    const pass    = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;
    clearAlert();
    if (pass !== confirm)   { showAlert('Passwords do not match.');                    return; }
    if (pass.length < 8)    { showAlert('Password must be at least 8 characters.');   return; }
    btnLoading(btn, true);
    const { error } = await sb.auth.signUp({
      email, password: pass,
      options: { data: { full_name: name } },
    });
    btnLoading(btn, false);
    if (error) {
      showAlert(error.message);
    } else {
      showAlert('✅ Check your email to confirm your account, then sign in.', 'success');
    }
  });

  // ── Forgot password ──
  document.getElementById('forgot-btn').addEventListener('click', openForgotModal);
}

function showAlert(msg, type = 'error') {
  const el = document.getElementById('auth-alert');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (type === 'success') {
    el.style.cssText = 'display:block;background:#ebfbee;border-color:#b2f2bb;color:#2f9e44';
  }
}
function clearAlert() {
  const el = document.getElementById('auth-alert');
  if (el) { el.classList.remove('show'); el.textContent = ''; el.style.cssText = ''; }
}

function openForgotModal() {
  showModal({
    title: '🔒 Reset Password',
    body: `
      <p class="text-muted mb-2">Enter your email and we'll send a reset link.</p>
      <div class="form-group">
        <label class="form-label" for="reset-email">Email Address</label>
        <input class="form-input" type="email" id="reset-email"
               placeholder="you@example.com" autocomplete="email" />
      </div>
      <div id="reset-alert" style="display:none;padding:0.6rem 0.8rem;border-radius:7px;font-size:0.85rem;margin-top:0.5rem"></div>`,
    actions: [
      { id: 'cancel', label: 'Cancel', cls: 'btn-outline', handler: (_, close) => close() },
      {
        id: 'send', label: 'Send Reset Link', cls: 'btn-primary',
        handler: async (btn, close) => {
          const email    = document.getElementById('reset-email')?.value.trim();
          const alertEl  = document.getElementById('reset-alert');
          if (!email) return;
          btnLoading(btn, true);
          const { error } = await sb.auth.resetPasswordForEmail(email, {
            redirectTo: `${location.origin}${location.pathname}#/set-password`,
          });
          btnLoading(btn, false);
          if (alertEl) {
            alertEl.style.display = 'block';
            if (error) {
              alertEl.style.cssText = 'display:block;background:#fff5f5;color:var(--danger);border:1px solid #ffc9c9;border-radius:7px;padding:0.6rem 0.8rem;font-size:0.85rem';
              alertEl.textContent = error.message;
            } else {
              alertEl.style.cssText = 'display:block;background:#ebfbee;color:#2f9e44;border:1px solid #b2f2bb;border-radius:7px;padding:0.6rem 0.8rem;font-size:0.85rem';
              alertEl.textContent = '✅ Reset link sent! Check your inbox.';
            }
          }
        },
      },
    ],
  });
}

// ============================================================
// SECTION 6: Set Password Page  (invite / password-recovery)
// ============================================================

async function renderSetPasswordPage() {
  document.getElementById('root').innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">
          <h1>🔐 ${esc(APP.name)}</h1>
          <p>Set your new password to continue</p>
        </div>
        <div id="sp-alert" class="auth-error" role="alert"></div>
        <form id="set-pwd-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="sp-password">New Password</label>
            <input class="form-input" type="password" id="sp-password"
                   placeholder="Minimum 8 characters" required minlength="8" autocomplete="new-password" />
          </div>
          <div class="form-group">
            <label class="form-label" for="sp-confirm">Confirm Password</label>
            <input class="form-input" type="password" id="sp-confirm"
                   placeholder="Repeat your password" required autocomplete="new-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-full btn-lg" id="sp-btn">
            <span class="btn-spinner"></span>
            <span class="btn-text">Set Password &amp; Continue</span>
          </button>
        </form>
      </div>
    </div>`;

  document.getElementById('set-pwd-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn     = document.getElementById('sp-btn');
    const pass    = document.getElementById('sp-password').value;
    const confirm = document.getElementById('sp-confirm').value;
    const alertEl = document.getElementById('sp-alert');
    alertEl.classList.remove('show');

    if (pass !== confirm) { alertEl.textContent = 'Passwords do not match.';              alertEl.classList.add('show'); return; }
    if (pass.length < 8)  { alertEl.textContent = 'Password must be at least 8 characters.'; alertEl.classList.add('show'); return; }

    btnLoading(btn, true);
    const { error } = await sb.auth.updateUser({ password: pass });
    btnLoading(btn, false);

    if (error) {
      alertEl.textContent = error.message;
      alertEl.classList.add('show');
    } else {
      toast('Password set! Welcome to ' + APP.name + '.', 'success');
      // Reload profile so role is current
      await loadProfile();
      navigate('/dashboard');
    }
  });
}

// ============================================================
// SECTION 7: Profile & Session Helpers
// ============================================================

async function loadProfile() {
  if (!state.user) return;
  const { data } = await sb
    .from('profiles')
    .select('*')
    .eq('id', state.user.id)
    .single();
  if (data) state.profile = data;
}

async function signOut() {
  showPreloader();
  if (state.quizTimer) clearInterval(state.quizTimer);
  state.quiz    = null;
  await sb.auth.signOut();
  state.user    = null;
  state.profile = null;
  navigate('/login');
}

/** Shared app header markup */
function headerHTML(activePath) {
  const isAdmin = state.profile?.role === 'admin';
  const links = [
    { path: '/dashboard', label: '📊 Dashboard' },
    { path: '/quiz',      label: '📝 Take Quiz'  },
    { path: '/history',   label: '📖 History'    },
    ...(isAdmin ? [{ path: '/admin', label: '⚙️ Admin' }] : []),
  ];

  const navItems = links.map(l =>
    `<button class="nav-btn${activePath === l.path ? ' active' : ''}"
             onclick="navigate('${l.path}')">${l.label}</button>`
  ).join('');

  const mobileItems = links.map(l =>
    `<button class="nav-btn${activePath === l.path ? ' active' : ''}"
             onclick="navigate('${l.path}');_closeMobileMenu()">${l.label}</button>`
  ).join('');

  return `
    <header class="app-header">
      <div class="app-logo">📚 ${esc(APP.name)}</div>
      <nav class="app-nav" aria-label="Main navigation">
        ${navItems}
        <button class="nav-btn danger-nav" onclick="_confirmSignOut()">🚪 Sign Out</button>
      </nav>
      <button class="hamburger" id="hamburger-btn" aria-label="Open menu" onclick="_toggleMobileMenu()">
        <span></span><span></span><span></span>
      </button>
    </header>
    <div class="mobile-menu" id="mobile-menu" role="navigation" aria-label="Mobile navigation">
      ${mobileItems}
      <button class="nav-btn danger-nav" onclick="_confirmSignOut()">🚪 Sign Out</button>
    </div>`;
}

// Expose nav helpers to inline onclick attributes
window.navigate          = navigate;
window._toggleMobileMenu = () => document.getElementById('mobile-menu')?.classList.toggle('open');
window._closeMobileMenu  = () => document.getElementById('mobile-menu')?.classList.remove('open');
window._confirmSignOut   = () => showModal({
  title: '👋 Sign Out',
  body:  '<p>Are you sure you want to sign out?</p>',
  actions: [
    { id: 'cancel',  label: 'Cancel',   cls: 'btn-outline', handler: (_, c) => c() },
    { id: 'confirm', label: 'Sign Out', cls: 'btn-danger',  handler: (_, c) => { c(); signOut(); } },
  ],
});

// ============================================================
// SECTION 8: Dashboard / Stats
// ============================================================

async function renderDashboard() {
  const displayName = state.profile?.full_name || state.user?.email?.split('@')[0] || 'Student';

  document.getElementById('root').innerHTML = headerHTML('/dashboard') + `
    <div class="page">
      <div class="page-header">
        <h2 class="page-title">👋 Welcome, ${esc(displayName)}!</h2>
        <button class="btn btn-primary" onclick="navigate('/quiz')">
          <span class="btn-spinner"></span>
          <span class="btn-text">🚀 New Quiz</span>
        </button>
      </div>
      <div id="dash-content">
        <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>
      </div>
    </div>`;

  await loadDashboardStats();
}

async function loadDashboardStats() {
  const el = document.getElementById('dash-content');
  if (!el) return;

  const { data: sessions, error } = await sb
    .from('quiz_sessions')
    .select('*')
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false });

  if (error) { el.innerHTML = alertBox(error.message); return; }

  const completed = (sessions || []).filter(s => s.status === 'completed');
  const paused    = (sessions || []).filter(s => s.status === 'paused');

  const total     = completed.length;
  const avgPct    = total ? Math.round(completed.reduce((s, x) => s + pct(x), 0) / total) : 0;
  const bestPct   = total ? Math.max(...completed.map(pct)) : 0;
  const answered  = completed.reduce((s, x) => s + (x.total_questions || 0), 0);

  el.innerHTML = `
    <div class="stats-grid">
      ${statCard('🏆', total,       'Quizzes Completed')}
      ${statCard('📊', avgPct + '%', 'Average Score')}
      ${statCard('⭐', bestPct + '%','Best Score')}
      ${statCard('✏️', answered,    'Questions Answered')}
      ${statCard('⏸️', paused.length,'Paused Quizzes')}
    </div>

    ${paused.length ? `
      <div class="card mb-2">
        <div class="card-header">
          <div class="card-title">⏸️ Paused Quizzes</div>
          <button class="btn btn-ghost btn-sm" onclick="navigate('/history')">View all →</button>
        </div>
        <div class="history-list">${paused.slice(0, 3).map(historyItemHTML).join('')}</div>
      </div>` : ''}

    ${completed.length ? `
      <div class="card">
        <div class="card-header">
          <div class="card-title">📖 Recent Completed</div>
          <button class="btn btn-ghost btn-sm" onclick="navigate('/history')">View all →</button>
        </div>
        <div class="history-list">${completed.slice(0, 5).map(historyItemHTML).join('')}</div>
      </div>` : `
      <div class="empty-state">
        <div class="empty-state-icon">📝</div>
        <div class="empty-state-title">No quizzes yet!</div>
        <p class="text-muted mb-2">Start your first quiz to see stats here.</p>
        <button class="btn btn-primary btn-lg" onclick="navigate('/quiz')">Take Your First Quiz</button>
      </div>`}`;

  bindHistoryItemActions(el, loadDashboardStats);
}

function pct(s) { return s.total_questions ? Math.round(s.score / s.total_questions * 100) : 0; }
function statCard(icon, value, label) {
  return `<div class="stat-card">
    <div class="stat-icon">${icon}</div>
    <div class="stat-value">${esc(String(value))}</div>
    <div class="stat-label">${esc(label)}</div>
  </div>`;
}
function alertBox(msg) {
  return `<div class="auth-error show">${esc(msg)}</div>`;
}

// ============================================================
// SECTION 9: Quiz Module
// ============================================================

async function renderQuizPage() {
  const { data: paused } = await sb
    .from('quiz_sessions')
    .select('*')
    .eq('user_id', state.user.id)
    .eq('status', 'paused')
    .order('created_at', { ascending: false })
    .limit(3);

  document.getElementById('root').innerHTML = headerHTML('/quiz') + `
    <div class="page">
      <div class="page-header">
        <h2 class="page-title">📝 Take a Quiz</h2>
      </div>

      ${paused?.length ? `
        <div class="card mb-2" style="border-color:var(--warning);border-width:2px">
          <div class="card-title mb-1">⏸️ Resume a Paused Quiz</div>
          <div class="history-list">${paused.map(historyItemHTML).join('')}</div>
        </div>` : ''}

      <div class="card quiz-setup">
        <div class="card-title mb-2">Configure Your Quiz</div>
        <form id="quiz-setup-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="qs-cat">Category</label>
            <select class="form-input" id="qs-cat">
              <option value="">All Categories</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="qs-count">Number of Questions</label>
            <select class="form-input" id="qs-count">
              <option value="5">5 Questions</option>
              <option value="10" selected>10 Questions</option>
              <option value="20">20 Questions</option>
              <option value="30">30 Questions</option>
              <option value="50">50 Questions</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="qs-time">Time Limit</label>
            <select class="form-input" id="qs-time">
              <option value="600">10 minutes</option>
              <option value="900">15 minutes</option>
              <option value="1800" selected>30 minutes</option>
              <option value="3600">60 minutes</option>
              <option value="0">No limit</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="qs-shuffle">Shuffle Questions</label>
            <select class="form-input" id="qs-shuffle">
              <option value="1">Yes — shuffle order</option>
              <option value="0">No — keep original order</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary btn-full btn-lg" id="start-quiz-btn">
            <span class="btn-spinner"></span>
            <span class="btn-text">🚀 Start Quiz</span>
          </button>
        </form>
      </div>
    </div>`;

  // Bind paused quiz actions
  bindHistoryItemActions(document.getElementById('root'), () => navigate('/quiz'));

  // Populate categories from Supabase
  const { data: cats } = await sb.from('questions').select('category').not('category', 'is', null);
  if (cats) {
    const unique = [...new Set(cats.map(c => c.category).filter(Boolean))].sort();
    const sel = document.getElementById('qs-cat');
    if (sel) unique.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat; opt.textContent = cat;
      sel.appendChild(opt);
    });
  }

  // Start quiz
  document.getElementById('quiz-setup-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn      = document.getElementById('start-quiz-btn');
    const category = document.getElementById('qs-cat').value;
    const count    = parseInt(document.getElementById('qs-count').value, 10);
    const timeLimit= parseInt(document.getElementById('qs-time').value,  10);
    const doShuffle= document.getElementById('qs-shuffle').value === '1';
    btnLoading(btn, true);
    await startNewQuiz({ category, count, timeLimit, doShuffle });
    btnLoading(btn, false);
  });
}

async function startNewQuiz({ category, count, timeLimit, doShuffle }) {
  let query = sb.from('questions').select('*');
  if (category) query = query.eq('category', category);
  const { data: questions, error } = await query;

  if (error || !questions?.length) {
    toast('No questions found for the selected criteria.', 'error');
    return;
  }

  let selected = doShuffle ? shuffle(questions) : questions;
  selected = selected.slice(0, count);

  const { data: session, error: sessionErr } = await sb
    .from('quiz_sessions')
    .insert({
      user_id:        state.user.id,
      status:         'in_progress',
      questions_data: selected,
      answers:        {},
      current_index:  0,
      score:          0,
      total_questions: selected.length,
      time_remaining: timeLimit || 0,
      time_limit:     timeLimit,
      category:       category || 'All',
    })
    .select()
    .single();

  if (sessionErr) { toast('Could not create quiz: ' + sessionErr.message, 'error'); return; }

  state.quiz = {
    sessionId:     session.id,
    questions:     selected,
    answers:       {},
    currentIndex:  0,
    timeRemaining: timeLimit || 0,
    timeLimit,
    status:        'in_progress',
  };

  renderActiveQuiz();
}

async function resumeQuiz(sessionId) {
  showPreloader();
  const { data: session, error } = await sb
    .from('quiz_sessions').select('*').eq('id', sessionId).single();
  hidePreloader();

  if (error || !session) { toast('Could not load quiz session.', 'error'); return; }

  state.quiz = {
    sessionId:     session.id,
    questions:     session.questions_data,
    answers:       session.answers || {},
    currentIndex:  session.current_index || 0,
    timeRemaining: session.time_remaining || 0,
    timeLimit:     session.time_limit,
    status:        'in_progress',
  };

  renderActiveQuiz();
}

function renderActiveQuiz() {
  document.getElementById('root').innerHTML = headerHTML('/quiz') + `
    <div class="page">
      <div class="quiz-container" id="quiz-wrapper"></div>
    </div>`;

  renderQuestionUI();

  if (state.quizTimer) clearInterval(state.quizTimer);
  if (state.quiz.timeLimit > 0) {
    state.quizTimer = setInterval(async () => {
      if (!state.quiz) { clearInterval(state.quizTimer); return; }
      state.quiz.timeRemaining = Math.max(0, state.quiz.timeRemaining - 1);
      updateTimerDisplay();
      if (state.quiz.timeRemaining <= 0) {
        clearInterval(state.quizTimer);
        toast('⏰ Time is up! Submitting your quiz…', 'warning');
        await submitQuiz(true);
      }
    }, 1000);
  }
}

function renderQuestionUI() {
  const q       = state.quiz;
  const total   = q.questions.length;
  const idx     = q.currentIndex;
  const question= q.questions[idx];
  const progress= Math.round((idx / total) * 100);
  const answered= Object.keys(q.answers).length;
  const selected= q.answers[question.id];
  const options = Object.entries(question.options || {});

  const timerHTML = q.timeLimit > 0
    ? `<div class="timer" id="quiz-timer" aria-live="polite" aria-label="Time remaining">⏱ ${formatTime(q.timeRemaining)}</div>`
    : `<div></div>`;

  document.getElementById('quiz-wrapper').innerHTML = `
    <div class="quiz-header">
      <div class="quiz-progress-text">Question ${idx + 1} of ${total} &bull; ${answered} answered</div>
      ${timerHTML}
      <div style="display:flex;gap:0.5rem;flex-shrink:0">
        <button class="btn btn-outline btn-sm" id="pause-btn">
          <span class="btn-spinner"></span><span class="btn-text">⏸️ Pause</span>
        </button>
        <button class="btn btn-danger btn-sm" id="submit-early-btn">
          <span class="btn-spinner"></span><span class="btn-text">Submit</span>
        </button>
      </div>
    </div>

    <div class="progress-bar-outer" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar-inner" style="width:${progress}%"></div>
    </div>

    <div class="card question-card">
      <div class="question-number">Question ${idx + 1}</div>
      <div class="question-text" id="q-text-display">${question.question_text}</div>
      <div class="options-list" id="options-list">
        ${options.map(([label, text]) => `
          <button class="option-btn${selected === label ? ' selected' : ''}" data-label="${esc(label)}" type="button">
            <div class="option-label">${esc(label)}</div>
            <div>${text}</div>
          </button>`).join('')}
      </div>
    </div>

    <div class="quiz-nav">
      <button class="btn btn-outline" id="prev-btn" ${idx === 0 ? 'disabled' : ''}>← Previous</button>
      <span class="text-muted" style="font-size:0.875rem">${idx + 1} / ${total}</span>
      ${idx < total - 1
        ? `<button class="btn btn-primary" id="next-btn">Next →</button>`
        : `<button class="btn btn-success" id="next-btn">Review &amp; Submit ✓</button>`}
    </div>`;

  // Render KaTeX
  renderKaTeX(document.getElementById('q-text-display'));
  document.querySelectorAll('#options-list .option-btn > div:last-child').forEach(el => renderKaTeX(el));

  updateTimerDisplay();

  // Option selection
  document.querySelectorAll('.option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      q.answers[question.id] = btn.dataset.label;
      document.querySelectorAll('.option-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.label === btn.dataset.label);
      });
    });
  });

  document.getElementById('prev-btn')?.addEventListener('click', () => {
    q.currentIndex = Math.max(0, q.currentIndex - 1);
    renderQuestionUI();
  });
  document.getElementById('next-btn')?.addEventListener('click', async () => {
    if (idx < total - 1) {
      q.currentIndex++;
      renderQuestionUI();
    } else {
      openReviewModal();
    }
  });
  document.getElementById('pause-btn')?.addEventListener('click', async btn => {
    const el = document.getElementById('pause-btn');
    btnLoading(el, true);
    await pauseQuiz();
    btnLoading(el, false);
  });
  document.getElementById('submit-early-btn')?.addEventListener('click', openSubmitConfirmModal);
}

function updateTimerDisplay() {
  const el = document.getElementById('quiz-timer');
  if (!el || !state.quiz) return;
  const t = state.quiz.timeRemaining;
  el.textContent = `⏱ ${formatTime(t)}`;
  el.className = 'timer';
  if (t > 0 && t <= 60)  el.classList.add('danger');
  else if (t <= 300)     el.classList.add('warn');
}

function openReviewModal() {
  const q         = state.quiz;
  const unanswered= q.questions.filter(x => !q.answers[x.id]).length;
  showModal({
    title: '📋 Review & Submit',
    body: `
      <p>Answered <strong>${Object.keys(q.answers).length}</strong> of <strong>${q.questions.length}</strong> questions.</p>
      ${unanswered > 0
        ? `<p class="text-danger mt-1">⚠️ ${unanswered} question${unanswered > 1 ? 's' : ''} unanswered.</p>`
        : `<p class="text-success mt-1">✅ All questions answered!</p>`}`,
    actions: [
      { id: 'back',   label: 'Go Back',     cls: 'btn-outline', handler: (_, c) => c() },
      { id: 'submit', label: 'Submit Quiz', cls: 'btn-primary', handler: async (btn, c) => {
          btnLoading(btn, true); c(); await submitQuiz(false);
      }},
    ],
  });
}

function openSubmitConfirmModal() {
  showModal({
    title: '⚠️ Submit Quiz?',
    body:  '<p>Are you sure? This cannot be undone.</p>',
    actions: [
      { id: 'cancel', label: 'Cancel',     cls: 'btn-outline', handler: (_, c) => c() },
      { id: 'submit', label: 'Yes, Submit',cls: 'btn-primary', handler: async (btn, c) => {
          btnLoading(btn, true); c(); await submitQuiz(false);
      }},
    ],
  });
}

async function pauseQuiz() {
  if (!state.quiz) return;
  const q = state.quiz;
  if (state.quizTimer) clearInterval(state.quizTimer);

  const { error } = await sb.from('quiz_sessions').update({
    status:        'paused',
    answers:       q.answers,
    current_index: q.currentIndex,
    time_remaining:q.timeRemaining,
  }).eq('id', q.sessionId);

  if (error) { toast('Failed to pause quiz: ' + error.message, 'error'); return; }

  state.quiz = null;
  toast('Quiz paused. Resume anytime from the Dashboard.', 'success');
  navigate('/dashboard');
}

async function submitQuiz(timeExpired = false) {
  if (!state.quiz) return;
  const q = state.quiz;
  if (state.quizTimer) clearInterval(state.quizTimer);

  let score = 0;
  q.questions.forEach(ques => { if (q.answers[ques.id] === ques.correct_answer) score++; });

  const { error } = await sb.from('quiz_sessions').update({
    status:        'completed',
    answers:       q.answers,
    score,
    current_index: q.currentIndex,
    time_remaining:q.timeRemaining,
    completed_at:  new Date().toISOString(),
  }).eq('id', q.sessionId);

  if (error) { toast('Failed to save results: ' + error.message, 'error'); return; }

  const percentage = Math.round((score / q.questions.length) * 100);
  const { grade, emoji } = getGrade(percentage);
  const savedQuestions = q.questions;
  const savedAnswers   = q.answers;
  state.quiz = null;

  renderQuizResults(score, savedQuestions.length, percentage, grade, emoji, savedQuestions, savedAnswers, timeExpired);
}

function renderQuizResults(score, total, percentage, grade, emoji, questions, answers, timeExpired) {
  // Ensure quiz wrapper exists
  if (!document.getElementById('quiz-wrapper')) {
    document.getElementById('root').innerHTML = headerHTML('/quiz') + `
      <div class="page"><div class="quiz-container" id="quiz-wrapper"></div></div>`;
  }

  document.getElementById('quiz-wrapper').innerHTML = `
    <div class="quiz-results card">
      <div class="score-circle">
        <div class="score-pct">${percentage}%</div>
        <div class="score-fraction">${score}/${total}</div>
      </div>
      <div class="result-grade">${emoji} Grade: ${grade}</div>
      <p class="text-muted mb-3">
        ${timeExpired ? '⏰ Time expired — ' : ''}
        You answered <strong>${score}</strong> of <strong>${total}</strong> questions correctly.
      </p>
      <div style="display:flex;gap:1rem;justify-content:center;flex-wrap:wrap" class="mb-3">
        <button class="btn btn-primary btn-lg" onclick="navigate('/quiz')">🚀 New Quiz</button>
        <button class="btn btn-outline btn-lg" onclick="navigate('/dashboard')">📊 Dashboard</button>
      </div>
      <hr class="divider" />
      <div style="text-align:left">
        <div class="card-title mb-2">📖 Answer Review</div>
        ${questions.map((q, i) => {
          const ua        = answers[q.id];
          const isCorrect = ua === q.correct_answer;
          const opts      = Object.entries(q.options || {});
          return `
            <div style="margin-bottom:1.5rem">
              <div style="font-weight:600;margin-bottom:0.5rem">
                Q${i + 1}. <span id="rv-q-${q.id}">${q.question_text}</span>
              </div>
              <div class="options-list">
                ${opts.map(([label, text]) => {
                  let cls = '';
                  if (label === q.correct_answer)            cls = 'correct';
                  else if (label === ua && !isCorrect)       cls = 'wrong';
                  return `
                    <div class="option-btn ${cls}" style="cursor:default" aria-disabled="true">
                      <div class="option-label">${esc(label)}</div>
                      <div id="rv-o-${q.id}-${label}">${text}</div>
                    </div>`;
                }).join('')}
              </div>
              <p style="font-size:0.83rem;margin-top:0.4rem;${isCorrect ? 'color:var(--success)' : 'color:var(--danger)'}">
                ${isCorrect ? '✅ Correct!' : `❌ You chose: ${esc(ua || '(none)')} — Correct: ${esc(q.correct_answer)}`}
              </p>
              ${q.explanation ? `<p style="font-size:0.83rem;color:var(--text-muted);font-style:italic;margin-top:0.2rem">💡 ${esc(q.explanation)}</p>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>`;

  // KaTeX on review
  questions.forEach(q => {
    const qEl = document.getElementById(`rv-q-${q.id}`);
    if (qEl) renderKaTeX(qEl);
    Object.keys(q.options || {}).forEach(label => {
      const oEl = document.getElementById(`rv-o-${q.id}-${label}`);
      if (oEl) renderKaTeX(oEl);
    });
  });
}

// ============================================================
// SECTION 10: History
// ============================================================

async function renderHistoryPage() {
  document.getElementById('root').innerHTML = headerHTML('/history') + `
    <div class="page">
      <div class="page-header">
        <h2 class="page-title">📖 Quiz History</h2>
        <button class="btn btn-danger btn-sm" id="clear-all-btn">
          <span class="btn-spinner"></span><span class="btn-text">🗑️ Clear All</span>
        </button>
      </div>
      <div class="tab-bar" role="tablist">
        <button class="tab-item active" data-tab="all"       role="tab">All</button>
        <button class="tab-item"        data-tab="completed" role="tab">Completed</button>
        <button class="tab-item"        data-tab="paused"    role="tab">Paused</button>
      </div>
      <div id="history-content">
        <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>
      </div>
    </div>`;

  let currentFilter = 'all';

  async function loadHistory() {
    const container = document.getElementById('history-content');
    if (!container) return;
    container.innerHTML = `<div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>`;

    let query = sb.from('quiz_sessions').select('*').eq('user_id', state.user.id).order('created_at', { ascending: false });
    if (currentFilter === 'completed') query = query.eq('status', 'completed');
    if (currentFilter === 'paused')    query = query.eq('status', 'paused');

    const { data, error } = await query;

    if (error) { container.innerHTML = alertBox(error.message); return; }
    if (!data?.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📝</div>
          <div class="empty-state-title">No history found</div>
          <p class="text-muted">Start a quiz to see history here.</p>
        </div>`;
      return;
    }

    container.innerHTML = `<div class="history-list">${data.map(historyItemHTML).join('')}</div>`;
    bindHistoryItemActions(container, loadHistory);
  }

  // Tab switching
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-item').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
      currentFilter = tab.dataset.tab;
      loadHistory();
    });
  });

  // Clear all
  document.getElementById('clear-all-btn')?.addEventListener('click', () => {
    showModal({
      title: '⚠️ Clear All History',
      body:  '<p>This will permanently delete all your quiz history. This action cannot be undone.</p>',
      actions: [
        { id: 'cancel',  label: 'Cancel',    cls: 'btn-outline', handler: (_, c) => c() },
        { id: 'confirm', label: 'Clear All', cls: 'btn-danger',  handler: async (btn, c) => {
          btnLoading(btn, true);
          const { error } = await sb.from('quiz_sessions').delete().eq('user_id', state.user.id);
          btnLoading(btn, false); c();
          if (error) toast(error.message, 'error');
          else { toast('History cleared!', 'success'); loadHistory(); }
        }},
      ],
    });
  });

  await loadHistory();
}

/** Build the HTML for a single history list item */
function historyItemHTML(session) {
  const isPaused  = session.status === 'paused';
  const scorePct  = session.total_questions > 0 ? Math.round(session.score / session.total_questions * 100) : 0;
  const progress  = `Q${(session.current_index || 0) + 1}/${session.total_questions}`;

  return `
    <div class="history-item">
      <span class="history-badge ${isPaused ? 'badge-paused' : 'badge-completed'}">
        ${isPaused ? '⏸️ Paused' : '✅ Done'}
      </span>
      <div class="history-info">
        <div class="history-title">${esc(session.category || 'General')} &bull; ${session.total_questions} Qs</div>
        <div class="history-meta">${formatDate(session.created_at)}</div>
      </div>
      <div class="history-score" style="${isPaused ? 'color:var(--warning)' : ''}">
        ${isPaused ? progress : scorePct + '%'}
      </div>
      <div class="history-actions">
        ${isPaused ? `
          <button class="btn btn-primary btn-sm" data-resume="${esc(session.id)}" type="button">
            <span class="btn-spinner"></span><span class="btn-text">▶ Resume</span>
          </button>` : ''}
        <button class="btn btn-outline btn-sm" data-delete="${esc(session.id)}" type="button"
                style="color:var(--danger);border-color:var(--danger)" aria-label="Delete session">
          <span class="btn-spinner"></span><span class="btn-text">🗑️</span>
        </button>
      </div>
    </div>`;
}

/** Attach resume + delete event listeners inside a container element */
function bindHistoryItemActions(container, onUpdate) {
  container?.querySelectorAll('[data-resume]').forEach(btn => {
    btn.addEventListener('click', () => resumeQuiz(btn.dataset.resume));
  });
  container?.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteSession(btn.dataset.delete, onUpdate));
  });
}

function deleteSession(id, callback) {
  showModal({
    title: '🗑️ Delete Quiz',
    body:  '<p>Delete this quiz session permanently? This cannot be undone.</p>',
    actions: [
      { id: 'cancel',  label: 'Cancel', cls: 'btn-outline', handler: (_, c) => c() },
      { id: 'confirm', label: 'Delete', cls: 'btn-danger',  handler: async (btn, c) => {
        btnLoading(btn, true);
        const { error } = await sb.from('quiz_sessions').delete().eq('id', id);
        btnLoading(btn, false); c();
        if (error) toast(error.message, 'error');
        else { toast('Session deleted.', 'success'); if (typeof callback === 'function') callback(); }
      }},
    ],
  });
}

// ============================================================
// SECTION 11: Admin Panel
// ============================================================

async function renderAdminPage() {
  if (state.profile?.role !== 'admin') { navigate('/dashboard'); return; }

  document.getElementById('root').innerHTML = headerHTML('/admin') + `
    <div class="page">
      <div class="page-header"><h2 class="page-title">⚙️ Admin Panel</h2></div>
      <div class="tab-bar" role="tablist">
        <button class="tab-item active" data-tab="questions" role="tab">Questions</button>
        <button class="tab-item"        data-tab="users"     role="tab">Users</button>
        <button class="tab-item"        data-tab="invite"    role="tab">Invite</button>
      </div>
      <div id="admin-content">
        <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>
      </div>
    </div>`;

  const tabLoaders = {
    questions: () => renderQuestionsTab(document.getElementById('admin-content')),
    users:     () => renderUsersTab(document.getElementById('admin-content')),
    invite:    () => renderInviteTab(document.getElementById('admin-content')),
  };

  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      tabLoaders[tab.dataset.tab]?.();
    });
  });

  await tabLoaders.questions();
}

// ── Questions tab ──
async function renderQuestionsTab(container) {
  container.innerHTML = `
    <div class="admin-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <div class="admin-section-title">MCQ Questions</div>
        <button class="btn btn-primary btn-sm" id="add-q-btn" type="button">
          <span class="btn-spinner"></span><span class="btn-text">+ Add Question</span>
        </button>
      </div>
      <div id="questions-list">
        <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>
      </div>
    </div>`;

  document.getElementById('add-q-btn')?.addEventListener('click', () => showQuestionModal(null));
  await loadQuestions();
}

async function loadQuestions() {
  const container = document.getElementById('questions-list');
  if (!container) return;

  const { data, error } = await sb.from('questions').select('*').order('created_at', { ascending: false });

  if (error) { container.innerHTML = alertBox(error.message); return; }
  if (!data?.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❓</div>
        <div class="empty-state-title">No questions yet</div>
        <p class="text-muted">Click "Add Question" to get started.</p>
      </div>`;
    return;
  }

  container.innerHTML = data.map(q => `
    <div class="question-item">
      <div class="question-item-header">
        <div class="question-item-text" id="qi-${q.id}">${q.question_text}</div>
        <div class="question-item-actions">
          <span style="font-size:0.72rem;color:var(--text-muted);padding:0.18rem 0.5rem;background:var(--bg);border-radius:4px;white-space:nowrap">
            ${esc(q.category || 'General')}
          </span>
          <button class="btn btn-outline btn-sm" data-edit="${esc(q.id)}" type="button" aria-label="Edit question">✏️</button>
          <button class="btn btn-outline btn-sm" data-del="${esc(q.id)}"  type="button"
                  style="color:var(--danger);border-color:var(--danger)" aria-label="Delete question">🗑️</button>
        </div>
      </div>
    </div>`).join('');

  // KaTeX on question previews
  data.forEach(q => {
    const el = document.getElementById(`qi-${q.id}`);
    if (el) renderKaTeX(el);
  });

  // Edit
  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = data.find(x => x.id === btn.dataset.edit);
      if (q) showQuestionModal(q);
    });
  });

  // Delete
  container.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      showModal({
        title: '🗑️ Delete Question',
        body:  '<p>Permanently delete this question?</p>',
        actions: [
          { id: 'cancel',  label: 'Cancel', cls: 'btn-outline', handler: (_, c) => c() },
          { id: 'confirm', label: 'Delete', cls: 'btn-danger',  handler: async (b, c) => {
            btnLoading(b, true);
            const { error } = await sb.from('questions').delete().eq('id', btn.dataset.del);
            btnLoading(b, false); c();
            if (error) toast(error.message, 'error');
            else { toast('Question deleted.', 'success'); loadQuestions(); }
          }},
        ],
      });
    });
  });
}

function showQuestionModal(existing) {
  const isEdit = !!existing;
  const opts   = existing?.options || { A: '', B: '', C: '', D: '' };

  showModal({
    title: isEdit ? '✏️ Edit Question' : '➕ Add Question',
    body: `
      <div class="form-group">
        <label class="form-label">Question Text <small style="font-weight:400;text-transform:none">(LaTeX: $…$  or  $$…$$)</small></label>
        <textarea class="form-input" id="qm-text" rows="3" placeholder="Enter question…">${esc(existing?.question_text || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Option A</label>
        <input class="form-input" type="text" id="qm-a" value="${esc(opts.A || '')}" placeholder="Option A" />
      </div>
      <div class="form-group">
        <label class="form-label">Option B</label>
        <input class="form-input" type="text" id="qm-b" value="${esc(opts.B || '')}" placeholder="Option B" />
      </div>
      <div class="form-group">
        <label class="form-label">Option C</label>
        <input class="form-input" type="text" id="qm-c" value="${esc(opts.C || '')}" placeholder="Option C" />
      </div>
      <div class="form-group">
        <label class="form-label">Option D</label>
        <input class="form-input" type="text" id="qm-d" value="${esc(opts.D || '')}" placeholder="Option D" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Correct Answer</label>
          <select class="form-input" id="qm-correct">
            ${['A','B','C','D'].map(l =>
              `<option value="${l}"${existing?.correct_answer === l ? ' selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Category</label>
          <input class="form-input" type="text" id="qm-cat" value="${esc(existing?.category || '')}" placeholder="e.g. Math, Biology" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Explanation <small style="font-weight:400;text-transform:none">(optional)</small></label>
        <textarea class="form-input" id="qm-exp" rows="2" placeholder="Explain the correct answer…">${esc(existing?.explanation || '')}</textarea>
      </div>`,
    actions: [
      { id: 'cancel', label: 'Cancel', cls: 'btn-outline', handler: (_, c) => c() },
      {
        id: 'save', label: isEdit ? 'Save Changes' : 'Add Question', cls: 'btn-primary',
        handler: async (btn, close) => {
          const qText = document.getElementById('qm-text')?.value.trim();
          const optA  = document.getElementById('qm-a')?.value.trim();
          const optB  = document.getElementById('qm-b')?.value.trim();
          const optC  = document.getElementById('qm-c')?.value.trim();
          const optD  = document.getElementById('qm-d')?.value.trim();
          const correct  = document.getElementById('qm-correct')?.value;
          const category = document.getElementById('qm-cat')?.value.trim();
          const exp      = document.getElementById('qm-exp')?.value.trim();

          if (!qText || !optA || !optB || !optC || !optD) {
            toast('Please fill in all required fields.', 'error');
            return;
          }

          btnLoading(btn, true);
          const payload = {
            question_text: qText,
            options:       { A: optA, B: optB, C: optC, D: optD },
            correct_answer:correct,
            category:      category || null,
            explanation:   exp || null,
            created_by:    state.user.id,
          };

          const { error } = isEdit
            ? await sb.from('questions').update(payload).eq('id', existing.id)
            : await sb.from('questions').insert(payload);

          btnLoading(btn, false);
          if (error) { toast(error.message, 'error'); return; }
          close();
          toast(isEdit ? 'Question updated!' : 'Question added!', 'success');
          loadQuestions();
        },
      },
    ],
  });
}

// ── Users tab ──
async function renderUsersTab(container) {
  container.innerHTML = `
    <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>`;

  const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });

  if (error) { container.innerHTML = alertBox(error.message); return; }

  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-title">All Users (${data?.length || 0})</div>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${(data || []).map(u => `
              <tr>
                <td>${esc(u.full_name || '—')}</td>
                <td>${esc(u.email || '—')}</td>
                <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-student'}">${esc(u.role || 'student')}</span></td>
                <td>${formatDate(u.created_at)}</td>
                <td>
                  <button class="btn btn-outline btn-sm" data-toggle-role="${esc(u.id)}"
                          data-cur-role="${esc(u.role || 'student')}" type="button">
                    <span class="btn-spinner"></span>
                    <span class="btn-text">${u.role === 'admin' ? '↓ Student' : '↑ Admin'}</span>
                  </button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  container.querySelectorAll('[data-toggle-role]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id      = btn.dataset.toggleRole;
      const newRole = btn.dataset.curRole === 'admin' ? 'student' : 'admin';
      btnLoading(btn, true);
      const { error } = await sb.from('profiles').update({ role: newRole }).eq('id', id);
      btnLoading(btn, false);
      if (error) toast(error.message, 'error');
      else { toast(`Role changed to ${newRole}.`, 'success'); renderUsersTab(container); }
    });
  });
}

// ── Invite tab ──
function renderInviteTab(container) {
  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-title">Invite a New Student</div>
      <div class="card" style="max-width:500px">
        <div class="info-box mb-2">
          📧 Invited students receive an email with a link that directs them to set their password
          before accessing the dashboard. Invitations are sent via the <code>/.netlify/functions/invite-user</code>
          serverless function — ensure <code>SUPABASE_SERVICE_ROLE_KEY</code> is set in your Netlify environment.
        </div>
        <div class="form-group">
          <label class="form-label" for="inv-email">Student Email</label>
          <input class="form-input" type="email" id="inv-email" placeholder="student@example.com" autocomplete="email" />
        </div>
        <div class="form-group">
          <label class="form-label" for="inv-name">Full Name <small style="font-weight:400;text-transform:none">(optional)</small></label>
          <input class="form-input" type="text" id="inv-name" placeholder="Student's name" />
        </div>
        <div id="inv-alert" style="display:none;border-radius:8px;padding:0.7rem 0.85rem;font-size:0.85rem;margin-bottom:1rem"></div>
        <button class="btn btn-primary" id="send-invite-btn" type="button">
          <span class="btn-spinner"></span><span class="btn-text">📧 Send Invitation</span>
        </button>
      </div>
    </div>`;

  document.getElementById('send-invite-btn')?.addEventListener('click', async () => {
    const btn     = document.getElementById('send-invite-btn');
    const email   = document.getElementById('inv-email')?.value.trim();
    const name    = document.getElementById('inv-name')?.value.trim();
    const alertEl = document.getElementById('inv-alert');

    if (!email) { toast('Please enter an email address.', 'error'); return; }

    btnLoading(btn, true);
    try {
      const res = await fetch('/.netlify/functions/invite-user', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email,
          name: name || '',
          redirectTo: `${location.origin}${location.pathname}#/set-password`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Invite failed');
      alertEl.style.cssText = 'display:block;background:#ebfbee;color:#2f9e44;border:1px solid #b2f2bb;border-radius:8px;padding:0.7rem 0.85rem;font-size:0.85rem;margin-bottom:1rem';
      alertEl.textContent   = `✅ Invitation sent to ${email}!`;
      document.getElementById('inv-email').value = '';
      document.getElementById('inv-name').value  = '';
    } catch (err) {
      alertEl.style.cssText = 'display:block;background:#fff5f5;color:var(--danger);border:1px solid #ffc9c9;border-radius:8px;padding:0.7rem 0.85rem;font-size:0.85rem;margin-bottom:1rem';
      alertEl.textContent   = '❌ ' + err.message;
    }
    btnLoading(btn, false);
  });
}

// ============================================================
// SECTION 12: App Bootstrap
// ============================================================

async function init() {
  // Restore auth session from storage
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    state.user = session.user;
    await loadProfile();
  }

  // Listen for auth changes (sign in / sign out / token refresh)
  sb.auth.onAuthStateChange(async (event, session) => {
    if (session) {
      state.user = session.user;
      await loadProfile();
    } else {
      state.user    = null;
      state.profile = null;
    }

    // For SIGNED_IN events triggered by email links, route accordingly
    if (event === 'SIGNED_IN') {
      const hash = window.location.hash;
      // If not already on an app page, go to dashboard
      if (!hash || hash === '#/login' || hash === '#/') {
        navigate('/dashboard');
        return;
      }
    }
    if (event === 'SIGNED_OUT') {
      navigate('/login');
    }
  });

  // Run the router once on load
  await router();
}

// Kick off
init().catch(err => {
  console.error('StudyTool init error:', err);
  hidePreloader();
});
