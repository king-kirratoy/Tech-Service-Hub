-- ═══════════════════════════════════════════════════════════
-- COMMS Board Tables for Supabase
-- Run this in the Supabase SQL Editor to create the tables
-- ═══════════════════════════════════════════════════════════

-- Cards table
CREATE TABLE IF NOT EXISTS comms_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  grid_row INTEGER NOT NULL CHECK (grid_row >= 0 AND grid_row <= 9),
  grid_col INTEGER NOT NULL CHECK (grid_col >= 0 AND grid_col <= 4),
  title TEXT DEFAULT '',
  body TEXT DEFAULT '',
  icon TEXT DEFAULT 'none',
  bg_color TEXT DEFAULT 'navy',
  border_color TEXT DEFAULT 'blue',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Unique constraint: one card per grid slot
CREATE UNIQUE INDEX IF NOT EXISTS comms_cards_slot_idx ON comms_cards (grid_row, grid_col);

-- Reactions table
CREATE TABLE IF NOT EXISTS comms_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES comms_cards(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Unique constraint: one reaction of each emoji per agent per card
CREATE UNIQUE INDEX IF NOT EXISTS comms_reactions_unique_idx ON comms_reactions (card_id, agent_name, emoji);

-- Enable RLS (Row Level Security) but allow service role full access
ALTER TABLE comms_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_reactions ENABLE ROW LEVEL SECURITY;

-- Policy: allow all operations via service role key (used by Flask proxy)
CREATE POLICY "Service role full access cards" ON comms_cards FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access reactions" ON comms_reactions FOR ALL USING (true) WITH CHECK (true);
