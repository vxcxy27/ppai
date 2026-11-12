const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Safe .env loader
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
} catch (e) { console.warn('Could not load .env:', e.message); }

const {
  PAYPAL_CLIENT_ID: CID,
  PAYPAL_SECRET: SEC,
  GEMINI_API_KEY: GK,
  BASE_URL = 'http://localhost:3000',
} = process.env;

const PP = 'https://api-m.sandbox.paypal.com';
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

const sessions = new Map();
const families = new Map();
const CATS = ['Groceries', 'Dining', 'Shopping', 'Fuel', 'Bills', 'Travel', 'Gaming', 'Health'];

const me = (r) => {
  const sid = (r.headers.cookie || '').match(/sid=(\w+)/)?.[1];
  return sid ? sessions.get(sid) : undefined;
};

function startSession(res, u) {
  const sid = crypto.randomBytes(16).toString('hex');
  sessions.set(sid, u);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
}

// ---- PayPal: Client Credentials token (app account, NOT user) ----
async function ppClientToken() {
  const auth = 'Basic ' + Buffer.from(`${CID}:${SEC}`).toString('base64');
  const r = await fetch(`${PP}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error(j.error_description || 'client_credentials rejected');
  }
  return j.access_token;
}

// ---- PayPal: Authorization Code token (for user identity only) ----
async function ppUserToken(code) {
  const auth = 'Basic ' + Buffer.from(`${CID}:${SEC}`).toString('base64');
  const r = await fetch(`${PP}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(j.error_description || 'code exchange failed');
  return j.access_token;
}

// ---- Transaction Search (app account only) ----
async function loadSpend() {
  try {
    const token = await ppClientToken();
    const end = new Date();
    const start = new Date(Date.now() - 30 * 864e5);
    const url = `${PP}/v1/reporting/transactions?start_date=${start.toISOString()}&end_date=${end.toISOString()}&fields=transaction_info&page_size=100`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) {
      const err = await r.text();
      console.warn('Transaction Search failed:', r.status, err.slice(0, 200));
      throw new Error('tx search failed');
    }
    const data = await r.json();
    const c = {};
    for (const t of data.transaction_details || []) {
      const i = t.transaction_info;
      const v = parseFloat(i.transaction_amount?.value || 0);
      if (v < 0) {
        const k = i.transaction_subject || 'Other';
        c[k] = (c[k] || 0) - v;
      }
    }
    if (Object.keys(c).length) {
      return { c, src: 'PayPal sandbox (app account)' };
    }
    console.log('Transaction Search returned 0 rows — falling back to demo');
  } catch (e) {
    console.warn('loadSpend error:', e.message);
  }
  // Demo fallback
  const c = {};
  [...CATS].sort(() => Math.random() - 0.5).slice(0, 4)
    .forEach((k) => (c[k] = Math.round(1500 + Math.random() * 7000)));
  return { c, src: 'demo data' };
}

// ---- Auth routes ----
app.get('/auth/login', (q, s) =>
  s.redirect(
    `https://www.sandbox.paypal.com/connect?flowEntry=static&client_id=${CID}&scope=openid%20profile%20email&redirect_uri=${encodeURIComponent(
      BASE_URL + '/auth/callback'
    )}`
  )
);

app.get('/auth/callback', async (q, s) => {
  try {
    if (!q.query.code) throw new Error('No code');
    const token = await ppUserToken(q.query.code);
    const u = await (
      await fetch(`${PP}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
        headers: { Authorization: 'Bearer ' + token },
      })
    ).json();
    const email = u.emails?.find((e) => e.primary)?.value || u.emails?.[0]?.value || u.user_id;
    const spend = await loadSpend(); // app account data, not user's
    startSession(s, { email, name: u.name || email.split('@')[0], ...spend });
    s.redirect('/');
  } catch (e) {
    console.error('callback error:', e.message);
    s.status(500).send('PayPal login failed. Check .env keys and redirect URI.');
  }
});

app.get('/auth/demo', async (q, s) => {
  const n = String(q.query.name || 'Guest1').slice(0, 20);
  startSession(s, {
    email: n.toLowerCase() + '@demo.local',
    name: n,
    ...(await loadSpend()), // still tries app account first
  });
  s.redirect('/');
});

app.get('/auth/sandbox', async (q, s) => {
  try {
    const n = String(q.query.name || 'Guest').slice(0, 20);
    const spend = await loadSpend();
    startSession(s, { email: n.toLowerCase() + '@sandbox', name: n, ...spend });
    s.redirect('/');
  } catch (e) {
    console.error('sandbox error:', e.message);
    s.status(500).send('Sandbox keys rejected. Check PAYPAL_CLIENT_ID / PAYPAL_SECRET (Sandbox).');
  }
});

// ---- Family logic (unchanged) ----
const famOf = (u) => [...families.values()].find((f) => f.m.has(u.email));

const summary = (f) => ({
  code: f.code,
  name: f.name,
  head: f.head,
  headName: f.m.get(f.head).name,
  members: [...f.m.values()].map((m) => {
    const spent = Object.values(m.c).reduce((a, b) => a + b, 0);
    return {
      email: m.email,
      name: m.name,
      limit: m.limit,
      spent,
      fine: Math.max(0, spent - m.limit) * 0.1,
      categories: m.c,
      source: m.src,
    };
  }),
});

const auth = (q, s, n) => {
  const u = me(q);
  if (!u) return s.sendStatus(401);
  n(u);
};

app.get('/api/family', (q, s) =>
  auth(q, s, (u) => {
    const f = famOf(u);
    s.json({ me: u.email, name: u.name, family: f ? summary(f) : null });
  })
);

app.post('/api/create', (q, s) =>
  auth(q, s, (u) => {
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    families.set(code, {
      code,
      name: q.body.name || u.name + "'s family",
      head: u.email,
      m: new Map([[u.email, { ...u, limit: 20000 }]]),
    });
    s.json({ ok: 1, code });
  })
);

app.post('/api/join', (q, s) =>
  auth(q, s, (u) => {
    const f = families.get(String(q.body.code || '').trim().toUpperCase());
    if (!f) return s.status(404).json({ error: 'Invalid family code' });
    f.m.set(u.email, { ...u, limit: 20000 });
    s.json({ ok: 1 });
  })
);

app.post('/api/limit', (q, s) =>
  auth(q, s, (u) => {
    const f = famOf(u);
    if (!f || f.head !== u.email) return s.sendStatus(403);
    const m = f.m.get(q.body.email);
    if (m) m.limit = Math.max(0, +q.body.limit || 0);
    s.json({ ok: 1 });
  })
);

// ---- Gemini chat (unchanged) ----
app.post('/api/chat', (q, s) =>
  auth(q, s, async (u) => {
    if (!GK) return s.json({ reply: 'GEMINI_API_KEY is not set in .env' });
    const f = famOf(u);
    if (!f) return s.status(400).json({ reply: 'Join a family first.' });

    const sys =
      `You are a friendly family budget coach inside FamilyPay. Be concise and specific, use rupees (₹). ` +
      `Exceeding a limit adds a 10% fine paid to the family head. You are talking to ${u.name}. ` +
      `Family data (JSON): ${JSON.stringify(summary(f))}`;

    let msgs = (Array.isArray(q.body.messages) ? q.body.messages : [])
      .filter((m) => m && typeof m.text === 'string' && m.text.trim())
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text.slice(0, 4000) }] }));
    while (msgs.length && msgs[0].role === 'model') msgs.shift();
    const clean = [];
    for (const m of msgs) {
      if (clean.length && clean[clean.length - 1].role === m.role) {
        clean[clean.length - 1].parts[0].text += '\n' + m.parts[0].text;
      } else clean.push(m);
    }
    if (!clean.length || clean[0].role !== 'user') {
      return s.json({ reply: 'Send a message to start chatting.' });
    }

    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GK },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sys }] },
            contents: clean,
            generationConfig: { temperature: 0.6, maxOutputTokens: 800 },
          }),
        }
      );
      const j = await r.json();
      if (!r.ok) return s.json({ reply: j.error?.message || 'Gemini request failed.' });
      const reply = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || 'No reply from Gemini.';
      s.json({ reply });
    } catch (e) {
      console.error('chat error:', e.message);
      s.status(500).json({ reply: 'Could not reach Gemini.' });
    }
  })
);

app.listen(3000, () => console.log('http://localhost:3000'));