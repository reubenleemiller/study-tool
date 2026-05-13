/* =============================================================
   File: main.js
   StudyTool — Main Application Logic
   Pure HTML/CSS/JS, no build step required.
   ============================================================= */

'use strict';

// ============================================================
// SECTION 1: App Config & Global State
// ============================================================

let APP = {
  name:             window.APP_NAME         || 'StudyTool',
  supabaseUrl:      '',
  supabaseKey:      '',
  defaultQuizTime:  window.DEFAULT_QUIZ_TIME || 1800,
};

// Supabase client (UMD global exposed by the CDN script)
let sb = null;

// Mutable application state
const state = {
  user:        null,   // Supabase auth user object
  profile:     null,   // Row from `profiles` table
  quiz:        null,   // Active quiz payload
  quizTimer:   null,   // setInterval handle for countdown
};

const QUESTION_IMAGE_BUCKET = 'question-images';

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
  if (pct >= 90) return { grade: 'A+', icon: 'trophy' };
  if (pct >= 80) return { grade: 'A',  icon: 'star' };
  if (pct >= 70) return { grade: 'B',  icon: 'thumbs-up' };
  if (pct >= 60) return { grade: 'C',  icon: 'book-open' };
  return { grade: 'D', icon: 'dumbbell' };
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

function sanitizeQuestionHTML(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = String(html || '');
  const allowed = new Set(['B', 'STRONG', 'I', 'EM', 'MARK', 'UL', 'OL', 'LI', 'P', 'DIV', 'BR', 'SPAN']);

  function clean(node) {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        clean(child);
        if (!allowed.has(child.tagName)) {
          child.replaceWith(...Array.from(child.childNodes));
          return;
        }
        Array.from(child.attributes).forEach(attr => {
          const isHighlight = child.tagName === 'SPAN' &&
            attr.name === 'style' &&
            /background-color:\s*(rgb\(255,\s*243,\s*191\)|#fff3bf|yellow)/i.test(attr.value);
          if (!isHighlight) child.removeAttribute(attr.name);
        });
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    });
  }

  clean(wrapper);
  return wrapper.innerHTML.trim();
}

function questionTextHTML(text) {
  const html = sanitizeQuestionHTML(text || '');
  return html || esc(text || '');
}

function questionImageHTML(question) {
  return question?.image_url
    ? `<img class="question-image" src="${esc(question.image_url)}" alt="Question reference image" loading="lazy" />`
    : '';
}

function renderConfigError(message) {
  const root = document.getElementById('root');
  const preloader = document.getElementById('preloader');
  const msg = message || 'App configuration missing. Check Netlify environment variables.';

  if (root) {
    root.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-icon"><i class="fa-solid fa-gear"></i></div>' +
      '<div class="empty-state-title">App configuration required</div>' +
      '<p style="max-width:420px;margin:0 auto;color:var(--text-muted)">' + esc(msg) + '</p>' +
      '</div>';
  }

  if (preloader) preloader.classList.add('hidden');
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
  const icons = {
    info: 'circle-info',
    success: 'circle-check',
    error: 'circle-xmark',
    warning: 'triangle-exclamation',
  };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const iconName = icons[type] || icons.info;
  el.innerHTML = `<i class="fa-solid fa-${iconName}"></i><span>${esc(msg)}</span>`;
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
  if (window.location.hash === '#' + path) {
    await router();
    return;
  }
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

  if (state.user && !state.profile) {
    await loadProfile();
  }

  // Auth guard
  if (!PUBLIC_ROUTES.has(path) && !state.user) {
    hidePreloader();
    window.location.replace('login.html');
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
      <div class="auth-shell">
        <section class="auth-info" aria-labelledby="homepage-title">
          <div class="auth-brand">
            <i class="fa-solid fa-book-open"></i>
            <span>${esc(APP.name)}</span>
          </div>
          <h1 id="homepage-title">Practice multiple-choice quizzes with timed sessions, progress tracking, and math support.</h1>
          <p>
            ${esc(APP.name)} helps students prepare with focused MCQ practice, pause-and-resume quizzes,
            score history, category filtering, and readable KaTeX rendering for science and math questions.
          </p>
          <div class="auth-feature-grid" aria-label="Application features">
            <div class="auth-feature">
              <i class="fa-solid fa-list-check"></i>
              <span>Configurable quizzes by category and question count</span>
            </div>
            <div class="auth-feature">
              <i class="fa-solid fa-clock-rotate-left"></i>
              <span>Saved quiz history, scores, and paused sessions</span>
            </div>
            <div class="auth-feature">
              <i class="fa-solid fa-square-root-variable"></i>
              <span>Formatted math expressions for technical study material</span>
            </div>
            <div class="auth-feature">
              <i class="fa-solid fa-shield-halved"></i>
              <span>Google sign-in and email/password accounts powered by Supabase</span>
            </div>
          </div>
        </section>

        <div class="auth-panel">
          <div class="auth-card">
            <div class="auth-logo">
              <h2><i class="fa-solid fa-book-open"></i> ${esc(APP.name)}</h2>
              <p>Your interactive study companion</p>
            </div>

            <div class="auth-tabs" role="tablist">
              <button class="auth-tab active" id="tab-login"    role="tab" aria-selected="true">Sign In</button>
              <button class="auth-tab"        id="tab-register" role="tab" aria-selected="false">Register</button>
            </div>

            <div id="auth-alert" class="auth-error" role="alert"></div>

            <button type="button" class="btn btn-outline btn-full btn-lg google-auth-btn mb-2" id="google-auth-btn">
              <span class="btn-spinner"></span>
              <span class="btn-text"><i class="fa-brands fa-google"></i> Continue with Google</span>
            </button>

            <div class="auth-divider"><span>or</span></div>

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
                       placeholder="Password" required autocomplete="current-password" />
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
                <ul class="pwd-policy" id="reg-pwd-policy" aria-label="Password requirements">
                  <li id="reg-p-len">
                    <i class="fa-regular fa-circle pi"></i> At least 8 characters
                  </li>
                  <li id="reg-p-upper">
                    <i class="fa-regular fa-circle pi"></i> One uppercase letter (A&ndash;Z)
                  </li>
                  <li id="reg-p-lower">
                    <i class="fa-regular fa-circle pi"></i> One lowercase letter (a&ndash;z)
                  </li>
                  <li id="reg-p-digit">
                    <i class="fa-regular fa-circle pi"></i> One number (0&ndash;9)
                  </li>
                  <li id="reg-p-special">
                    <i class="fa-regular fa-circle pi"></i> One special character (!&nbsp;@&nbsp;#&nbsp;...)
                  </li>
                </ul>
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
            <div class="auth-legal">
              <a href="terms.html">Terms</a>
              <span>&bull;</span>
              <a href="privacy.html">Privacy</a>
            </div>
          </div>
        </div>
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
  document.getElementById('google-auth-btn')?.addEventListener('click', () => signInWithGoogle());

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

  // ── Password policy (register) ──
  const REG_CRITERIA = [
    { id: 'reg-p-len',     test: v => v.length >= 8 },
    { id: 'reg-p-upper',   test: v => /[A-Z]/.test(v) },
    { id: 'reg-p-lower',   test: v => /[a-z]/.test(v) },
    { id: 'reg-p-digit',   test: v => /[0-9]/.test(v) },
    { id: 'reg-p-special', test: v => /[^A-Za-z0-9]/.test(v) },
  ];
  function setPolicyIcon(li, met) {
    const icon = li?.querySelector('.pi');
    if (!icon) return;
    icon.className = met
      ? 'fa-solid fa-circle-check pi'
      : 'fa-regular fa-circle pi';
  }

  const regPwdInput = document.getElementById('reg-password');
  regPwdInput?.addEventListener('input', () => {
    const v = regPwdInput.value;
    REG_CRITERIA.forEach(c => {
      const li = document.getElementById(c.id);
      const met = c.test(v);
      if (!li) return;
      li.classList.toggle('met', met);
      setPolicyIcon(li, met);
    });
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
    const unmet = REG_CRITERIA.filter(c => !c.test(pass));
    if (unmet.length > 0) {
      showAlert('Your password does not meet all the requirements listed below.');
      return;
    }
    btnLoading(btn, true);
    const { error } = await sb.auth.signUp({
      email, password: pass,
      options: {
        data: { full_name: name },
        emailRedirectTo: new URL('/index.html', location.origin).href,
      },
    });
    btnLoading(btn, false);
    if (error) {
      showAlert(formatSignupError(error));
    } else {
      showAlert('Check your email to confirm your account, then sign in.', 'success');
    }
  });

  // ── Forgot password ──
  document.getElementById('forgot-btn').addEventListener('click', openForgotModal);
}

async function signInWithGoogle() {
  clearAlert();
  const btn = document.getElementById('google-auth-btn') || document.getElementById('google-login-btn') || document.getElementById('google-signup-btn');
  btnLoading(btn, true);
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: new URL('/index.html', location.origin).href,
      queryParams: { prompt: 'select_account' },
    },
  });
  btnLoading(btn, false);
  if (error) showAlert(error.message || 'Google sign-in failed.');
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
function formatSignupError(error) {
  if (!error) return 'Signup failed. Please try again.';
  if (error.status === 500) {
    return 'Signup failed due to a server error. Check Supabase Auth settings (Site URL, Redirect URLs, SMTP) and try again.';
  }
  return error.message || 'Signup failed. Please try again.';
}

function openForgotModal() {
  showModal({
    title: 'Reset Password',
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
            redirectTo: `${location.origin}/set-password.html`,
          });
          btnLoading(btn, false);
          if (alertEl) {
            alertEl.style.display = 'block';
            if (error) {
              alertEl.style.cssText = 'display:block;background:#fff5f5;color:var(--danger);border:1px solid #ffc9c9;border-radius:7px;padding:0.6rem 0.8rem;font-size:0.85rem';
              alertEl.textContent = error.message;
            } else {
              alertEl.style.cssText = 'display:block;background:#ebfbee;color:#2f9e44;border:1px solid #b2f2bb;border-radius:7px;padding:0.6rem 0.8rem;font-size:0.85rem';
              alertEl.textContent = 'Reset link sent. Check your inbox.';
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
          <h1><i class="fa-solid fa-lock"></i> ${esc(APP.name)}</h1>
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
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', state.user.id)
    .maybeSingle();
  if (error) {
    console.warn('Profile load failed:', error.message);
    state.profile = null;
    return;
  }
  if (data) {
    state.profile = data;
    return;
  }
  const metaRole = state.user.user_metadata?.role;
  if (metaRole === 'admin' || metaRole === 'student') {
    state.profile = {
      role: metaRole,
      email: state.user.email || null,
      full_name: state.user.user_metadata?.full_name || null,
    };
  } else {
    state.profile = null;
  }
}

async function signOut() {
  showPreloader();
  if (state.quizTimer) clearInterval(state.quizTimer);
  state.quiz    = null;
  await sb.auth.signOut();
  state.user    = null;
  state.profile = null;
  window.location.replace('login.html');
}

/** Shared app header markup */
function headerHTML(activePath) {
  const isAdmin = state.profile?.role === 'admin';
  const links = [
    { path: '/dashboard', label: '<i class="fa-solid fa-gauge-high"></i> Dashboard' },
    { path: '/quiz',      label: '<i class="fa-solid fa-list-check"></i> Take Quiz'  },
    { path: '/history',   label: '<i class="fa-solid fa-clock-rotate-left"></i> History' },
    ...(isAdmin ? [{ path: '/admin', label: '<i class="fa-solid fa-gear"></i> Admin' }] : []),
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
      <div class="app-logo"><i class="fa-solid fa-book-open"></i> ${esc(APP.name)}</div>
      <nav class="app-nav" aria-label="Main navigation">
        ${navItems}
        <button class="nav-btn danger-nav" onclick="_confirmSignOut()">
          <i class="fa-solid fa-right-from-bracket"></i> Sign Out
        </button>
      </nav>
      <button class="hamburger" id="hamburger-btn" aria-label="Open menu" onclick="_toggleMobileMenu()">
        <span></span><span></span><span></span>
      </button>
    </header>
    <div class="mobile-menu" id="mobile-menu" role="navigation" aria-label="Mobile navigation">
      ${mobileItems}
      <button class="nav-btn danger-nav" onclick="_confirmSignOut()">
        <i class="fa-solid fa-right-from-bracket"></i> Sign Out
      </button>
    </div>`;
}

// Expose nav helpers to inline onclick attributes
window.navigate          = navigate;
window._toggleMobileMenu = () => document.getElementById('mobile-menu')?.classList.toggle('open');
window._closeMobileMenu  = () => document.getElementById('mobile-menu')?.classList.remove('open');
window._confirmSignOut   = () => showModal({
  title: 'Sign Out',
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
        <h2 class="page-title"><i class="fa-solid fa-user"></i> Welcome, ${esc(displayName)}!</h2>
        <button class="btn btn-primary" onclick="navigate('/quiz')">
          <span class="btn-spinner"></span>
          <span class="btn-text"><i class="fa-solid fa-rocket"></i> New Quiz</span>
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
  const inProgress= (sessions || []).filter(s => s.status === 'in_progress');
  const resumable = [...inProgress, ...paused].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const total     = completed.length;
  const avgPct    = total ? Math.round(completed.reduce((s, x) => s + pct(x), 0) / total) : 0;
  const bestPct   = total ? Math.max(...completed.map(pct)) : 0;
  const answered  = completed.reduce((s, x) => s + (x.total_questions || 0), 0);

  el.innerHTML = `
    <div class="stats-grid">
      ${statCard('trophy', total,        'Quizzes Completed')}
      ${statCard('chart-line', avgPct + '%', 'Average Score')}
      ${statCard('star', bestPct + '%',  'Best Score')}
      ${statCard('pen', answered,        'Questions Answered')}
      ${statCard('pause', paused.length, 'Paused Quizzes')}
      ${statCard('spinner', inProgress.length, 'In Progress')}
    </div>

    <div class="card mb-2">
      ${renderAverageScoreChart(sessions || [], 'Average Score Over Time')}
    </div>

    ${resumable.length ? `
      <div class="card mb-2">
        <div class="card-header">
          <div class="card-title"><i class="fa-solid fa-pause"></i> Resume Quizzes</div>
          <button class="btn btn-ghost btn-sm" onclick="navigate('/history')">View all →</button>
        </div>
        <div class="history-list">${resumable.slice(0, 3).map(historyItemHTML).join('')}</div>
      </div>` : ''}

    ${completed.length ? `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><i class="fa-solid fa-circle-check"></i> Recent Completed</div>
          <button class="btn btn-ghost btn-sm" onclick="navigate('/history')">View all →</button>
        </div>
        <div class="history-list">${completed.slice(0, 5).map(historyItemHTML).join('')}</div>
      </div>` : `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fa-solid fa-clipboard-list"></i></div>
        <div class="empty-state-title">No quizzes yet!</div>
        <p class="text-muted mb-2">Start your first quiz to see stats here.</p>
        <button class="btn btn-primary btn-lg" onclick="navigate('/quiz')">
          <i class="fa-solid fa-rocket"></i> Take Your First Quiz
        </button>
      </div>`}`;

  bindHistoryItemActions(el, loadDashboardStats);
}

function pct(s) { return s.total_questions ? Math.round(s.score / s.total_questions * 100) : 0; }
function computeQuizStats(sessions) {
  const all = sessions || [];
  const completed = all.filter(s => s.status === 'completed');
  const paused = all.filter(s => s.status === 'paused');
  const inProgress = all.filter(s => s.status === 'in_progress');
  const total = completed.length;
  return {
    completed,
    paused,
    inProgress,
    total,
    avgPct: total ? Math.round(completed.reduce((sum, s) => sum + pct(s), 0) / total) : 0,
    bestPct: total ? Math.max(...completed.map(pct)) : 0,
    answered: completed.reduce((sum, s) => sum + (s.total_questions || 0), 0),
  };
}
function isTimeExpiredSession(session) {
  return Boolean(session?.time_expired) ||
    (session?.status === 'completed' && Number(session?.time_limit || 0) > 0 && Number(session?.time_remaining || 0) === 0);
}
function sessionStatusMeta(session) {
  if (isTimeExpiredSession(session)) {
    return { cls: 'badge-expired', icon: 'clock', label: 'Time Expired' };
  }
  if (session.status === 'paused') {
    return { cls: 'badge-paused', icon: 'pause', label: 'Paused' };
  }
  if (session.status === 'in_progress') {
    return { cls: 'badge-progress', icon: 'spinner', label: 'In Progress' };
  }
  return { cls: 'badge-completed', icon: 'circle-check', label: 'Done' };
}
function getSessionDisplayName(session, profilesById = new Map()) {
  const profile = profilesById.get(session.user_id);
  return profile?.full_name || profile?.email || session.user_id || 'Unknown user';
}
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function downloadCSV(filename, rows) {
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function sessionCSVRows(sessions, profilesById = new Map()) {
  return [
    ['User', 'Email', 'Status', 'Score', 'Percent', 'Category', 'Questions', 'Answered', 'Time Limit', 'Time Remaining', 'Time Expired', 'Started At', 'Completed At', 'Session ID'],
    ...(sessions || []).map(session => {
      const profile = profilesById.get(session.user_id) || {};
      return [
        profile.full_name || '',
        profile.email || '',
        sessionStatusMeta(session).label,
        session.status === 'completed' ? `${session.score || 0}/${session.total_questions || 0}` : '',
        session.status === 'completed' ? `${pct(session)}%` : '',
        session.category || 'General',
        session.total_questions || 0,
        Object.keys(session.answers || {}).length,
        formatTime(session.time_limit || 0),
        formatTime(session.time_remaining || 0),
        isTimeExpiredSession(session) ? 'Yes' : 'No',
        formatDate(session.started_at || session.created_at),
        formatDate(session.completed_at),
        session.id,
      ];
    }),
  ];
}
function renderAverageScoreChart(sessions, title = 'Average Score Over Time') {
  const completed = (sessions || [])
    .filter(s => s.status === 'completed')
    .sort((a, b) => new Date(a.completed_at || a.created_at) - new Date(b.completed_at || b.created_at));

  if (!completed.length) {
    return `
      <div class="chart-panel">
        <div class="card-title"><i class="fa-solid fa-chart-line"></i> ${esc(title)}</div>
        <div class="empty-state" style="padding:2rem 1rem">
          <div class="empty-state-title">No completed quizzes yet</div>
        </div>
      </div>`;
  }

  let running = 0;
  const points = completed.map((session, index) => {
    running += pct(session);
    return {
      label: formatDate(session.completed_at || session.created_at),
      avg: Math.round(running / (index + 1)),
    };
  });
  const width = 680;
  const height = 220;
  const pad = 34;
  const xStep = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = points.length > 1 ? pad + index * xStep : width / 2;
    const y = height - pad - (point.avg / 100) * (height - pad * 2);
    return { ...point, x, y };
  });
  const line = coords.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  const latest = coords[coords.length - 1];

  return `
    <div class="chart-panel">
      <div class="card-header">
        <div class="card-title"><i class="fa-solid fa-chart-line"></i> ${esc(title)}</div>
        <span class="role-badge role-student">${latest.avg}% latest avg</span>
      </div>
      <div class="score-chart" role="img" aria-label="${esc(title)}">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="chart-axis"></line>
          <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="chart-axis"></line>
          <text x="6" y="${pad + 4}" class="chart-label">100%</text>
          <text x="14" y="${height - pad + 4}" class="chart-label">0%</text>
          <polygon points="${area}" class="chart-area"></polygon>
          <polyline points="${line}" class="chart-line"></polyline>
          ${coords.map(p => `
            <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" class="chart-point">
              <title>${esc(p.label)}: ${p.avg}% average</title>
            </circle>`).join('')}
        </svg>
      </div>
    </div>`;
}
function statCard(icon, value, label) {
  return `<div class="stat-card">
    <div class="stat-icon"><i class="fa-solid fa-${icon}"></i></div>
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
    .in('status', ['paused', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(3);

  document.getElementById('root').innerHTML = headerHTML('/quiz') + `
    <div class="page">
      <div class="page-header">
        <h2 class="page-title"><i class="fa-solid fa-list-check"></i> Take a Quiz</h2>
      </div>

      ${paused?.length ? `
        <div class="card mb-2" style="border-color:var(--warning);border-width:2px">
          <div class="card-title mb-1"><i class="fa-solid fa-pause"></i> Resume a Quiz</div>
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
            <span class="btn-text"><i class="fa-solid fa-rocket"></i> Start Quiz</span>
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
  let { data: questions, error } = await query
    .order('display_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error && /display_order|schema cache|column/i.test(error.message || '')) {
    query = sb.from('questions').select('*');
    if (category) query = query.eq('category', category);
    ({ data: questions, error } = await query.order('created_at', { ascending: false }));
  }

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

  if (session.status !== 'in_progress') {
    await sb.from('quiz_sessions').update({ status: 'in_progress' }).eq('id', session.id);
  }

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
        toast('Time is up. Submitting your quiz...', 'warning');
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
    ? `<div class="timer" id="quiz-timer" aria-live="polite" aria-label="Time remaining"><i class="fa-solid fa-clock"></i> ${formatTime(q.timeRemaining)}</div>`
    : `<div></div>`;

  document.getElementById('quiz-wrapper').innerHTML = `
    <div class="quiz-header">
      <div class="quiz-progress-text">Question ${idx + 1} of ${total} &bull; ${answered} answered</div>
      ${timerHTML}
      <div style="display:flex;gap:0.5rem;flex-shrink:0">
        <button class="btn btn-outline btn-sm" id="pause-btn">
          <span class="btn-spinner"></span><span class="btn-text"><i class="fa-solid fa-pause"></i> Pause</span>
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
      <div class="question-text" id="q-text-display">${questionTextHTML(question.question_text)}</div>
      ${questionImageHTML(question)}
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
        : `<button class="btn btn-success" id="next-btn"><i class="fa-solid fa-check"></i> Review &amp; Submit</button>`}
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
  el.innerHTML = `<i class="fa-solid fa-clock"></i> ${formatTime(t)}`;
  el.className = 'timer';
  if (t > 0 && t <= 60)  el.classList.add('danger');
  else if (t <= 300)     el.classList.add('warn');
}

function openReviewModal() {
  const q         = state.quiz;
  const unanswered= q.questions.filter(x => !q.answers[x.id]).length;
  showModal({
    title: 'Review and Submit',
    body: `
      <p>Answered <strong>${Object.keys(q.answers).length}</strong> of <strong>${q.questions.length}</strong> questions.</p>
      ${unanswered > 0
        ? `<p class="text-danger mt-1"><i class="fa-solid fa-triangle-exclamation"></i> ${unanswered} question${unanswered > 1 ? 's' : ''} unanswered.</p>`
        : `<p class="text-success mt-1"><i class="fa-solid fa-circle-check"></i> All questions answered.</p>`}`,
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
    title: 'Submit Quiz?',
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
  await navigate('/dashboard');
}

async function submitQuiz(timeExpired = false) {
  if (!state.quiz) return;
  const q = state.quiz;
  if (state.quizTimer) clearInterval(state.quizTimer);

  let score = 0;
  q.questions.forEach(ques => { if (q.answers[ques.id] === ques.correct_answer) score++; });

  const completedPayload = {
    status:        'completed',
    answers:       q.answers,
    score,
    current_index: q.currentIndex,
    time_remaining:q.timeRemaining,
    completed_at:  new Date().toISOString(),
    time_expired:  timeExpired,
  };

  let { error } = await sb.from('quiz_sessions').update(completedPayload).eq('id', q.sessionId);
  if (error && /time_expired|schema cache|column/i.test(error.message || '')) {
    delete completedPayload.time_expired;
    ({ error } = await sb.from('quiz_sessions').update(completedPayload).eq('id', q.sessionId));
  }

  if (error) { toast('Failed to save results: ' + error.message, 'error'); return; }

  const percentage = Math.round((score / q.questions.length) * 100);
  const { grade, icon } = getGrade(percentage);
  const savedQuestions = q.questions;
  const savedAnswers   = q.answers;
  state.quiz = null;

  renderQuizResults(score, savedQuestions.length, percentage, grade, icon, savedQuestions, savedAnswers, timeExpired);
}

function renderQuizResults(score, total, percentage, grade, icon, questions, answers, timeExpired, options = {}) {
  const returnPath = options.returnPath || '/dashboard';
  const returnLabel = options.returnLabel || 'Dashboard';
  const returnIcon = options.returnIcon || 'gauge-high';
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
      <div class="result-grade"><i class="fa-solid fa-${icon}"></i> Grade: ${grade}</div>
      <p class="text-muted mb-3">
        ${timeExpired ? '<i class="fa-solid fa-clock"></i> Time expired - ' : ''}
        You answered <strong>${score}</strong> of <strong>${total}</strong> questions correctly.
      </p>
      <div style="display:flex;gap:1rem;justify-content:center;flex-wrap:wrap" class="mb-3">
        <button class="btn btn-primary btn-lg" id="results-new-quiz-btn" type="button">
          <i class="fa-solid fa-rocket"></i> New Quiz
        </button>
        <button class="btn btn-outline btn-lg" id="results-return-btn" type="button">
          <i class="fa-solid fa-${esc(returnIcon)}"></i> ${esc(returnLabel)}
        </button>
      </div>
      <hr class="divider" />
      <div style="text-align:left">
        <div class="card-title mb-2"><i class="fa-solid fa-list-check"></i> Answer Review</div>
        ${questions.map((q, i) => {
          const ua        = answers[q.id];
          const isCorrect = ua === q.correct_answer;
          const opts      = Object.entries(q.options || {});
          return `
            <div style="margin-bottom:1.5rem">
              <div style="font-weight:600;margin-bottom:0.5rem">
                Q${i + 1}. <span id="rv-q-${q.id}">${questionTextHTML(q.question_text)}</span>
              </div>
              ${questionImageHTML(q)}
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
                ${isCorrect
                  ? '<i class="fa-solid fa-circle-check"></i> Correct.'
                  : `<i class="fa-solid fa-circle-xmark"></i> You chose: ${esc(ua || '(none)')} — Correct: ${esc(q.correct_answer)}`}
              </p>
              ${q.explanation ? `<p style="font-size:0.83rem;color:var(--text-muted);font-style:italic;margin-top:0.2rem"><i class="fa-solid fa-lightbulb"></i> ${esc(q.explanation)}</p>` : ''}
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

  document.getElementById('results-new-quiz-btn')?.addEventListener('click', async () => {
    if (state.quizTimer) clearInterval(state.quizTimer);
    state.quiz = null;
    window.location.hash = '#/quiz';
    await renderQuizPage();
  });
  document.getElementById('results-return-btn')?.addEventListener('click', () => navigate(returnPath));
}

async function viewSessionSummary(sessionId, options = {}) {
  showPreloader();
  const { data: session, error } = await sb
    .from('quiz_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  hidePreloader();

  if (error || !session) {
    toast('Could not load quiz summary.', 'error');
    return;
  }
  if (session.status !== 'completed') {
    toast('Only completed quizzes have a summary to review.', 'warning');
    return;
  }

  const questions = session.questions_data || [];
  const answers = session.answers || {};
  const score = Number(session.score || 0);
  const total = Number(session.total_questions || questions.length || 0);
  const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
  const { grade, icon } = getGrade(percentage);

  renderQuizResults(score, total, percentage, grade, icon, questions, answers, isTimeExpiredSession(session), {
    returnPath: options.returnPath || (state.profile?.role === 'admin' ? '/admin' : '/history'),
    returnLabel: options.returnLabel || (state.profile?.role === 'admin' ? 'Admin' : 'History'),
    returnIcon: options.returnIcon || (state.profile?.role === 'admin' ? 'gear' : 'clock-rotate-left'),
  });
}

// ============================================================
// SECTION 10: History
// ============================================================

async function renderHistoryPage() {
  document.getElementById('root').innerHTML = headerHTML('/history') + `
    <div class="page">
      <div class="page-header">
        <h2 class="page-title"><i class="fa-solid fa-clock-rotate-left"></i> Quiz History</h2>
        <button class="btn btn-danger btn-sm" id="clear-all-btn">
          <span class="btn-spinner"></span><span class="btn-text"><i class="fa-solid fa-trash"></i> Clear All</span>
        </button>
      </div>
      <div class="tab-bar" role="tablist">
        <button class="tab-item active" data-tab="all"       role="tab">All</button>
        <button class="tab-item"        data-tab="completed" role="tab">Completed</button>
        <button class="tab-item"        data-tab="paused"    role="tab">Paused</button>
        <button class="tab-item"        data-tab="in_progress" role="tab">In Progress</button>
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
    if (currentFilter === 'in_progress') query = query.eq('status', 'in_progress');

    const { data, error } = await query;

    if (error) { container.innerHTML = alertBox(error.message); return; }
    if (!data?.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><i class="fa-solid fa-clipboard-list"></i></div>
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
      title: 'Clear All History',
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
function historyItemHTML(session, options = {}) {
  const isPaused  = session.status === 'paused';
  const isActive = session.status === 'in_progress';
  const showResume = options.showResume !== false;
  const meta = sessionStatusMeta(session);
  const scorePct  = session.total_questions > 0 ? Math.round(session.score / session.total_questions * 100) : 0;
  const progress  = `Q${(session.current_index || 0) + 1}/${session.total_questions}`;

  return `
    <div class="history-item${session.status === 'completed' ? ' reviewable' : ''}" ${session.status === 'completed' ? `data-review-row="${esc(session.id)}" role="button" tabindex="0"` : ''}>
      <span class="history-badge ${meta.cls}">
        <i class="fa-solid fa-${meta.icon}"></i> ${esc(meta.label)}
      </span>
      <div class="history-info">
        <div class="history-title">${esc(session.category || 'General')} &bull; ${session.total_questions} Qs</div>
        <div class="history-meta">${formatDate(session.created_at)}</div>
      </div>
      <div class="history-score" style="${isPaused || isActive ? 'color:var(--warning)' : ''}">
        ${isPaused || isActive ? progress : scorePct + '%'}
      </div>
      <div class="history-actions">
        ${session.status === 'completed' ? `
          <button class="btn btn-outline btn-sm" data-review="${esc(session.id)}" type="button">
            <span class="btn-text"><i class="fa-solid fa-eye"></i> Review</span>
          </button>` : ''}
        ${(isPaused || isActive) && showResume ? `
          <button class="btn btn-primary btn-sm" data-resume="${esc(session.id)}" type="button">
            <span class="btn-spinner"></span><span class="btn-text"><i class="fa-solid fa-play"></i> Resume</span>
          </button>` : ''}
        <button class="btn btn-outline btn-sm" data-delete="${esc(session.id)}" type="button"
                style="color:var(--danger);border-color:var(--danger)" aria-label="Delete session">
          <span class="btn-spinner"></span><span class="btn-text"><i class="fa-solid fa-trash"></i></span>
        </button>
      </div>
    </div>`;
}

/** Attach resume + delete event listeners inside a container element */
function bindHistoryItemActions(container, onUpdate) {
  container?.querySelectorAll('[data-review-row]').forEach(row => {
    row.addEventListener('click', event => {
      if (event.target.closest('button, a')) return;
      viewSessionSummary(row.dataset.reviewRow);
    });
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      viewSessionSummary(row.dataset.reviewRow);
    });
  });
  container?.querySelectorAll('[data-review]').forEach(btn => {
    btn.addEventListener('click', () => viewSessionSummary(btn.dataset.review));
  });
  container?.querySelectorAll('[data-resume]').forEach(btn => {
    btn.addEventListener('click', () => resumeQuiz(btn.dataset.resume));
  });
  container?.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteSession(btn.dataset.delete, onUpdate));
  });
}

function deleteSession(id, callback) {
  showModal({
    title: 'Delete Quiz',
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
      <div class="page-header"><h2 class="page-title"><i class="fa-solid fa-gear"></i> Admin Panel</h2></div>
      <div class="tab-bar" role="tablist">
        <button class="tab-item active" data-tab="questions" role="tab">Questions</button>
        <button class="tab-item"        data-tab="users"     role="tab">Users</button>
        <button class="tab-item"        data-tab="history"   role="tab">Quiz History</button>
        <button class="tab-item"        data-tab="invite"    role="tab">Invite</button>
      </div>
      <div id="admin-content">
        <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>
      </div>
    </div>`;

  const tabLoaders = {
    questions: () => renderQuestionsTab(document.getElementById('admin-content')),
    users:     () => renderUsersTab(document.getElementById('admin-content')),
    history:   () => renderAdminHistoryTab(document.getElementById('admin-content')),
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
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:1rem;flex-wrap:wrap">
        <div class="admin-section-title">MCQ Questions</div>
        <button class="btn btn-primary btn-sm" id="add-q-btn" type="button">
          <span class="btn-spinner"></span><span class="btn-text">+ Add Question</span>
        </button>
      </div>
      <div class="bulk-toolbar">
        <label class="bulk-select-all" for="question-category-filter">
          <i class="fa-solid fa-filter"></i>
          <span>Category</span>
        </label>
        <select class="form-input question-filter-select" id="question-category-filter">
          <option value="">All categories</option>
        </select>
        <span class="text-muted" style="font-size:0.82rem">Drag questions by the handle to reorder the current list.</span>
      </div>
      <div id="questions-list">
        <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>
      </div>
    </div>`;

  document.getElementById('add-q-btn')?.addEventListener('click', () => showQuestionModal(null));
  await populateQuestionCategoryFilter();
  document.getElementById('question-category-filter')?.addEventListener('change', event => {
    loadQuestions(event.target.value);
  });
  await loadQuestions();
}

async function populateQuestionCategoryFilter() {
  const sel = document.getElementById('question-category-filter');
  if (!sel) return;

  const { data, error } = await sb.from('questions').select('category').not('category', 'is', null);
  if (error) return;

  const current = sel.value;
  const categories = [...new Set((data || []).map(row => row.category).filter(Boolean))].sort();
  sel.innerHTML = `
    <option value="">All categories</option>
    ${categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('')}`;
  sel.value = categories.includes(current) ? current : '';
}

async function loadQuestions(category = document.getElementById('question-category-filter')?.value || '') {
  const container = document.getElementById('questions-list');
  if (!container) return;

  let query = sb.from('questions').select('*');
  if (category) query = query.eq('category', category);
  let { data, error } = await query
    .order('display_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error && /display_order|schema cache|column/i.test(error.message || '')) {
    query = sb.from('questions').select('*');
    if (category) query = query.eq('category', category);
    ({ data, error } = await query.order('created_at', { ascending: false }));
  }

  if (error) { container.innerHTML = alertBox(error.message); return; }
  if (!data?.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fa-solid fa-circle-question"></i></div>
        <div class="empty-state-title">${category ? 'No questions in this category' : 'No questions yet'}</div>
        <p class="text-muted">${category ? 'Choose another category or add a new question.' : 'Click "Add Question" to get started.'}</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="bulk-toolbar" id="question-bulk-toolbar">
      <label class="bulk-select-all">
        <input type="checkbox" id="select-all-questions" />
        <span>Select all</span>
      </label>
      <span class="text-muted" id="selected-question-count">0 selected</span>
      <button class="btn btn-danger btn-sm" id="bulk-delete-questions-btn" type="button" disabled>
        <span class="btn-spinner"></span>
        <span class="btn-text"><i class="fa-solid fa-trash"></i> Delete selected</span>
      </button>
    </div>
    ${data.map(q => `
    <div class="question-item" draggable="true" data-question-id="${esc(q.id)}">
      <div class="question-item-header">
        <button class="drag-handle" type="button" aria-label="Drag to reorder" title="Drag to reorder">
          <i class="fa-solid fa-grip-vertical"></i>
        </button>
        <label class="question-select" aria-label="Select question">
          <input type="checkbox" class="question-check" value="${esc(q.id)}" />
        </label>
        <div class="question-item-text" id="qi-${q.id}">
          <div>${questionTextHTML(q.question_text)}</div>
          ${q.image_url ? '<div class="question-preview-thumb"><i class="fa-solid fa-image"></i> Image attached</div>' : ''}
        </div>
        <div class="question-item-actions">
          <span style="font-size:0.72rem;color:var(--text-muted);padding:0.18rem 0.5rem;background:var(--bg);border-radius:4px;white-space:nowrap">
            ${esc(q.category || 'General')}
          </span>
          <button class="btn btn-outline btn-sm" data-preview="${esc(q.id)}" type="button" aria-label="Preview question">
            <i class="fa-solid fa-eye"></i>
          </button>
          <button class="btn btn-outline btn-sm" data-edit="${esc(q.id)}" type="button" aria-label="Edit question">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="btn btn-outline btn-sm" data-del="${esc(q.id)}"  type="button"
                  style="color:var(--danger);border-color:var(--danger)" aria-label="Delete question">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    </div>`).join('')}`;

  // KaTeX on question previews
  data.forEach(q => {
    const el = document.getElementById(`qi-${q.id}`);
    if (el) renderKaTeX(el);
  });

  // Edit
  container.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = data.find(x => x.id === btn.dataset.preview);
      if (q) showQuestionPreviewModal(q);
    });
  });

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
        title: 'Delete Question',
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

  const selectAll = document.getElementById('select-all-questions');
  const checks = Array.from(container.querySelectorAll('.question-check'));
  const selectedCount = document.getElementById('selected-question-count');
  const bulkDeleteBtn = document.getElementById('bulk-delete-questions-btn');

  function updateBulkState() {
    const count = checks.filter(ch => ch.checked).length;
    if (selectedCount) selectedCount.textContent = `${count} selected`;
    if (bulkDeleteBtn) bulkDeleteBtn.disabled = count === 0;
    if (selectAll) {
      selectAll.checked = count > 0 && count === checks.length;
      selectAll.indeterminate = count > 0 && count < checks.length;
    }
  }

  selectAll?.addEventListener('change', () => {
    checks.forEach(ch => { ch.checked = selectAll.checked; });
    updateBulkState();
  });
  checks.forEach(ch => ch.addEventListener('change', updateBulkState));
  bulkDeleteBtn?.addEventListener('click', () => {
    const ids = checks.filter(ch => ch.checked).map(ch => ch.value);
    if (!ids.length) return;
    showModal({
      title: 'Delete Selected Questions',
      body: `<p>Permanently delete <strong>${ids.length}</strong> selected question${ids.length === 1 ? '' : 's'}? This cannot be undone.</p>`,
      actions: [
        { id: 'cancel', label: 'Cancel', cls: 'btn-outline', handler: (_, close) => close() },
        {
          id: 'delete', label: 'Delete Questions', cls: 'btn-danger',
          handler: async (btn, close) => {
            btnLoading(btn, true);
            const { error } = await sb.from('questions').delete().in('id', ids);
            btnLoading(btn, false);
            close();
            if (error) toast(error.message, 'error');
            else {
              toast(`${ids.length} question${ids.length === 1 ? '' : 's'} deleted.`, 'success');
              loadQuestions();
            }
          },
        },
      ],
    });
  });
  updateBulkState();
  bindQuestionDragAndDrop(container, category);
}

function bindQuestionDragAndDrop(container, category) {
  let dragged = null;

  container.querySelectorAll('.question-item[draggable="true"]').forEach(item => {
    item.addEventListener('dragstart', event => {
      dragged = item;
      item.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', item.dataset.questionId || '');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      container.querySelectorAll('.question-item.drag-over').forEach(el => el.classList.remove('drag-over'));
      persistQuestionOrder(container, category);
      dragged = null;
    });
    item.addEventListener('dragover', event => {
      event.preventDefault();
      if (!dragged || dragged === item) return;
      const rect = item.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      item.classList.add('drag-over');
      if (after) item.after(dragged);
      else item.before(dragged);
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', event => {
      event.preventDefault();
      item.classList.remove('drag-over');
    });
  });
}

async function persistQuestionOrder(container, category) {
  const ids = Array.from(container.querySelectorAll('.question-item[data-question-id]'))
    .map(item => item.dataset.questionId)
    .filter(Boolean);
  if (!ids.length) return;

  const updates = ids.map((id, index) =>
    sb.from('questions').update({ display_order: index + 1 }).eq('id', id)
  );
  const results = await Promise.all(updates);
  const error = results.find(result => result.error)?.error;
  if (error) {
    if (/display_order|schema cache|column/i.test(error.message || '')) {
      toast('Run the display_order schema update before question order can be saved.', 'warning', 5200);
    } else {
      toast('Could not save question order: ' + error.message, 'error');
    }
    loadQuestions(category);
    return;
  }
  toast('Question order saved.', 'success', 1800);
}

function showQuestionModal(existing) {
  const isEdit = !!existing;
  const opts   = existing?.options || { A: '', B: '', C: '', D: '' };

  showModal({
    title: isEdit ? 'Edit Question' : 'Add Question',
    body: `
      <div class="form-group">
        <label class="form-label">Question Text <small style="font-weight:400;text-transform:none">(LaTeX: $...$  or  $$...$$)</small></label>
        <div class="editor-toolbar" aria-label="Question formatting toolbar">
          <button class="btn btn-outline btn-sm" type="button" data-editor-cmd="bold" title="Bold"><i class="fa-solid fa-bold"></i></button>
          <button class="btn btn-outline btn-sm" type="button" data-editor-cmd="italic" title="Italic"><i class="fa-solid fa-italic"></i></button>
          <button class="btn btn-outline btn-sm" type="button" data-editor-cmd="insertUnorderedList" title="Bullets"><i class="fa-solid fa-list-ul"></i></button>
          <button class="btn btn-outline btn-sm" type="button" data-editor-cmd="insertOrderedList" title="Numbered list"><i class="fa-solid fa-list-ol"></i></button>
          <button class="btn btn-outline btn-sm" type="button" data-editor-cmd="highlight" title="Highlight"><i class="fa-solid fa-highlighter"></i></button>
        </div>
        <div class="rich-editor" id="qm-text" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Enter question...">${questionTextHTML(existing?.question_text || '')}</div>
      </div>
      <div class="form-group">
        <label class="form-label" for="qm-image">Question Image <small style="font-weight:400;text-transform:none">(optional)</small></label>
        <input class="form-input" type="file" id="qm-image" accept="image/*" />
        <input type="hidden" id="qm-image-url" value="${esc(existing?.image_url || '')}" />
        <div class="form-hint">Uploads use the public <code>${QUESTION_IMAGE_BUCKET}</code> Supabase Storage bucket.</div>
        <div id="qm-image-preview" class="question-image-preview">
          ${existing?.image_url ? questionImageHTML(existing) : ''}
        </div>
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
      </div>
      <div class="form-group">
        <label class="form-label">Live Preview</label>
        <div class="question-live-preview" id="qm-live-preview"></div>
      </div>`,
    actions: [
      { id: 'cancel', label: 'Cancel', cls: 'btn-outline', handler: (_, c) => c() },
      {
        id: 'save', label: isEdit ? 'Save Changes' : 'Add Question', cls: 'btn-primary',
        handler: async (btn, close) => {
          const editor = document.getElementById('qm-text');
          const qText = sanitizeQuestionHTML(editor?.innerHTML || '');
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
          let imageUrl = document.getElementById('qm-image-url')?.value || null;
          const imageFile = document.getElementById('qm-image')?.files?.[0];
          if (imageFile) {
            try {
              imageUrl = await uploadQuestionImage(imageFile);
            } catch (err) {
              btnLoading(btn, false);
              toast(err.message || 'Image upload failed.', 'error', 5200);
              return;
            }
          }
          const payload = {
            question_text: qText,
            options:       { A: optA, B: optB, C: optC, D: optD },
            correct_answer:correct,
            category:      category || null,
            explanation:   exp || null,
            image_url:     imageUrl || null,
            created_by:    state.user.id,
          };

          let { error } = isEdit
            ? await sb.from('questions').update(payload).eq('id', existing.id)
            : await sb.from('questions').insert(payload);

          if (error && /image_url|schema cache|column/i.test(error.message || '')) {
            delete payload.image_url;
            ({ error } = isEdit
              ? await sb.from('questions').update(payload).eq('id', existing.id)
              : await sb.from('questions').insert(payload));
          }

          btnLoading(btn, false);
          if (error) { toast(error.message, 'error'); return; }
          close();
          toast(isEdit ? 'Question updated!' : 'Question added!', 'success');
          loadQuestions();
        },
      },
    ],
  });

  setupQuestionEditor();
}

function setupQuestionEditor() {
  const editor = document.getElementById('qm-text');
  const preview = document.getElementById('qm-live-preview');
  const imageInput = document.getElementById('qm-image');
  const imagePreview = document.getElementById('qm-image-preview');
  if (!editor || !preview) return;

  function updatePreview() {
    const html = sanitizeQuestionHTML(editor.innerHTML);
    const imageUrl = document.getElementById('qm-image-url')?.value;
    preview.innerHTML = `
      <div class="question-text">${html || '<span class="text-muted">Question preview appears here.</span>'}</div>
      ${imageUrl ? `<img class="question-image" src="${esc(imageUrl)}" alt="Question preview image" />` : ''}`;
    renderKaTeX(preview);
  }

  document.querySelectorAll('[data-editor-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      editor.focus();
      const cmd = btn.dataset.editorCmd;
      if (cmd === 'highlight') {
        document.execCommand('backColor', false, '#fff3bf');
      } else {
        document.execCommand(cmd, false, null);
      }
      updatePreview();
    });
  });

  editor.addEventListener('input', updatePreview);
  imageInput?.addEventListener('change', () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Please choose an image file.', 'error');
      imageInput.value = '';
      return;
    }
    const localUrl = URL.createObjectURL(file);
    if (imagePreview) {
      imagePreview.innerHTML = `<img class="question-image" src="${localUrl}" alt="Selected question image preview" />`;
    }
  });

  updatePreview();
}

async function uploadQuestionImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Images must be 5 MB or smaller.');

  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const path = `${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { data, error } = await sb.storage
    .from(QUESTION_IMAGE_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      contentType: file.type,
      upsert: false,
    });

  if (error) throw new Error(error.message);

  const { data: publicData } = sb.storage
    .from(QUESTION_IMAGE_BUCKET)
    .getPublicUrl(data.path);
  if (!publicData?.publicUrl) throw new Error('Image uploaded, but no public URL was returned.');
  return publicData?.publicUrl;
}

function showQuestionPreviewModal(q) {
  const opts = Object.entries(q.options || {});
  showModal({
    title: 'Question Preview',
    body: `
      <div class="question-text mb-2">${questionTextHTML(q.question_text)}</div>
      ${questionImageHTML(q)}
      <div class="options-list mt-2">
        ${opts.map(([label, text]) => `
          <div class="option-btn ${label === q.correct_answer ? 'correct' : ''}" style="cursor:default">
            <div class="option-label">${esc(label)}</div>
            <div>${text}</div>
          </div>`).join('')}
      </div>
      ${q.explanation ? `<p class="text-muted mt-2"><i class="fa-solid fa-lightbulb"></i> ${esc(q.explanation)}</p>` : ''}`,
    actions: [
      { id: 'close', label: 'Close', cls: 'btn-primary', handler: (_, close) => close() },
    ],
  });
  renderKaTeX(document.getElementById('modal-container'));
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
                <td>
                  <button class="btn btn-ghost btn-sm" data-view-user="${esc(u.id)}" type="button">
                    <i class="fa-solid fa-user"></i> ${esc(u.full_name || '—')}
                  </button>
                </td>
                <td>
                  <button class="btn btn-ghost btn-sm" data-view-user="${esc(u.id)}" type="button">
                    ${esc(u.email || '—')}
                  </button>
                </td>
                <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-student'}">${esc(u.role || 'student')}</span></td>
                <td>${formatDate(u.created_at)}</td>
                <td>
                  <div style="display:flex;gap:0.45rem;flex-wrap:wrap">
                    <button class="btn btn-outline btn-sm" data-toggle-role="${esc(u.id)}"
                            data-cur-role="${esc(u.role || 'student')}" type="button">
                      <span class="btn-spinner"></span>
                      <span class="btn-text">${u.role === 'admin' ? '↓ Student' : '↑ Admin'}</span>
                    </button>
                    ${u.role !== 'admin' ? `
                      <button class="btn btn-danger btn-sm" data-delete-user="${esc(u.id)}"
                              data-user-email="${esc(u.email || '')}" type="button">
                        <span class="btn-spinner"></span>
                        <span class="btn-text"><i class="fa-solid fa-user-xmark"></i> Delete</span>
                      </button>` : ''}
                  </div>
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

  container.querySelectorAll('[data-view-user]').forEach(btn => {
    btn.addEventListener('click', () => {
      const user = (data || []).find(u => u.id === btn.dataset.viewUser);
      if (user) renderUserProfileView(container, user);
    });
  });

  container.querySelectorAll('[data-delete-user]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteUser;
      const email = btn.dataset.userEmail || 'this student';
      showModal({
        title: 'Delete Student Account',
        body: `<p>This will permanently delete <strong>${esc(email)}</strong>, including their profile and quiz history. This cannot be undone.</p>`,
        actions: [
          { id: 'cancel', label: 'Cancel', cls: 'btn-outline', handler: (_, close) => close() },
          {
            id: 'delete', label: 'Delete Student', cls: 'btn-danger',
            handler: async (modalBtn, close) => {
              btnLoading(modalBtn, true);
              try {
                const { data: { session } } = await sb.auth.getSession();
                if (!session?.access_token) throw new Error('Please sign in again before deleting a user.');

                const res = await fetch('/.netlify/functions/delete-user', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                  },
                  body: JSON.stringify({ userId: id }),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(json.error || 'Delete failed');
                close();
                toast('Student account deleted.', 'success');
                renderUsersTab(container);
              } catch (err) {
                toast(err.message || 'Delete failed', 'error');
                btnLoading(modalBtn, false);
              }
            },
          },
        ],
      });
    });
  });
}

async function renderUserProfileView(container, user) {
  container.innerHTML = `
    <div class="admin-section">
      <div class="page-header">
        <div>
          <button class="btn btn-ghost btn-sm mb-1" id="back-to-users-btn" type="button">
            <i class="fa-solid fa-arrow-left"></i> Users
          </button>
          <h3 class="page-title" style="font-size:1.35rem;margin:0">${esc(user.full_name || user.email || 'User')}</h3>
          <p class="text-muted" style="margin:0.25rem 0 0">${esc(user.email || '')}</p>
        </div>
        <span class="role-badge ${user.role === 'admin' ? 'role-admin' : 'role-student'}">${esc(user.role || 'student')}</span>
      </div>
      <div id="user-profile-content">
        <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>
      </div>
    </div>`;

  document.getElementById('back-to-users-btn')?.addEventListener('click', () => renderUsersTab(container));

  const content = document.getElementById('user-profile-content');
  const { data: sessions, error } = await sb
    .from('quiz_sessions')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    content.innerHTML = alertBox(error.message);
    return;
  }

  const stats = computeQuizStats(sessions || []);
  content.innerHTML = `
    <div class="stats-grid">
      ${statCard('trophy', stats.total, 'Completed')}
      ${statCard('chart-line', stats.avgPct + '%', 'Average Score')}
      ${statCard('star', stats.bestPct + '%', 'Best Score')}
      ${statCard('pen', stats.answered, 'Questions Answered')}
      ${statCard('pause', stats.paused.length, 'Paused')}
      ${statCard('spinner', stats.inProgress.length, 'In Progress')}
    </div>
    <div class="card mb-2">
      ${renderAverageScoreChart(sessions || [], 'Average Score Over Time')}
    </div>
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="fa-solid fa-clock-rotate-left"></i> Quiz History</div>
        <button class="btn btn-outline btn-sm" id="export-user-history-btn" type="button">
          <i class="fa-solid fa-file-csv"></i> Export CSV
        </button>
      </div>
      ${(sessions || []).length
        ? `<div class="history-list">${sessions.map(session => historyItemHTML(session, { showResume: false })).join('')}</div>`
        : `<div class="empty-state">
            <div class="empty-state-icon"><i class="fa-solid fa-clipboard-list"></i></div>
            <div class="empty-state-title">No quiz history</div>
          </div>`}
    </div>`;

  bindHistoryItemActions(content, () => renderUserProfileView(container, user));
  document.getElementById('export-user-history-btn')?.addEventListener('click', () => {
    const profilesById = new Map([[user.id, user]]);
    const slug = (user.email || user.full_name || user.id || 'user').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    downloadCSV(`studytool-${slug || 'user'}-quiz-history.csv`, sessionCSVRows(sessions || [], profilesById));
  });
}

async function renderAdminHistoryTab(container) {
  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-title">Quiz History</div>
      <div class="text-center mt-3"><div class="spinner-ring" style="margin:auto"></div></div>
    </div>`;

  const [{ data: profiles, error: profilesError }, { data: sessions, error: sessionsError }] = await Promise.all([
    sb.from('profiles').select('id,email,full_name,role'),
    sb.from('quiz_sessions').select('*').order('created_at', { ascending: false }),
  ]);

  if (profilesError || sessionsError) {
    container.innerHTML = alertBox(profilesError?.message || sessionsError?.message || 'Could not load quiz history.');
    return;
  }

  const profilesById = new Map((profiles || []).map(profile => [profile.id, profile]));
  const allSessions = sessions || [];
  const activeSessions = allSessions.filter(session => session.status === 'in_progress' || session.status === 'paused');
  const inProgress = activeSessions.filter(session => session.status === 'in_progress');
  const paused = activeSessions.filter(session => session.status === 'paused');
  const completed = allSessions.filter(session => session.status === 'completed');
  const userOptions = (profiles || [])
    .slice()
    .sort((a, b) => (a.full_name || a.email || '').localeCompare(b.full_name || b.email || ''))
    .map(profile => `<option value="${esc(profile.id)}">${esc(profile.full_name || profile.email || profile.id)}${profile.email ? ` (${esc(profile.email)})` : ''}</option>`)
    .join('');

  container.innerHTML = `
    <div class="admin-section">
      <div class="page-header">
        <div>
          <div class="admin-section-title" style="margin-bottom:0.35rem">Quiz History</div>
          <h3 class="page-title" style="font-size:1.25rem;margin:0">All User Sessions</h3>
        </div>
        <div class="history-export-controls">
          <select class="form-input" id="export-user-select" aria-label="Choose user for CSV export">
            <option value="">All users</option>
            ${userOptions}
          </select>
          <button class="btn btn-primary btn-sm" id="export-history-csv-btn" type="button">
            <i class="fa-solid fa-file-csv"></i> Export CSV
          </button>
        </div>
      </div>

      <div class="stats-grid">
        ${statCard('spinner', inProgress.length, 'In Progress')}
        ${statCard('pause', paused.length, 'Paused')}
        ${statCard('circle-check', completed.length, 'Completed')}
        ${statCard('clock', allSessions.filter(isTimeExpiredSession).length, 'Timed Out')}
      </div>

      <div class="card mb-2">
        <div class="card-header">
          <div class="card-title"><i class="fa-solid fa-hourglass-half"></i> Active Quizzes</div>
        </div>
        ${activeSessions.length
          ? `<div class="history-list">${activeSessions.map(session => {
              const meta = sessionStatusMeta(session);
              return `
              <div class="history-item">
                <span class="history-badge ${meta.cls}"><i class="fa-solid fa-${meta.icon}"></i> ${esc(meta.label)}</span>
                <div class="history-info">
                  <div class="history-title">${esc(getSessionDisplayName(session, profilesById))}</div>
                  <div class="history-meta">${esc(session.category || 'General')} &bull; ${formatDate(session.started_at || session.created_at)}</div>
                </div>
                <div class="history-score" style="color:var(--warning)">
                  <span style="display:block">Q${(session.current_index || 0) + 1}/${session.total_questions || 0}</span>
                  <span class="history-meta">${formatTime(session.time_remaining || 0)} left</span>
                </div>
              </div>`;
            }).join('')}</div>`
          : `<div class="empty-state" style="padding:2rem 1rem">
              <div class="empty-state-title">No paused or in-progress quizzes</div>
            </div>`}
      </div>

      <div class="card mb-2">
        ${renderAverageScoreChart(completed, 'Overall Average Score Over Time')}
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><i class="fa-solid fa-table"></i> Exportable Quiz History</div>
          <span class="text-muted" style="font-size:0.85rem">${allSessions.length} sessions</span>
        </div>
        <div class="table-wrap">
          <table class="data-table session-table">
            <thead>
              <tr>
                <th>User</th><th>Status</th><th>Score</th><th>Category</th><th>Progress</th><th>Time Remaining</th><th>Started</th><th>Completed</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${allSessions.map(session => {
                const meta = sessionStatusMeta(session);
                return `
                  <tr>
                    <td>
                      <div style="font-weight:600">${esc(getSessionDisplayName(session, profilesById))}</div>
                      <div class="text-muted" style="font-size:0.78rem">${esc(profilesById.get(session.user_id)?.email || '')}</div>
                    </td>
                    <td><span class="history-badge ${meta.cls}"><i class="fa-solid fa-${meta.icon}"></i> ${esc(meta.label)}</span></td>
                    <td>${session.status === 'completed' ? `${esc(session.score || 0)}/${esc(session.total_questions || 0)} (${pct(session)}%)` : '—'}</td>
                    <td>${esc(session.category || 'General')}</td>
                    <td>${Object.keys(session.answers || {}).length}/${esc(session.total_questions || 0)} answered</td>
                    <td>${formatTime(session.time_remaining || 0)} / ${formatTime(session.time_limit || 0)}</td>
                    <td>${formatDate(session.started_at || session.created_at)}</td>
                    <td>${formatDate(session.completed_at)}</td>
                    <td>
                      ${session.status === 'completed' ? `
                        <button class="btn btn-outline btn-sm" data-review="${esc(session.id)}" type="button">
                          <i class="fa-solid fa-eye"></i> Review
                        </button>` : '—'}
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  document.getElementById('export-history-csv-btn')?.addEventListener('click', () => {
    const selectedUserId = document.getElementById('export-user-select')?.value || '';
    const exportSessions = selectedUserId
      ? allSessions.filter(session => session.user_id === selectedUserId)
      : allSessions;
    const profile = profilesById.get(selectedUserId);
    const slugBase = selectedUserId ? (profile?.email || profile?.full_name || selectedUserId) : 'all-users';
    const slug = slugBase.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    downloadCSV(`studytool-${slug || 'quiz'}-history-${new Date().toISOString().slice(0, 10)}.csv`, sessionCSVRows(exportSessions, profilesById));
  });
  bindHistoryItemActions(container, () => renderAdminHistoryTab(container));
}

// ── Invite tab ──
function renderInviteTab(container) {
  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-title">Invite a New Student</div>
      <div class="card" style="max-width:500px">
        <div class="info-box mb-2">
          <i class="fa-solid fa-envelope"></i> Invited students receive an email with a link that directs them to set their password
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
          <span class="btn-spinner"></span><span class="btn-text"><i class="fa-solid fa-paper-plane"></i> Send Invitation</span>
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
          redirectTo: `${location.origin}/set-password.html`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Invite failed');
      alertEl.style.cssText = 'display:block;background:#ebfbee;color:#2f9e44;border:1px solid #b2f2bb;border-radius:8px;padding:0.7rem 0.85rem;font-size:0.85rem;margin-bottom:1rem';
      alertEl.textContent   = `Invitation sent to ${email}.`;
      document.getElementById('inv-email').value = '';
      document.getElementById('inv-name').value  = '';
    } catch (err) {
      alertEl.style.cssText = 'display:block;background:#fff5f5;color:var(--danger);border:1px solid #ffc9c9;border-radius:8px;padding:0.7rem 0.85rem;font-size:0.85rem;margin-bottom:1rem';
      alertEl.textContent   = err.message;
    }
    btnLoading(btn, false);
  });
}

// ============================================================
// SECTION 12: App Bootstrap
// ============================================================

async function initializeAppWithConfig() {
  try {
    if (typeof window.loadStudyToolConfig !== 'function') {
      throw new Error('Config loader missing. Ensure config-loader.js is included.');
    }
    const config = await window.loadStudyToolConfig();
    APP.name = config.appName || APP.name;
    APP.supabaseUrl = config.supabaseUrl;
    APP.supabaseKey = config.supabaseAnonKey;
    APP.defaultQuizTime = config.defaultQuizTime || APP.defaultQuizTime;
    sb = window.supabase.createClient(APP.supabaseUrl, APP.supabaseKey);
  } catch (err) {
    renderConfigError(err.message);
    return;
  }

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
      window.location.replace('login.html');
    }
  });

  // Run the router once on load
  await router();
}

// Kick off
initializeAppWithConfig().catch(err => {
  console.error('StudyTool init error:', err);
  hidePreloader();
});
