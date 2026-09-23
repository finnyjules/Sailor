-- frontend/server/db/schema.sql
-- Accounts spec §4. Idempotent (IF NOT EXISTS) so tests and boot can re-run it.
-- 1 credit = $0.01, integer credits only.

CREATE TABLE IF NOT EXISTS users (
  id         text PRIMARY KEY,          -- Clerk user id
  email      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id          text PRIMARY KEY REFERENCES users(id),
  balance_credits  integer NOT NULL DEFAULT 0,
  reserved_credits integer NOT NULL DEFAULT 0,  -- sum of open holds
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_reserved_nonneg CHECK (reserved_credits >= 0)
);

-- Append-only double-entry log. Every balance change is a row here; wallets
-- carries a cached copy. `remaining_credits`/`expires_at` are credit-row-only:
-- debits consume credit rows FIFO by expiry so subscription grants (Phase 2+)
-- burn before purchased packs.
-- The (user_id, id DESC) index serves the wallet-history UI's paging; the
-- UNIQUE (user_id, kind, idempotency_key) index cannot serve that sort.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            text NOT NULL REFERENCES users(id),
  kind               text NOT NULL CHECK (kind IN ('credit', 'debit')),
  amount             integer NOT NULL CHECK (amount > 0),
  reason             text NOT NULL,
  idempotency_key    text NOT NULL,
  balance_after      integer NOT NULL,
  remaining_credits  integer,
  expires_at         timestamptz,
  price_book_version text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ledger_entries_fifo
  ON ledger_entries (user_id, expires_at, id)
  WHERE kind = 'credit' AND remaining_credits > 0;

CREATE INDEX IF NOT EXISTS ledger_entries_wallet_history
  ON ledger_entries (user_id, id DESC);

CREATE TABLE IF NOT EXISTS holds (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id),
  amount          integer NOT NULL CHECK (amount > 0),
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'settled', 'released')),
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

-- The expiry sweep and any stuck-hold monitor scan open holds by age.
CREATE INDEX IF NOT EXISTS holds_state_created
  ON holds (state, created_at);

CREATE TABLE IF NOT EXISTS price_book (
  version text NOT NULL,
  action  text NOT NULL,
  credits integer NOT NULL,
  PRIMARY KEY (version, action)
);

CREATE TABLE IF NOT EXISTS stripe_customers (
  user_id            text PRIMARY KEY REFERENCES users(id),
  stripe_customer_id text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_usage (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    text,
  provider   text NOT NULL,
  model      text,
  usd        numeric,
  job_id     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Graph-run ownership + settlement state (Stage 5). One row per metered
-- canvas submission; `outputs` holds outputKey strings ("type:subfolder:filename")
-- recorded at settlement so /view can gate by ownership.
CREATE TABLE IF NOT EXISTS graph_runs (
  prompt_id  text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id),
  credits    integer NOT NULL CHECK (credits >= 0),
  hold_id    bigint,
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'settled', 'voided')),
  outputs    jsonb NOT NULL DEFAULT '[]',
  target     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- `target` arrived after graph_runs shipped (review I4): the engine base URL
-- that ran the prompt, so the /view harvest polls the pool worker a run was
-- actually dispatched to instead of always the main instance. Separate ALTER
-- so re-running this file upgrades an existing table too.
ALTER TABLE graph_runs ADD COLUMN IF NOT EXISTS target text;

CREATE INDEX IF NOT EXISTS graph_runs_user ON graph_runs (user_id, created_at DESC);

-- Who uploaded which engine input file (Stage 5 round 3). The engine's input
-- directory is shared across tenants until Stage 6, and ComfyUI's /upload
-- honours an `overwrite` field that makes the write unconditional — so the
-- hosted gate forwards an overwrite only for a file the caller owns, or a name
-- nobody has claimed. `file_key` is graphRuns.outputKey's format,
-- "type:subfolder:filename", with `type` defaulting to input here.
-- First writer keeps the name (INSERT … ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS input_uploads (
  file_key   text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS input_uploads_user ON input_uploads (user_id);

-- Central ownership registry for user-created resources (Stage 6). One row
-- per owned record; kinds are the RESOURCE_KINDS list in resourceOwners.ts.
-- A record with NO row here is curated/global content: readable by all,
-- mutable by none. First-owner-wins (ON CONFLICT DO NOTHING at write time).
CREATE TABLE IF NOT EXISTS resource_owners (
  kind        text NOT NULL,
  resource_id text NOT NULL,
  user_id     text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, resource_id)
);

CREATE INDEX IF NOT EXISTS resource_owners_user ON resource_owners (user_id, kind);

-- Operator safety valves (Stage 7). A single-row global flag table + a
-- per-user disable set. Read at preflight before every paid action.
CREATE TABLE IF NOT EXISTS system_controls (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  global_paused boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_controls (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS disabled_users (
  user_id    text PRIMARY KEY REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sailor runner (docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md).
-- One row per run; the whole run lives in `doc` (see server/runner/types.ts).
-- No FK to users: a run row is written before any money moves, and the
-- ledger rows it leads to carry their own FK.
CREATE TABLE IF NOT EXISTS runner_runs (
  run_id     text PRIMARY KEY,
  user_id    text,
  canvas_id  text,
  status     text NOT NULL CHECK (status IN ('running', 'paused', 'done', 'error', 'stopped')),
  doc        jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runner_runs_active ON runner_runs (status) WHERE status IN ('running', 'paused');
CREATE INDEX IF NOT EXISTS runner_runs_user_canvas ON runner_runs (user_id, canvas_id);

-- Results that can be handed back for an identical request (explicit seed only).
CREATE TABLE IF NOT EXISTS runner_results (
  user_id     text NOT NULL,
  fingerprint text NOT NULL,
  files       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint)
);
