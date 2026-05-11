# StudyTool — MCQ Practice Web App

A **production-ready, static HTML/CSS/JS** study tool for multiple-choice questions, powered by [Supabase](https://supabase.com) and deployable to [Netlify](https://netlify.com) with **zero build step**.

---

## Features

| Feature | Details |
|---|---|
| 🔐 Auth | Modal-based login, registration, password reset & invite flow |
| 📝 Quiz Engine | Timed quizzes with pause / resume, shuffle, category filter |
| 📊 Student Stats | Dashboard with totals, average %, best score |
| 📖 History | Full history with per-item delete and bulk clear |
| ⚙️ Admin Panel | Add / edit / delete questions, manage users, invite students |
| 🧮 KaTeX | Math rendered in questions and review screens |
| 💫 UX Polish | Page-level preloader, per-button spinners, toast notifications |
| 📱 Responsive | Mobile-first layout, hamburger nav on small screens |

---

## Quick Start

### 1. Supabase Setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run the full contents of [`supabase-schema.sql`](./supabase-schema.sql).
3. In **Authentication → Email Templates**, set the **Confirm email** redirect URL to your Netlify URL.
4. In **Authentication → URL Configuration**, add your Netlify domain to "Site URL" and "Redirect URLs".

### 2. Configure the App

Edit `config.js` and replace the placeholder values:

```js
window.SUPABASE_URL      = 'https://your-project-ref.supabase.co';
window.SUPABASE_ANON_KEY = 'your-anon-key-here';
```

> ⚠️ **Never commit real keys** to a public repository. For production use, consider a `.env`-based approach or Netlify's environment variable injection.

### 3. Deploy to Netlify

**Option A — Netlify CLI:**
```bash
npm install -g netlify-cli
netlify login
netlify deploy --prod
```

**Option B — Netlify Dashboard:**
1. Push this repo to GitHub.
2. In Netlify: **Add new site → Import from Git**.
3. Publish directory: `.` (repo root), no build command.
4. Add environment variables (for the invite function):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` ← from **Project Settings → API → service_role secret**

### 4. Create the First Admin

After deploying:
1. Register normally via the app.
2. In Supabase Dashboard → **Table Editor → profiles**, manually set your user's `role` to `admin`.
3. Refresh the app — you'll see the Admin tab in the nav.

---

## File Structure

```
├── index.html                      # SPA shell
├── style.css                       # All styles
├── main.js                         # All app logic (router, auth, quiz, admin …)
├── config.js                       # Supabase keys (edit this)
├── netlify.toml                    # Netlify config
├── supabase-schema.sql             # Database schema + RLS policies
└── netlify/
    └── functions/
        ├── invite-user.js          # Serverless invite endpoint
        └── package.json
```

---

## KaTeX Math Syntax

Questions support inline and display math:

| Syntax | Renders as |
|---|---|
| `$x^2 + y^2$` | Inline math |
| `$$\int_0^\infty e^{-x}\,dx$$` | Display math |
| `\( \frac{a}{b} \)` | Inline (alt) |
| `\[ E = mc^2 \]` | Display (alt) |

---

## License

MIT
