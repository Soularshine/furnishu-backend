-- ══════════════════════════════════════════════════════════════
--  FurnishU — Supabase Database Schema
--  Run this in your Supabase SQL Editor (Project > SQL Editor)
-- ══════════════════════════════════════════════════════════════

-- ── Users ────────────────────────────────────────────────────
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  created_at timestamptz default now()
);

-- ── Verification Codes ───────────────────────────────────────
create table if not exists verification_codes (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  code       text not null,
  expires_at timestamptz not null,
  used       boolean default false,
  created_at timestamptz default now()
);

-- Auto-clean expired codes (optional but good practice)
create index if not exists idx_codes_email on verification_codes(email);
create index if not exists idx_codes_expires on verification_codes(expires_at);

-- ── Listings ─────────────────────────────────────────────────
create table if not exists listings (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  category      text not null,
  building      text not null,
  description   text,
  free          boolean default true,
  price         decimal(10,2) default 0,
  status        text default 'available',  -- available | pending | completed
  owner_email   text not null references users(email),
  claimed_by    text references users(email),
  photo_base64  text,                       -- stores image as base64 string
  must_go_by    date,
  created_at    timestamptz default now()
);

create index if not exists idx_listings_status   on listings(status);
create index if not exists idx_listings_category on listings(category);
create index if not exists idx_listings_building on listings(building);
create index if not exists idx_listings_owner    on listings(owner_email);

-- ── Disable Row Level Security (backend handles auth) ────────
alter table users              disable row level security;
alter table verification_codes disable row level security;
alter table listings           disable row level security;
