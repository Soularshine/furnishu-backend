const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const path       = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');

const app = express()


app.use(cors());
app.use(express.json({ limit: '15mb' })); // allow base64 photo uploads
app.use((req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { index: 'about.html' }));


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');


//  AUTH MIDDLEWARE

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


//  AUTH ROUTES


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
    subject: `${code}  your FurnishU verification code`,
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


//  LISTINGS ROUTES



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
    const ids = (data||[]).map(l=>l.id);
    let rMap = {};
    if (ids.length) {
      const { data: revs } = await supabase.from('reviews').select('listing_id,rating').in('listing_id', ids);
      (revs||[]).forEach(r => { if (!rMap[r.listing_id]) rMap[r.listing_id]=[]; rMap[r.listing_id].push(r.rating); });
    }
    const enriched = (data||[]).map(l => ({ ...l,
      avg_rating: rMap[l.id] ? +(rMap[l.id].reduce((a,b)=>a+b,0)/rMap[l.id].length).toFixed(1) : null,
      rating_count: (rMap[l.id]||[]).length }));
    return res.json(enriched);
});


app.post('/api/listings', requireAuth, async (req, res) => {
  const { name, category, building, condition, description, free, price, must_go_by, photo_base64 } = req.body;

  if (!name || !category || !building) {
    return res.status(400).json({ error: 'Name, category, and building, condition are required' });
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
  notifySubscribers(data).catch(e => console.error('[notify]', e.message));
  res.json(data);
});


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


app.post('/api/listings/:id/claim', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: listing } = await supabase
    .from('listings').select('*').eq('id', id).single();

  if (!listing)                             return res.status(404).json({ error: 'Listing not found' });
  if (listing.status !== 'available')       return res.status(400).json({ error: 'Item is no longer available' });
  if (listing.owner_email === req.user.email) return res.status(400).json({ error: 'Cannot claim your own listing' });

  const { data, error } = await supabase
    .from('listings')
    .update({ status: 'pending', claimed_by: req.user.email, claimed_at: new Date().toISOString() })
    .eq('id', id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});


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


app.post('/api/listings/:id/pickup', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: listing } = await supabase
      .from('listings').select('id, name, claimed_by, owner_email').eq('id', id).single();
    if (!listing || listing.claimed_by !== req.user.email) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    await supabase.from('listings').update({ status: 'completed' }).eq('id', id);
    // Send rating request email to claimer
    const stars = [1,2,3,4,5].map(n => {
      const url = 'https://furnishu.app/app?review=' + id + '&rating=' + n + '&re=' + encodeURIComponent(req.user.email);
      return '<a href="' + url + '" style="font-size:26px;text-decoration:none;margin:0 6px;">'+(''.repeat(n))+'</a>';
    }).join('<br style="margin:4px 0">');
    resend.emails.send({
      from: 'FurnishU <no-reply@furnishu.app>',
      to: req.user.email,
      subject: 'How was your pickup? Rate your experience  FurnishU',
      html: '<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">'+
        '<h2 style="color:#6C63FF">How did it go? </h2>'+
        '<p>You just picked up <strong>'+listing.name+'</strong>. Tap to rate your experience:</p>'+
        '<div style="margin:20px 0">'+stars+'</div>'+
        '<p style="color:#888;font-size:13px">Ratings help build trust in the FurnishU community.</p>'+
        '</div>'
    }).catch(e => console.error('[rating-email]', e.message));
    // Notify owner that item was picked up
    resend.emails.send({
      from: 'FurnishU <no-reply@furnishu.app>',
      to: listing.owner_email,
      reply_to: req.user.email,
      subject: 'Your "' + listing.name + '" was picked up!  FurnishU',
      html: '<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">'+
        '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9fbe7;border-radius:10px">' +
        '<h2 style="color:#2e7d32;margin-top:0">&#x1F389; You just made someone\'s day!</h2>' +
        '<p style="font-size:16px">Your <strong>' + listing.name + '</strong> has been picked up and is now in good hands.</p>' +
        '<p style="color:#555">By sharing instead of discarding, you helped a fellow student settle in  and that means more than you know. The FurnishU community is stronger because of people like you.</p>' +
        '<p style="color:#888;font-size:13px">Keep an eye out  your reputation for generosity is building on campus. &#x2764;&#xFE0F;</p>' +
        '<p style="font-size:12px;color:#aaa;margin-bottom:0"> The FurnishU team</p>' +
    }).catch(e => console.error('[pickup-owner-email]', e.message));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});



app.post('/api/listings/:id/contact', async (req, res) => {
  try {
    const { id } = req.params;
    const { senderEmail, claimerEmail: _ce, claimerName, message } = req.body || {};
    const claimerEmail = _ce || senderEmail;
    if (!claimerEmail) return res.status(400).json({ error: 'claimerEmail is required' });
    const { data: listing, error: dbErr } = await supabase
      .from('listings').select('id, name, building, owner_email, status')
      .eq('id', id).single();
    if (dbErr || !listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.status !== 'available') return res.status(409).json({ error: 'Item no longer available' });
    const displayName = claimerName || claimerEmail.split('@')[0];
    const shareUrl = 'https://furnishu.app/app?listing=' + listing.id;
    await resend.emails.send({
      from: 'FurnishU <no-reply@furnishu.app>',
      reply_to: listing.owner_email,
      to: claimerEmail,
      subject: 'You expressed interest in "' + listing.name + '"  FurnishU',
      html: '<div style="font-family:sans-serif;max-width:600px;margin:auto"><div style="background:#3D1C02;padding:24px;border-radius:8px 8px 0 0"><h1 style="color:#D97706;margin:0">FurnishU</h1></div><div style="padding:24px;background:#fdf8f3"><p>Hi ' + displayName + ',</p><p>You expressed interest in <strong>' + listing.name + '</strong> (' + listing.building + '). The owner has been notified and will reach out to you at <strong>' + claimerEmail + '</strong>.</p><a href="' + shareUrl + '" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#D97706;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">View Listing</a></div></div>'
    });
    await resend.emails.send({
      from: 'FurnishU <no-reply@furnishu.app>',
      reply_to: claimerEmail,
      to: listing.owner_email,
      subject: 'Someone wants your "' + listing.name + '"  FurnishU',
      html: '<div style="font-family:sans-serif;max-width:600px;margin:auto"><div style="background:#3D1C02;padding:24px;border-radius:8px 8px 0 0"><h1 style="color:#D97706;margin:0">FurnishU</h1></div><div style="padding:24px;background:#fdf8f3"><p>Great news! <strong>' + displayName + '</strong> wants your listing <strong>' + listing.name + '</strong>.</p><p>Reply to them at: <a href="mailto:' + claimerEmail + '" style="color:#D97706">' + claimerEmail + '</a></p>' + (message ? '<blockquote style="border-left:3px solid #D97706;padding-left:12px;color:#555">' + message + '</blockquote>' : '') + '<a href="' + shareUrl + '" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#D97706;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">View Your Listing</a><p style="font-size:13px;color:#555">Once picked up, mark it as Completed in the app.</p></div></div>'
    });
    await supabase.from('listings').update({ status: 'pending', claimed_by: claimerEmail, claimed_at: new Date().toISOString() }).eq('id', id);
    return res.json({ success: true, message: 'Emails sent to both parties' });
  } catch (err) {
    console.error('[contact]', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});
app.post('/api/listings/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const { reporterEmail, reason } = req.body;
    const { data: listing } = await supabase.from('listings').select('name,owner_email').eq('id', id).single();
    await resend.emails.send({
      from: 'FurnishU <noreply@furnishu.app>',
      to: 'shawnowenslemons@gmail.com',
      subject: 'FurnishU: Listing Reported',
      html: '<p>Listing <strong>' + (listing ? listing.name : id) + '</strong> (ID: ' + id + ') was reported.</p>' +
            '<p>Reason: ' + (reason || 'No reason given') + '</p>' +
            '<p>Reporter: ' + (reporterEmail || 'anonymous') + '</p>'
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



app.get('/app', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.get('*', (req, res) => {
  res.redirect(302, '/about.html');
});


const PORT = process.env.PORT || 3000;


app.post('/api/cron/expire-listings', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const { data: expiring, error: fetchErr } = await supabase.from('listings').select('id, name, owner_email').in('status', ['available','pending']).lt('created_at', cutoff.toISOString());
    if (fetchErr) throw fetchErr;
    if (!expiring || !expiring.length) return res.json({ expired: 0 });
    await supabase.from('listings').update({ status: 'completed' }).in('id', expiring.map(l => l.id));
    await Promise.allSettled(expiring.map(l => resend.emails.send({ from: 'FurnishU <no-reply@furnishu.app>', to: l.owner_email, subject: `Your listing has expired - FurnishU`, html: `<p>Your listing <strong>${l.name}</strong> was removed after 90 days. <a href='https://furnishu.app/app'>Re-post it here.</a></p>` }).catch(e => console.error('[expire]', e.message))));
    return res.json({ expired: expiring.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


app.post('/api/cron/expire-listings', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const { data: expiring, error: fetchErr } = await supabase.from('listings')
      .select('id, name, owner_email')
      .in('status', ['available','pending'])
      .lt('created_at', cutoff.toISOString());
    if (fetchErr) throw fetchErr;
    if (!expiring || !expiring.length) return res.json({ expired: 0, message: 'No listings to expire' });
    await supabase.from('listings').update({ status: 'completed' }).in('id', expiring.map(l => l.id));
    await Promise.allSettled(expiring.map(l => resend.emails.send({
      from: 'FurnishU <no-reply@furnishu.app>',
      to: l.owner_email,
      subject: 'Your listing has expired - FurnishU',
      html: '<p>Your listing <strong>' + l.name + '</strong> was removed after 90 days. <a href="https://furnishu.app/app">Re-post it here.</a></p>'
    }).catch(e => console.error('[expire]', e.message))));
    return res.json({ expired: expiring.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// POST /api/listings/:id/review  one-click star rating from email link
app.post('/api/listings/:id/review', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, reviewer_email } = req.body || {};
    const r = parseInt(rating);
    if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
    if (!reviewer_email) return res.status(400).json({ error: 'reviewer_email required' });
    const { data: listing } = await supabase.from('listings')
      .select('id, owner_email, name, claimed_by').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.claimed_by !== reviewer_email) return res.status(403).json({ error: 'Not the claimer' });
    await supabase.from('reviews').upsert(
      { listing_id: id, reviewer_email, reviewee_email: listing.owner_email, rating: r },
      { onConflict: 'listing_id,reviewer_email' }
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[review]', err);
    return res.status(500).json({ error: err.message });
  }
});


// POST /api/subscribe  subscribe to new listing alerts
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email, category } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    await supabase.from('subscriptions').upsert(
      { email, category: category || null, building: null },
      { onConflict: 'email,category,building' }
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/subscribe  unsubscribe from alerts
app.delete('/api/subscribe', async (req, res) => {
  try {
    const { email, category } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    let q = supabase.from('subscriptions').delete().eq('email', email);
    if (category) q = q.eq('category', category);
    else q = q.is('category', null);
    await q;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Helper: email subscribers when a new listing is posted
// PATCH /api/listings/:id  owner edits listing
app.patch('/api/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { owner_email, name, description, category, building, condition } = req.body || {};
    if (!owner_email) return res.status(400).json({ error: 'owner_email required' });
    const { data: listing } = await supabase.from('listings').select('owner_email').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (listing.owner_email !== owner_email) return res.status(403).json({ error: 'Not the owner' });
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category !== undefined) updates.category = category;
    if (building !== undefined) updates.building = building;
    if (condition !== undefined) updates.condition = condition;
    const { data, error } = await supabase.from('listings').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  } catch(err) { return res.status(500).json({ error: err.message }); }
});

// DELETE /api/listings/:id  owner removes listing
app.delete('/api/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const owner_email = (req.body||{}).owner_email || req.query.owner_email;
    if (!owner_email) return res.status(400).json({ error: 'owner_email required' });
    const { data: listing } = await supabase.from('listings').select('owner_email').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (listing.owner_email !== owner_email) return res.status(403).json({ error: 'Not the owner' });
    const { error } = await supabase.from('listings').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  } catch(err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/needs
app.get('/api/needs', async (req, res) => {
  try {
    const { data, error } = await supabase.from('needs').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch(err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/needs
app.post('/api/needs', async (req, res) => {
  try {
    const { user_email, title, description, category, building } = req.body || {};
    if (!user_email || !title) return res.status(400).json({ error: 'user_email and title required' });
    const { data, error } = await supabase.from('needs').insert([{ user_email, title, description, category, building }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  } catch(err) { return res.status(500).json({ error: err.message }); }
});

// DELETE /api/needs/:id
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
    return res.json({ success: true });
  } catch(err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/listings/:id/report
app.post('/api/listings/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const { reporter_email, reason } = req.body || {};
    if (!reporter_email) return res.status(400).json({ error: 'reporter_email required' });
    const { data: listing } = await supabase.from('listings').select('id').eq('id', id).single();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const { error } = await supabase.from('reports').insert([{ listing_id: id, reporter_email, reason: reason || '' }]);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  } catch(err) { return res.status(500).json({ error: err.message }); }
});


async function notifySubscribers(listing) {
  if (!listing) return;
  const { data: subs } = await supabase.from('subscriptions')
    .select('email')
    .or('category.is.null,category.eq.' + (listing.category || ''))
    .neq('email', listing.owner_email);
  if (!subs?.length) return;
  const shareUrl = 'https://furnishu.app/app?listing=' + listing.id;
  await Promise.allSettled(subs.map(s =>
    resend.emails.send({
      from: 'FurnishU <no-reply@furnishu.app>',
      to: s.email,
      subject: 'New listing: "' + listing.name + '"  FurnishU',
      html: '<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">'+
        '<h2 style="color:#6C63FF"> New listing alert!</h2>'+
        '<p>A new <strong>'+(listing.category||'item')+'</strong> was posted'+(listing.building?' in <strong>'+listing.building+'</strong>':'')+'.</p>'+
        '<p style="font-size:18px;font-weight:bold">'+listing.name+'</p>'+
        '<a href="'+shareUrl+'" style="display:inline-block;background:#6C63FF;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px;">View Listing </a>'+
        '<p style="color:#999;font-size:12px;margin-top:20px">You subscribed to '+( listing.category||'all')+' alerts. '+
        '<a href="https://furnishu.app/app?unsub=1&e='+encodeURIComponent(s.email)+'&cat='+encodeURIComponent(listing.category||'')+'">Unsubscribe</a></p>'+
        '</div>'
    }).catch(e => console.error('[notify]', e.message))
  ));
  console.log('[notify] alerted', subs.length, 'subscriber(s)');
}

async function expireOldListings() {
  try {
    //  Re-open listings where claimer hasn't confirmed pickup in 48 h 
    const cutoff48h = new Date(); cutoff48h.setHours(cutoff48h.getHours() - 48);
    const { data: stale } = await supabase.from('listings')
      .select('id, name, owner_email, claimed_by')
      .eq('status', 'pending')
      .lt('claimed_at', cutoff48h.toISOString());
    if (stale?.length) {
      await supabase.from('listings')
        .update({ status: 'available', claimed_by: null })
        .in('id', stale.map(l => l.id));
      await Promise.allSettled(stale.map(l => resend.emails.send({
        from: 'FurnishU <no-reply@furnishu.app>',
        to: l.owner_email,
        subject: '"' + l.name + '" is available again  FurnishU',
        html: '<p>The 48-hour pickup window for <strong>' + l.name + '</strong> passed without confirmation. It\'s back in the feed!</p>'
      }).catch(e => console.error('[48h-reset]', e.message))));
      console.log('[48h-reset] reopened', stale.length, 'stale claim(s)');
    }
    //  End 48 h reset 
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const { data: expiring, error } = await supabase.from('listings')
      .select('id, name, owner_email')
      .in('status', ['available', 'pending'])
      .lt('created_at', cutoff.toISOString());
    if (error) throw error;
    if (!expiring || !expiring.length) { console.log('[expire] nothing to expire'); return; }
    await supabase.from('listings').update({ status: 'completed' }).in('id', expiring.map(l => l.id));
    await Promise.allSettled(expiring.map(l =>
      resend.emails.send({
        from: 'FurnishU <no-reply@furnishu.app>',
        to: l.owner_email,
        subject: 'Your listing has expired  FurnishU',
        html: '<p>Hi! Your listing <strong>' + l.name + '</strong> was automatically removed after 90 days. You can re-post it anytime at <a href="https://furnishu.app">furnishu.app</a>.</p>'
      }).catch(e => console.error("[expire email]", e.message))
    ));
    console.log('[expire] expired', expiring.length, 'listing(s)');
  } catch (err) {
    console.error('[expire] error:', err.message);
  }
}

// Run once at startup, then every 24 h
expireOldListings();
setInterval(expireOldListings, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n FurnishU server running on http://localhost:${PORT}\n`);
});
