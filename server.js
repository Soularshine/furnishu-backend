const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const path       = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');

const app = express();

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use((req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { index: 'about.html' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const CRON_SECRET = process.env.CRON_SECRET || '';

// --- AUTH MIDDLEWARE ---

function requireAuth(req, res, next) {
  const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- AUTH ROUTES ---

// POST /api/auth/send-code
app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const code = crypto.randomInt(100000, 999999).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: dbErr } = await supabase
      .from('magic_codes')
      .upsert({ email, code, expires_at: expires, used: false });
    if (dbErr) return res.status(500).json({ error: 'Could not generate code' });

    if (!resend) return res.status(500).json({ error: 'Email service not configured' });

    const { error: emailErr } = await resend.emails.send({
      from:    'FurnishU <noreply@furnishu.app>',
      to:      email,
      subject: code + ' - your FurnishU verification code',
      html:    '<p>Your code: <strong>' + code + '</strong></p><p>Expires in 10 minutes.</p>'
    });

    if (emailErr) {
      console.error('Email error:', emailErr);
      return res.status(500).json({ error: 'Could not send email' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/verify-code
app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: 'email and code required' });

    const { data: row } = await supabase
      .from('magic_codes')
      .select('*')
      .eq('email', email)
      .eq('code', code)
      .single();

    if (!row) return res.status(401).json({ error: 'Invalid code' });
    if (row.used) return res.status(401).json({ error: 'Code already used' });
    if (new Date(row.expires_at) < new Date()) return res.status(401).json({ error: 'Code expired' });

    await supabase.from('magic_codes').update({ used: true }).eq('id', row.id);

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email });
});

// --- LISTINGS ---

// GET /api/listings
app.get('/api/listings', async (req, res) => {
  try {
    const { building, category, q, status } = req.query;
    let query = supabase.from('listings').select('*').eq('status', status || 'available').order('created_at', { ascending: false });
    if (building) query = query.eq('building', building);
    if (category) query = query.eq('category', category);
    if (q) query = query.ilike('name', '%' + q + '%');
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/listings
app.post('/api/listings', requireAuth, async (req, res) => {
  try {
    const { name, description, category, building, room, photo_base64, condition } = req.body || {};
    if (!name || !building) return res.status(400).json({ error: 'name and building required' });
    const { data, error } = await supabase
      .from('listings')
      .insert([{ name, description, category, building, room, photo_base64, condition, owner_email: req.user.email }])
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/listings/:id
app.patch('/api/listings/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: listing } = await supabase.from('listings').select('owner_email').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (listing.owner_email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    const allowed = ['name', 'description', 'category', 'building', 'room', 'photo_base64', 'condition'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    const { data, error } = await supabase.from('listings').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/listings/:id
app.delete('/api/listings/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: listing } = await supabase.from('listings').select('owner_email').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (listing.owner_email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    const { error } = await supabase.from('listings').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CLAIMS ---

// POST /api/listings/:id/claim
app.post('/api/listings/:id/claim', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: listing } = await supabase.from('listings').select('*').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (listing.owner_email === req.user.email) return res.status(400).json({ error: 'Cannot claim own listing' });
    if (listing.status !== 'available') return res.status(409).json({ error: 'Already claimed or expired' });
    const { data, error } = await supabase
      .from('listings')
      .update({ status: 'claimed', claimer_email: req.user.email, claimed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/listings/:id/claim  (unclaim)
app.delete('/api/listings/:id/claim', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: listing } = await supabase.from('listings').select('*').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (listing.claimer_email !== req.user.email) return res.status(403).json({ error: 'Not claimer' });
    const { data, error } = await supabase
      .from('listings')
      .update({ status: 'available', claimer_email: null, claimed_at: null })
      .eq('id', id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RATINGS ---

// POST /api/listings/:id/rate
app.post('/api/listings/:id/rate', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { stars, comment } = req.body || {};
    if (!stars || stars < 1 || stars > 5) return res.status(400).json({ error: 'stars must be 1-5' });
    const { data: listing } = await supabase.from('listings').select('*').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });

    const { error } = await supabase
      .from('ratings')
      .upsert({ listing_id: id, rater_email: req.user.email, stars, comment }, { onConflict: 'listing_id,rater_email' });
    if (error) return res.status(500).json({ error: error.message });

    const { data: rows } = await supabase.from('ratings').select('stars').eq('listing_id', id);
    const avg = rows && rows.length ? rows.reduce((s, r) => s + r.stars, 0) / rows.length : 0;
    await supabase.from('listings').update({ avg_rating: parseFloat(avg.toFixed(2)), rating_count: rows.length }).eq('id', id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- EXPIRE OLD LISTINGS ---

async function expireOldListings() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: expiring } = await supabase
      .from('listings')
      .select('id, owner_email')
      .eq('status', 'available')
      .lt('created_at', cutoff);

    if (!expiring || expiring.length === 0) return;

    await Promise.allSettled(
      expiring.map(l =>
        supabase.from('listings').update({ status: 'expired' }).eq('id', l.id)
          .then(() => {
            if (resend) {
              return resend.emails.send({
                from: 'FurnishU <noreply@furnishu.app>',
                to:   l.owner_email,
                subject: 'Your FurnishU listing has expired',
                html: '<p>Your listing has been marked as expired after 30 days.</p>'
              }).catch(e => console.error('[expire email]', e.message));
            }
          })
      )
    );

    console.log('[expired]', expiring.length, 'listing(s)');
  } catch (err) {
    console.error('[expire] error:', err.message);
  }
}

// --- CRON ENDPOINT ---

app.post('/api/cron/expire-listings', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret || '';
  if (CRON_SECRET && secret !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await expireOldListings();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- NEEDS (Request Board) ---

app.get('/api/needs', async (req, res) => {
  try {
    const { data, error } = await supabase.from('needs').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/needs', async (req, res) => {
  try {
    const { user_email, title, description, category, building } = req.body || {};
    if (!user_email || !title) return res.status(400).json({ error: 'user_email and title required' });
    const { data, error } = await supabase
      .from('needs')
      .insert([{ user_email, title, description, category, building }])
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/needs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user_email = (req.body || {}).user_email || req.query.user_email;
    if (!user_email) return res.status(400).json({ error: 'user_email required' });
    const { data: need } = await supabase.from('needs').select('user_email').eq('id', id).single();
    if (!need) return res.status(404).json({ error: 'Not found' });
    if (need.user_email !== user_email) return res.status(403).json({ error: 'Not the owner' });
    const { error } = await supabase.from('needs').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- REPORTS ---

app.post('/api/listings/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const { reporter_email, reason } = req.body || {};
    if (!reporter_email) return res.status(400).json({ error: 'reporter_email required' });
    const { data: listing } = await supabase.from('listings').select('id').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const { error } = await supabase
      .from('reports')
      .insert([{ listing_id: id, reporter_email, reason: reason || '' }]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ADMIN --- (v2)

app.get('/api/admin/reports', async (req, res) => {
  if (req.headers['x-admin-code'] !== 'FU-OWNER-2025') return res.status(403).json({ error: 'Forbidden' });
  try {
    const { data: reports, error: rErr } = await supabase
      .from('reports')
      .select('id, listing_id, reporter_email, reason, created_at')
      .order('created_at', { ascending: false });
    if (rErr) return res.status(500).json({ error: rErr.message });
    const ids = [...new Set((reports||[]).map(r => r.listing_id).filter(Boolean))];
    let listingsMap = {};
    if (ids.length) {
      const { data: ls } = await supabase.from('listings').select('id, title, category, owner_email, image_url').in('id', ids);
      (ls||[]).forEach(l => { listingsMap[l.id] = l; });
    }
    res.json((reports||[]).map(r => ({ ...r, listings: listingsMap[r.listing_id] || null })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/reports/:id', async (req, res) => {
  if (req.headers['x-admin-code'] !== 'FU-OWNER-2025') return res.status(403).json({ error: 'Forbidden' });
  try {
    const { error } = await supabase.from('reports').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- STARTUP ---

const PORT = process.env.PORT || 3000;

expireOldListings();
setInterval(expireOldListings, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log('FurnishU running on port ' + PORT);
});
