const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const path       = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');

const app = express()

// ── Middleware ──────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '15mb' })); // allow base64 photo uploads
app.use((req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// ── Clients ─────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// ══════════════════════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════

// POST /api/auth/send-code
// Generates a 4-digit code, stores it, emails it via Resend
app.post('/api/auth/send-code', async (req, res) => {
  const { email } = req.body;

  if (!email || !email.toLowerCase().endsWith('.edu')) {
    return res.status(400).json({ error: 'Must be a .edu email address' });
  }

  const code     = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Store code in DB
  const { error: dbErr } = await supabase.from('verification_codes').insert({
    email:      email.toLowerCase(),
    code,
    expires_at: expiresAt.toISOString(),
    used:       false,
  });
  if (dbErr) return res.status(500).json({ error: 'Could not generate code' });

  // Send via Resend
  const { error: emailErr } = await resend.emails.send({
    from:    'FurnishU <noreply@furnishu.app>',
    to:      email,
    subject: `${code} — your FurnishU verification code`,
    html: `
      <div style="font-family:-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:24px;">
        <h2 style="color:#6C3FC5;margin-bottom:4px;">Furnish<span style="color:#F5A623;">U</span></h2>
        <p style="color:#6B7280;margin-bottom:24px;">Pass it forward. Furnish your future.</p>
        <p>Your verification code:</p>
        <div style="font-size:40px;font-weight:800;letter-spacing:10px;color:#6C3FC5;
                    background:#F7F5FF;border-radius:12px;padding:20px;text-align:center;">
          ${code}
        </div>
        <p style="color:#9CA3AF;font-size:13px;margin-top:20px;">
          Expires in 10 minutes. If you didn't request this, you can safely ignore it.
        </p>
      </div>`,
  });

  if (emailErr) {
    console.error('Email error:', emailErr);
    return res.status(500).json({ error: 'Could not send email' });
  }

  res.json({ success: true });
});

// POST /api/auth/verify-code
// Validates code, upserts user, returns JWT
app.post('/api/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;
  const emailLower = email?.toLowerCase();

  const { data: codes } = await supabase
    .from('verification_codes')
    .select('*')
    .eq('email', emailLower)
    .eq('code', code)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1);

  if (!codes || codes.length === 0) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  // Mark used
  await supabase.from('verification_codes').update({ used: true }).eq('id', codes[0].id);

  // Upsert user
  await supabase.from('users').upsert({ email: emailLower }, { onConflict: 'email' });

  const token = jwt.sign({ email: emailLower }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: emailLower });
});

// ══════════════════════════════════════════════════════════════════════════
//  LISTINGS ROUTES
// ══════════════════════════════════════════════════════════════════════════

// GET /api/listings — browse all active listings
app.get('/api/listings', async (req, res) => {
  const { category, building, q } = req.query;

  let query = supabase
    .from('listings')
    .select('*')
    .neq('status', 'completed')
    .order('created_at', { ascending: false });

  if (category && category !== 'All') query = query.eq('category', category);
  if (building && building !== 'All') query = query.eq('building', building);
  if (q) query = query.ilike('name', `%${q}%`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/listings — create a listing (auth required)
app.post('/api/listings', requireAuth, async (req, res) => {
  const { name, category, building, description, free, price, must_go_by, photo_base64 } = req.body;

  if (!name || !category || !building) {
    return res.status(400).json({ error: 'Name, category, and building are required' });
  }

  const { data, error } = await supabase.from('listings').insert({
    name,
    category,
    building,
    description:  description || null,
    free:         free !== false,
    price:        free ? 0 : (Number(price) || 0),
    must_go_by:   must_go_by || null,
    photo_base64: photo_base64 || null,
    owner_email:  req.user.email,
    status:       'available',
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /api/listings/:id — update a listing (owner only)
app.put('/api/listings/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('listings').select('owner_email').eq('id', id).single();

  if (!existing || existing.owner_email !== req.user.email) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const { name, category, building, description, free, price, must_go_by, photo_base64 } = req.body;

  const updates = { name, category, building, description, free, must_go_by: must_go_by || null };
  updates.price = free ? 0 : (Number(price) || 0);
  if (photo_base64) updates.photo_base64 = photo_base64;

  const { data, error } = await supabase
    .from('listings').update(updates).eq('id', id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/listings/:id — remove a listing (owner only)
app.delete('/api/listings/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('listings').select('owner_email').eq('id', id).single();

  if (!existing || existing.owner_email !== req.user.email) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await supabase.from('listings').delete().eq('id', id);
  res.json({ success: true });
});

// POST /api/listings/:id/claim — claim an item
app.post('/api/listings/:id/claim', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: listing } = await supabase
    .from('listings').select('*').eq('id', id).single();

  if (!listing)                             return res.status(404).json({ error: 'Listing not found' });
  if (listing.status !== 'available')       return res.status(400).json({ error: 'Item is no longer available' });
  if (listing.owner_email === req.user.email) return res.status(400).json({ error: 'Cannot claim your own listing' });

  const { data, error } = await supabase
    .from('listings')
    .update({ status: 'pending', claimed_by: req.user.email })
    .eq('id', id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/listings/:id/unclaim — release a claim
app.post('/api/listings/:id/unclaim', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: listing } = await supabase
    .from('listings').select('*').eq('id', id).single();

  if (!listing || listing.claimed_by !== req.user.email) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const { data, error } = await supabase
    .from('listings')
    .update({ status: 'available', claimed_by: null })
    .eq('id', id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/listings/:id/pickup — confirm pickup (removes listing)
app.post('/api/listings/:id/pickup', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: listing } = await supabase
    .from('listings').select('*').eq('id', id).single();

  if (!listing || listing.claimed_by !== req.user.email) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await supabase.from('listings').update({ status: 'completed' }).eq('id', id);
  res.json({ success: true });
});

// ── Catch-all: serve frontend ────────────────────────────────────────────
app.get('/app', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.get('*', (req, res) => {
  res.redirect(302, '/about.html');
});

// ── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎓 FurnishU server running on http://localhost:${PORT}\n`);
});
