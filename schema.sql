-- ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
--  FurnishU â Supabase Database Schema
--  Run this in your Supabase SQL Editor (Project > SQL Editor)
-- ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

-- ââ Users ââââââââââââââââââââââââââââââââââââââââââââââââââââ
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  created_at timestamptz default now()
);

-- ââ Verification Codes âââââââââââââââââââââââââââââââââââââââ
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

-- ââ Listings âââââââââââââââââââââââââââââââââââââââââââââââââ
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

-- ââ Disable Row Level Security (backend handles auth) ââââââââ
alter table users              disable row level security;
alter table verification_codes disable row level security;
alter table listings           disable row level security;

-- ── Reviews table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id    uuid REFERENCES listings(id) ON DELETE CASCADE,
  reviewer_email text NOT NULL,
  reviewee_email text NOT NULL,
  rating        int  NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       text,
  created_at    timestamptz DEFAULT now(),
  UNIQUE(listing_id, reviewer_email)
);
