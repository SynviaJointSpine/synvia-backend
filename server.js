const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

const getClient = () => twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SYNVIA SMS Backend running', time: new Date().toISOString() });
});

// Send SMS to a lead
app.post('/send-sms', async (req, res) => {
  const { to, body, message } = req.body;
  const text = body || message; // accept both field names (SYNVIA OS sends `message`)
  if (!to || !text) return res.status(400).json({ error: 'Missing to or message body' });
  try {
    const msg = await getClient().messages.create({
      from: process.env.TWILIO_PHONE,
      to,
      body: text,
    });
    res.json({ sid: msg.sid, status: msg.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HOT lead alert — SMS + email
app.post('/notify', async (req, res) => {
  const lead = req.body;
  const results = {};

  // SMS to lead
  if (lead.phone) {
    const cleaned = lead.phone.replace(/\D/g, '');
    const toNumber = cleaned.startsWith('1') ? '+' + cleaned : '+1' + cleaned;
    const painLabels = { knee:'knee', hip:'hip', shoulder:'shoulder', spine:'back/spine', multiple:'joint' };
    const smsBody = `Hi ${lead.name.split(' ')[0]}, this is SYNVIA Joint & Spine in North Dallas. We received your request about your ${painLabels[lead.pain] || 'joint'} pain and want to get you scheduled right away. Do you have 10 minutes today to speak with our coordinator? Reply YES and we'll call you now. Reply STOP to opt out.`;
    try {
      const msg = await getClient().messages.create({
        from: process.env.TWILIO_PHONE,
        to: toNumber,
        body: smsBody,
      });
      results.sms = msg.sid;
    } catch (e) {
      results.sms_error = e.message;
    }
  }

  // Email via SendGrid
  if (process.env.SENDGRID_API_KEY) {
    const bucketColor = lead.bucket === 'HOT' ? '#E05252' : '#E09A30';
    try {
      const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: process.env.ALERT_EMAIL }] }],
          from: { email: process.env.FROM_EMAIL, name: 'SYNVIA CRM' },
          subject: `🔥 ${lead.bucket} Lead: ${lead.name} (Score ${lead.score}) — SYNVIA`,
          content: [{
            type: 'text/html',
            value: `<div style="font-family:Arial,sans-serif;max-width:560px">
              <div style="background:#0B1829;padding:20px"><h1 style="color:#C9A84C;margin:0">SYNVIA Joint & Spine</h1></div>
              <div style="padding:24px">
                <div style="background:${bucketColor}22;border:1px solid ${bucketColor};border-radius:8px;padding:12px 16px;margin-bottom:16px">
                  <strong style="color:${bucketColor};font-size:16px">🔥 ${lead.bucket} LEAD — Score: ${lead.score}/100</strong>
                </div>
                <table style="width:100%;font-size:14px;border-collapse:collapse">
                  <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #eee;width:35%">Name</td><td style="padding:7px 0;border-bottom:1px solid #eee;font-weight:600">${lead.name}</td></tr>
                  <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #eee">Phone</td><td style="padding:7px 0;border-bottom:1px solid #eee;font-weight:600">${lead.phone}</td></tr>
                  <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #eee">Pain area</td><td style="padding:7px 0;border-bottom:1px solid #eee">${lead.pain}</td></tr>
                  <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #eee">Timeline</td><td style="padding:7px 0;border-bottom:1px solid #eee">${lead.timeline}</td></tr>
                  <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #eee">Budget</td><td style="padding:7px 0;border-bottom:1px solid #eee">${lead.budget}</td></tr>
                  <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #eee">Source</td><td style="padding:7px 0;border-bottom:1px solid #eee">${lead.source}</td></tr>
                  ${lead.notes ? `<tr><td style="padding:7px 0;color:#666" valign="top">Notes</td><td style="padding:7px 0">${lead.notes}</td></tr>` : ''}
                </table>
                <p style="margin-top:20px;font-size:12px;color:#999">Call within 5 minutes for best close rate. — SYNVIA CRM</p>
              </div>
            </div>`
          }],
        }),
      });
      results.email = sgRes.ok ? 'sent' : `error ${sgRes.status}`;
    } catch (e) {
      results.email_error = e.message;
    }
  }

  res.json({ success: true, results });
});

// Receive inbound SMS from Twilio webhook
app.post('/inbound-sms', (req, res) => {
  const { From, Body } = req.body;
  console.log(`Inbound SMS from ${From}: ${Body}`);
  // Just acknowledge — CRM polls for new messages
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});


// ─── Claude AI proxy — keeps the Anthropic key server-side ─────────────────
app.post('/claude', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set in Render env' } });
    }
    const { model, max_tokens, system, messages } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'messages array required' } });
    }
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: Math.min(Number(max_tokens) || 2000, 4000), // cost guard
        system: system || '',
        messages
      })
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: 'Claude proxy error: ' + e.message } });
  }
});

/* ═══════════════════════════════════════════════════════════
   SYNVIA BACKEND — OS write endpoints (single paste, zero deps)
   Adds to your Express server:
     POST /update-lead     → writes VIP, scores, notes, pipeline
                             status to the "P1M Leads" sheet tab
     POST /execute-action  → executes approved recommendations
                             (publish_blog → Wix)

   PASTE: the entire file at the BOTTOM of your main server file
   (the one with /send-sms and /claude). No npm installs needed —
   uses only Node built-ins (crypto) and fetch (Node 18+).

   ENV VARS on Render (Dashboard → synvia-backend → Environment):
     GOOGLE_SA_EMAIL = service-account email (...@...iam.gserviceaccount.com)
     GOOGLE_SA_KEY   = the service account's private_key value
     WIX_API_KEY     = (optional, for blog publishing)
     WIX_SITE_ID     = (optional)
     WIX_MEMBER_ID   = (optional)

   GOOGLE SETUP (one time, ~5 min):
   1. console.cloud.google.com → select/create project
   2. "APIs & Services" → "Enabled APIs" → Enable "Google Sheets API"
   3. "IAM & Admin" → "Service Accounts" → "Create Service Account"
      → name: synvia-sheets-writer → Create → Done
   4. Click the new account → "Keys" → "Add Key" → "Create new key"
      → JSON → a file downloads
   5. Open the JSON: copy "client_email" → GOOGLE_SA_EMAIL on Render;
      copy "private_key" (the whole -----BEGIN...END----- string)
      → GOOGLE_SA_KEY on Render
   6. Open the GHL Google Sheet → Share → paste the client_email
      → role: Editor → Send
   7. Render redeploys on env-var save → done forever.
═══════════════════════════════════════════════════════════ */

const synviaCrypto = require('crypto');

const SYNVIA_SHEET_ID = '1SI0gUor4T-JuQgOVoP6FxhwWYW7iaBBWbflT-jW_hnI';
const SYNVIA_LEADS_TAB = 'P1M Leads';
const SYNVIA_WRITABLE = ['VIP', 'Qualifier Score', 'Consult Score', 'Consult Note', 'Value', 'Notes', 'Scheduled', 'Showed', 'Closed'];

/* ── Google auth: service-account JWT → access token (no libraries) ── */
let synviaTokenCache = { token: null, exp: 0 };
async function synviaSheetsToken() {
  if (synviaTokenCache.token && Date.now() < synviaTokenCache.exp - 60000) return synviaTokenCache.token;
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Google credentials not configured on Render (GOOGLE_SA_EMAIL / GOOGLE_SA_KEY)');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  });
  const signature = synviaCrypto.createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${signature}`,
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error('Google token error: ' + (data.error_description || data.error || resp.status));
  synviaTokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return synviaTokenCache.token;
}

async function synviaSheets(path, opts = {}) {
  const token = await synviaSheetsToken();
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SYNVIA_SHEET_ID}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('Sheets API: ' + (data.error?.message || resp.status));
  return data;
}

const synviaDigits = (s) => String(s || '').replace(/\D/g, '');
const synviaCol = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/* ── POST /update-lead ──
   Body: { phone, lastName, firstName, fields: {"VIP":"TRUE", ...} }
   Matches by phone digits (fallback last+first name); auto-creates
   missing header columns; writes each field to the matched row. */
app.post('/update-lead', async (req, res) => {
  try {
    const { phone, lastName, firstName, fields } = req.body || {};
    if (!fields || !Object.keys(fields).length) return res.status(400).json({ success: false, error: 'No fields provided' });
    const bad = Object.keys(fields).filter((k) => !SYNVIA_WRITABLE.includes(k));
    if (bad.length) return res.status(400).json({ success: false, error: 'Field not writable: ' + bad.join(', ') });
    if (!synviaDigits(phone) && !(lastName && firstName)) return res.status(400).json({ success: false, error: 'Need phone or first+last name' });

    const sheet = await synviaSheets(`/values/${encodeURIComponent(`'${SYNVIA_LEADS_TAB}'`)}`);
    const rows = sheet.values || [];
    if (!rows.length) return res.status(500).json({ success: false, error: 'Sheet tab is empty' });
    const headers = rows[0].map((h) => String(h || '').trim());

    // Create any missing header columns
    const newHeaders = [];
    for (const k of Object.keys(fields)) {
      if (!headers.includes(k)) { headers.push(k); newHeaders.push({ range: `'${SYNVIA_LEADS_TAB}'!${synviaCol(headers.length - 1)}1`, values: [[k]] }); }
    }
    if (newHeaders.length) {
      await synviaSheets('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: newHeaders }) });
    }

    // Find the row
    const pCol = headers.indexOf('Phone'), lCol = headers.indexOf('Last Name'), fCol = headers.indexOf('First Name');
    const want = synviaDigits(phone);
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) if (want && pCol >= 0 && synviaDigits(rows[i][pCol]) === want) { rowIdx = i; break; }
    if (rowIdx === -1 && lastName && firstName && lCol >= 0 && fCol >= 0) {
      const ln = String(lastName).trim().toLowerCase(), fn = String(firstName).trim().toLowerCase();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][lCol] || '').trim().toLowerCase() === ln && String(rows[i][fCol] || '').trim().toLowerCase() === fn) { rowIdx = i; break; }
      }
    }
    if (rowIdx === -1) return res.status(404).json({ success: false, error: 'Lead not found (no phone/name match)' });

    const data = Object.entries(fields).map(([k, v]) => ({ range: `'${SYNVIA_LEADS_TAB}'!${synviaCol(headers.indexOf(k))}${rowIdx + 1}`, values: [[String(v)]] }));
    await synviaSheets('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });

    return res.json({ success: true, updated: Object.keys(fields), row: rowIdx + 1 });
  } catch (err) {
    console.error('update-lead error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── POST /execute-action — approved recommendations, zero follow-up ── */
function synviaWixHeaders() {
  return { 'Content-Type': 'application/json', Authorization: process.env.WIX_API_KEY, 'wix-site-id': process.env.WIX_SITE_ID };
}
function synviaToRicos(body) {
  const nodes = []; let id = 0;
  const tn = (text) => ({ type: 'TEXT', id: '', nodes: [], textData: { text, decorations: [] } });
  for (const raw of String(body).split(/\n\s*\n/)) {
    for (const line of raw.split('\n')) {
      const clean = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').trim();
      if (!clean) continue;
      const h = clean.match(/^(#{2,4})\s+(.*)$/);
      if (h) nodes.push({ type: 'HEADING', id: 'h' + (++id), nodes: [tn(h[2])], headingData: { level: h[1].length } });
      else if (/^[-•]\s+/.test(clean)) nodes.push({ type: 'PARAGRAPH', id: 'p' + (++id), nodes: [tn('•  ' + clean.replace(/^[-•]\s+/, ''))], paragraphData: {} });
      else nodes.push({ type: 'PARAGRAPH', id: 'p' + (++id), nodes: [tn(clean)], paragraphData: {} });
    }
  }
  return { nodes };
}
const SYNVIA_ACTIONS = {
  async publish_blog(payload) {
    const { title, meta, body, tags } = payload || {};
    if (!title || !body) throw new Error('publish_blog needs title and body');
    if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID || !process.env.WIX_MEMBER_ID) {
      throw new Error('Wix credentials not configured on Render (WIX_API_KEY / WIX_SITE_ID / WIX_MEMBER_ID)');
    }
    const dRes = await fetch('https://www.wixapis.com/blog/v3/draft-posts', {
      method: 'POST', headers: synviaWixHeaders(),
      body: JSON.stringify({ draftPost: {
        title: String(title).slice(0, 200), memberId: process.env.WIX_MEMBER_ID,
        excerpt: (meta || '').slice(0, 500), richContent: synviaToRicos(body),
        seoData: meta ? { tags: [{ type: 'meta', props: { name: 'description', content: meta } }] } : undefined,
      }, fieldsets: ['URL'] }),
    });
    const dData = await dRes.json().catch(() => ({}));
    if (!dRes.ok) throw new Error('Wix draft failed: ' + (dData.message || dRes.status));
    const draftId = dData.draftPost && dData.draftPost.id;
    if (!draftId) throw new Error('Wix returned no draft id');
    const pRes = await fetch(`https://www.wixapis.com/blog/v3/draft-posts/${draftId}/publish`, { method: 'POST', headers: synviaWixHeaders(), body: '{}' });
    const pData = await pRes.json().catch(() => ({}));
    if (!pRes.ok) throw new Error('Wix publish failed: ' + (pData.message || pRes.status));
    const url = (dData.draftPost && dData.draftPost.url)
      ? `${dData.draftPost.url.base || 'https://www.synviajointandspine.com'}${dData.draftPost.url.path || ''}`
      : 'https://www.synviajointandspine.com/blog';
    return { url, postId: pData.postId || draftId, tags: tags || '' };
  },
};
app.post('/execute-action', async (req, res) => {
  try {
    const { type, payload } = req.body || {};
    const handler = SYNVIA_ACTIONS[type];
    if (!handler) return res.status(400).json({ success: false, error: 'Unknown action type: ' + type });
    const result = await handler(payload);
    console.log(`execute-action ✓ ${type}`, result.url || '');
    return res.json({ success: true, type, ...result });
  } catch (err) {
    console.error('execute-action error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});



/* ── Generic keyed records: /save-record + /get-records ──
   Lets any OS component persist data in its own tab of the clinic
   sheet (care plans today; anything tomorrow — no backend changes).
   Tabs are auto-created with a 'Key' column + field columns.        */
const SYNVIA_RECORD_TABS = ['OS CarePlans', 'OS Settings', 'OS Notes'];

async function synviaEnsureTab(tab) {
  const meta = await synviaSheets('?fields=sheets.properties');
  const exists = (meta.sheets || []).some((s) => s.properties && s.properties.title === tab);
  if (!exists) {
    await synviaSheets(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) });
    await synviaSheets(`/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [['Key']] }) });
  }
}

app.post('/save-record', async (req, res) => {
  try {
    const { tab, key, fields } = req.body || {};
    if (!SYNVIA_RECORD_TABS.includes(tab)) return res.status(400).json({ success: false, error: 'Unknown record tab: ' + tab });
    if (!key || !fields || !Object.keys(fields).length) return res.status(400).json({ success: false, error: 'Need key and fields' });

    await synviaEnsureTab(tab);
    const sheet = await synviaSheets(`/values/${encodeURIComponent(`'${tab}'`)}`);
    const rows = sheet.values || [['Key']];
    const headers = (rows[0] || ['Key']).map((h) => String(h || '').trim());
    if (!headers.includes('Key')) headers.unshift('Key');

    // Ensure all field columns exist
    const newHeaders = [];
    for (const k of Object.keys(fields)) {
      if (!headers.includes(k)) { headers.push(k); newHeaders.push({ range: `'${tab}'!${synviaCol(headers.length - 1)}1`, values: [[k]] }); }
    }
    if (newHeaders.length) await synviaSheets('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: newHeaders }) });

    // Upsert by Key (case-insensitive)
    const keyCol = headers.indexOf('Key');
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][keyCol] || '').trim().toLowerCase() === String(key).trim().toLowerCase()) { rowIdx = i; break; }
    }
    if (rowIdx === -1) rowIdx = rows.length; // append as new row

    const data = [{ range: `'${tab}'!${synviaCol(keyCol)}${rowIdx + 1}`, values: [[String(key)]] }]
      .concat(Object.entries(fields).map(([k, v]) => ({ range: `'${tab}'!${synviaCol(headers.indexOf(k))}${rowIdx + 1}`, values: [[String(v)]] })));
    await synviaSheets('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });

    return res.json({ success: true, tab, key, row: rowIdx + 1 });
  } catch (err) {
    console.error('save-record error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/get-records', async (req, res) => {
  try {
    const tab = String(req.query.tab || '');
    if (!SYNVIA_RECORD_TABS.includes(tab)) return res.status(400).json({ success: false, error: 'Unknown record tab: ' + tab });
    await synviaEnsureTab(tab);
    const sheet = await synviaSheets(`/values/${encodeURIComponent(`'${tab}'`)}`);
    const rows = sheet.values || [];
    if (rows.length < 1) return res.json({ success: true, records: [] });
    const headers = rows[0].map((h) => String(h || '').trim());
    const records = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
    return res.json({ success: true, records });
  } catch (err) {
    console.error('get-records error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


app.listen(PORT, () => console.log(`SYNVIA backend running on port ${PORT}`));
