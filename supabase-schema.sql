-- =============================================================
-- File: supabase-schema.sql
-- StudyTool — Supabase Database Schema
--
-- Run this in your Supabase project:
--   Dashboard → SQL Editor → New Query → Paste & Run
-- =============================================================

-- ─── Enable UUID extension ───────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Profiles ────────────────────────────────────────────────
-- Mirrors auth.users with an extra `role` column.
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email      TEXT,
  full_name  TEXT,
  role       TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create a profile row when a new user signs up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'student'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ─── Questions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_text  TEXT NOT NULL,
  -- options stored as JSON object: {"A":"…","B":"…","C":"…","D":"…"}
  options        JSONB NOT NULL DEFAULT '{}',
  correct_answer TEXT NOT NULL CHECK (correct_answer IN ('A','B','C','D')),
  explanation    TEXT,
  category       TEXT,
  difficulty     TEXT DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  created_by     UUID REFERENCES auth.users ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Quiz Sessions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','paused','completed')),
  -- Full snapshot of questions at quiz-start (avoids joins on review)
  questions_data  JSONB NOT NULL DEFAULT '[]',
  -- Map of question_id → selected label, e.g. {"uuid-1":"A","uuid-2":"C"}
  answers         JSONB NOT NULL DEFAULT '{}',
  current_index   INTEGER NOT NULL DEFAULT 0,
  score           INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  time_remaining  INTEGER NOT NULL DEFAULT 0,   -- seconds left when paused/completed
  time_limit      INTEGER NOT NULL DEFAULT 1800, -- seconds (0 = no limit)
  category        TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Row-Level Security ──────────────────────────────────────

ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_sessions ENABLE ROW LEVEL SECURITY;

-- profiles: users can read their own; admins can read all
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "profiles_select_admin" ON profiles
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

CREATE POLICY "profiles_update_admin" ON profiles
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- questions: anyone authenticated can read; only admins can write
CREATE POLICY "questions_read_authenticated" ON questions
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "questions_write_admin" ON questions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- quiz_sessions: users see only their own rows
CREATE POLICY "sessions_own" ON quiz_sessions
  FOR ALL USING (auth.uid() = user_id);

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_quiz_sessions_user_id ON quiz_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_sessions_status  ON quiz_sessions (status);
CREATE INDEX IF NOT EXISTS idx_questions_category    ON questions     (category);
