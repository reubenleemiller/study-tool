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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create a profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'student',
    NOW()
  )
  ON CONFLICT (id) DO UPDATE
  SET email      = EXCLUDED.email,
      full_name  = EXCLUDED.full_name,
      updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Keep profile fields in sync when auth.users changes
CREATE OR REPLACE FUNCTION public.handle_user_updated()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles
  SET email      = NEW.email,
      full_name  = COALESCE(NEW.raw_user_meta_data->>'full_name', public.profiles.full_name),
      updated_at = NOW()
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE OF email, raw_user_meta_data ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_updated();

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
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── updated_at trigger helper ─────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_profiles_updated_at ON profiles;
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_questions_updated_at ON questions;
CREATE TRIGGER set_questions_updated_at
  BEFORE UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_quiz_sessions_updated_at ON quiz_sessions;
CREATE TRIGGER set_quiz_sessions_updated_at
  BEFORE UPDATE ON quiz_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_user_updated() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.handle_user_updated() TO supabase_auth_admin;

-- ─── Constraints & additional indexes ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_options_keys') THEN
    ALTER TABLE questions
      ADD CONSTRAINT questions_options_keys
      CHECK (
        jsonb_typeof(options) = 'object' AND
        options ?& ARRAY['A','B','C','D']
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_correct_answer_key') THEN
    ALTER TABLE questions
      ADD CONSTRAINT questions_correct_answer_key
      CHECK (options ? correct_answer);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_sessions_non_negative') THEN
    ALTER TABLE quiz_sessions
      ADD CONSTRAINT quiz_sessions_non_negative
      CHECK (
        score >= 0 AND
        total_questions >= 0 AND
        current_index >= 0 AND
        time_remaining >= 0 AND
        time_limit >= 0 AND
        score <= total_questions
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_sessions_completed_at') THEN
    ALTER TABLE quiz_sessions
      ADD CONSTRAINT quiz_sessions_completed_at
      CHECK (status <> 'completed' OR completed_at IS NOT NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email_lower ON profiles (lower(email));

-- ─── Row-Level Security ──────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.is_admin(user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = user_id
      AND p.role = 'admin'
  );
$$;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;
REVOKE ALL ON FUNCTION private.is_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_admin(UUID) TO authenticated;

ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_sessions ENABLE ROW LEVEL SECURITY;

-- profiles: users can read their own; admins can read all
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = id);

CREATE POLICY "profiles_select_admin" ON profiles
  FOR SELECT TO authenticated USING ((SELECT private.is_admin(auth.uid())));

CREATE POLICY "profiles_update_admin" ON profiles
  FOR UPDATE TO authenticated
  USING ((SELECT private.is_admin(auth.uid())))
  WITH CHECK ((SELECT private.is_admin(auth.uid())));

-- questions: anyone authenticated can read; only admins can write
CREATE POLICY "questions_read_authenticated" ON questions
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "questions_write_admin" ON questions
  FOR ALL TO authenticated
  USING ((SELECT private.is_admin(auth.uid())))
  WITH CHECK ((SELECT private.is_admin(auth.uid())));

-- quiz_sessions: users see only their own rows
CREATE POLICY "sessions_own" ON quiz_sessions
  FOR ALL USING (auth.uid() = user_id);

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_quiz_sessions_user_id ON quiz_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_sessions_status  ON quiz_sessions (status);
CREATE INDEX IF NOT EXISTS idx_questions_category    ON questions     (category);
