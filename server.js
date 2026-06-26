const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Load PDF generator and logo lazily so startup never crashes
let generateIntakePDF = null;
let LOGO_BUFFER = null;
try {
  generateIntakePDF = require('./generateIntakePDF').generateIntakePDF;
  // Try multiple possible logo locations
  const logoPaths = [
    path.join(__dirname, 'synvia_logo.png'),
    path.join(__dirname, 'synvia-backend', 'synvia_logo.png'),
  ];
  for (const p of logoPaths) {
    if (fs.existsSync(p)) { LOGO_BUFFER = fs.readFileSync(p); break; }
  }
  if (!LOGO_BUFFER) console.warn('[intake-pdf] WARNING: synvia_logo.png not found');
  else console.log('[intake-pdf] Logo loaded OK');
} catch (e) {
  console.warn('[intake-pdf] WARNING: generateIntakePDF not loaded:', e.message);
}

const getClient = () => twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'SYNVIA SMS Backend running', time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// ANTHROPIC PROXY
// ═══════════════════════════════════════════════════════════════
app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// TWILIO SMS
// ═══════════════════════════════════════════════════════════════
app.post('/send-sms', async (req, res) => {
  const { to, body, from } = req.body;
  try {
    const client = getClient();
    const message = await client.messages.create({
      body,
      from: from || process.env.TWILIO_FROM_NUMBER,
      to,
    });
    res.json({ success: true, sid: message.sid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// OS SYNC
// ═══════════════════════════════════════════════════════════════
app.post('/sheets-write', async (req, res) => {
  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) return res.status(500).json({ success: false, error: 'APPS_SCRIPT_URL not set' });
    const sharedSecret = process.env.SHARED_SECRET;
    if (sharedSecret) {
      const incoming = req.headers['x-shared-secret'] || req.body?.secret;
      if (incoming !== sharedSecret) return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const response = await fetch(appsScriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body), redirect: 'follow' });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(response.status).json({ success: response.ok, ...data });
  } catch (err) {
    console.error('sheets-write error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PATIENT EHR
// ═══════════════════════════════════════════════════════════════
app.post('/ehr/save', async (req, res) => {
  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) return res.status(500).json({ success: false, error: 'APPS_SCRIPT_URL not configured' });
    const { patientId, patientMeta, chartData, soapSessions, evalSessions } = req.body;
    if (!patientId) return res.status(400).json({ success: false, error: 'patientId required' });
    const payload = { type: 'EHR_SAVE', patientId, patientMeta, chartData, soapSessions, evalSessions, savedAt: new Date().toISOString() };
    const response = await fetch(appsScriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'follow' });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(response.ok ? 200 : 502).json({ success: response.ok, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/ehr/load/:patientId', async (req, res) => {
  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) return res.status(500).json({ success: false, error: 'APPS_SCRIPT_URL not configured' });
    const response = await fetch(appsScriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'EHR_LOAD', patientId: req.params.patientId }), redirect: 'follow' });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(response.ok ? 200 : 502).json({ success: response.ok, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/ehr/all', async (req, res) => {
  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) return res.status(500).json({ success: false, error: 'APPS_SCRIPT_URL not configured' });
    const response = await fetch(appsScriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'EHR_LOAD_ALL' }), redirect: 'follow' });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(response.ok ? 200 : 502).json({ success: response.ok, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/ehr/delete/:patientId', async (req, res) => {
  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) return res.status(500).json({ success: false, error: 'APPS_SCRIPT_URL not configured' });
    const response = await fetch(appsScriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'EHR_DELETE', patientId: req.params.patientId }), redirect: 'follow' });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(response.ok ? 200 : 502).json({ success: response.ok, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GHL OAUTH
// ═══════════════════════════════════════════════════════════════
app.get('/ghl/auth', (req, res) => {
  const clientId = process.env.GHL_CLIENT_ID;
  const redirectUri = process.env.GHL_REDIRECT_URI || 'https://synvia-backend.onrender.com/ghl/callback';
  const scope = 'contacts.readonly contacts.write conversations/message.write workflows.readonly calendars/events.readonly locations.readonly';
  res.redirect(`https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${clientId}&scope=${encodeURIComponent(scope)}`);
});

app.get('/ghl/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received from GHL');
  try {
    const resp = await fetch('https://services.leadconnectorhq.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, redirect_uri: process.env.GHL_REDIRECT_URI || 'https://synvia-backend.onrender.com/ghl/callback' }),
    });
    const data = await resp.json();
    if (data.access_token) {
      global.GHL_ACCESS_TOKEN = data.access_token;
      global.GHL_REFRESH_TOKEN = data.refresh_token;
      global.GHL_LOCATION_ID = data.locationId || process.env.GHL_LOCATION_ID;
      global.GHL_TOKEN_EXPIRY = Date.now() + (data.expires_in * 1000);
      res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#0F1E3D;color:#F5F1E8"><h2 style="color:#C9A961">✓ GHL Connected</h2><p>Location: ${global.GHL_LOCATION_ID}</p><a href="https://synviajointandspine.netlify.app" style="color:#18B6C8">← Return to SYNVIA OS</a></body></html>`);
    } else {
      res.status(400).json({ error: 'Token exchange failed', details: data });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function refreshGHLToken() {
  if (!global.GHL_REFRESH_TOKEN) return false;
  try {
    const resp = await fetch('https://services.leadconnectorhq.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: global.GHL_REFRESH_TOKEN, client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET }) });
    const data = await resp.json();
    if (data.access_token) { global.GHL_ACCESS_TOKEN = data.access_token; global.GHL_REFRESH_TOKEN = data.refresh_token || global.GHL_REFRESH_TOKEN; global.GHL_TOKEN_EXPIRY = Date.now() + (data.expires_in * 1000); return true; }
  } catch (e) { console.error('Token refresh error:', e.message); }
  return false;
}

async function ghlApi(p, opts = {}) {
  if (global.GHL_TOKEN_EXPIRY && Date.now() > global.GHL_TOKEN_EXPIRY - 300000) await refreshGHLToken();
  if (!global.GHL_ACCESS_TOKEN) throw new Error('GHL not connected');
  const res = await fetch('https://services.leadconnectorhq.com' + p, { headers: { 'Authorization': 'Bearer ' + global.GHL_ACCESS_TOKEN, 'Content-Type': 'application/json', 'Version': '2021-07-28', ...opts.headers }, ...opts });
  if (!res.ok) { const txt = await res.text().catch(() => ''); throw new Error(`GHL ${res.status}: ${txt.slice(0, 200)}`); }
  return res.json();
}

app.post('/ghl/action', async (req, res) => {
  const { type, contact_phone, contact_email, contact_name } = req.body;
  const locId = global.GHL_LOCATION_ID || process.env.GHL_LOCATION_ID;
  try {
    let contactId = null;
    const searchVal = contact_phone || contact_email;
    if (searchVal) { const s = await ghlApi(`/contacts/?locationId=${locId}&query=${encodeURIComponent(searchVal)}&limit=1`); contactId = (s.contacts || [])[0]?.id || null; }
    if (!contactId && type !== 'test') return res.status(404).json({ success: false, error: `Contact not found: ${searchVal}` });
    let result = {};
    switch (type) {
      case 'test': result = { message: 'GHL connection working', timestamp: new Date().toISOString() }; break;
      case 'move_stage': { await ghlApi(`/contacts/${contactId}`, { method: 'PUT', body: JSON.stringify({ tags: [req.body.new_stage] }) }); result = { success: true }; break; }
      case 'fire_workflow': { const wfId = process.env['GHL_WF_' + req.body.workflow.toUpperCase()]; if (!wfId) return res.status(400).json({ success: false, error: 'Workflow env var not set' }); await ghlApi(`/contacts/${contactId}/workflow/${wfId}`, { method: 'POST', body: JSON.stringify({}) }); result = { success: true }; break; }
      case 'send_sms': { await ghlApi('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message: req.body.message }) }); result = { success: true }; break; }
      case 'add_note': { await ghlApi(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: req.body.note }) }); result = { success: true }; break; }
      case 'add_tag': { const c = await ghlApi(`/contacts/${contactId}`); await ghlApi(`/contacts/${contactId}`, { method: 'PUT', body: JSON.stringify({ tags: [...new Set([...(c.contact?.tags || []), req.body.tag])] }) }); result = { success: true }; break; }
      case 'remove_tag': { const c = await ghlApi(`/contacts/${contactId}`); await ghlApi(`/contacts/${contactId}`, { method: 'PUT', body: JSON.stringify({ tags: (c.contact?.tags || []).filter(t => t !== req.body.tag) }) }); result = { success: true }; break; }
      case 'get_contacts': { result = await ghlApi(`/contacts/?locationId=${locId}&limit=${req.body.limit||100}${req.body.query?'&query='+encodeURIComponent(req.body.query):''}`); break; }
      case 'get_appointments': { const today = new Date().toISOString().split('T')[0]; const end = new Date(Date.now()+14*86400000).toISOString().split('T')[0]; result = await ghlApi(`/calendars/events?locationId=${locId}&startTime=${today}&endTime=${end}&limit=50`); break; }
      case 'get_workflows': { result = await ghlApi(`/workflows/?locationId=${locId}`); break; }
      default: return res.status(400).json({ success: false, error: `Unknown action: ${type}` });
    }
    res.json({ success: true, type, result });
  } catch (err) { console.error('GHL action error:', err.message); res.status(500).json({ success: false, error: err.message }); }
});

app.get('/ghl/status', (req, res) => {
  res.json({ connected: !!global.GHL_ACCESS_TOKEN, locationId: global.GHL_LOCATION_ID || null, tokenExpiry: global.GHL_TOKEN_EXPIRY ? new Date(global.GHL_TOKEN_EXPIRY).toISOString() : null });
});

// ═══════════════════════════════════════════════════════════════
// INTAKE SUBMIT (original)
// ═══════════════════════════════════════════════════════════════
app.post('/intake-submit', async (req, res) => {
  try {
    const payload = { type: 'INTAKE_SUBMISSION', status: 'UNREAD', submittedAt: new Date().toISOString(), source: 'synviaintakeform.netlify.app', patient: req.body };
    const scriptUrl = process.env.APPS_SCRIPT_URL;
    if (!scriptUrl) return res.status(500).json({ success: false, message: 'APPS_SCRIPT_URL not configured' });
    const scriptRes = await fetch(scriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!scriptRes.ok) { const errText = await scriptRes.text(); return res.status(502).json({ success: false, detail: errText }); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// INTAKE PDF — SJS PDF → email
// ═══════════════════════════════════════════════════════════════
app.post('/intake-pdf', async (req, res) => {
  try {
    const data = req.body;
    console.log(`[intake-pdf] Received: ${data.firstName} ${data.lastName}`);

    if (!generateIntakePDF) return res.status(500).json({ success: false, error: 'PDF generator not loaded' });
    if (!LOGO_BUFFER) return res.status(500).json({ success: false, error: 'Logo file not found' });

    const pdfBuffer = await generateIntakePDF(data, LOGO_BUFFER);
    const patientName = `${(data.firstName||'').trim()} ${(data.lastName||'').trim()}`.trim() || 'New Patient';
    const submittedAt = data.submittedAt
      ? new Date(data.submittedAt).toLocaleString('en-US', { timeZone: 'America/Chicago' })
      : new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });

    await sgMail.send({
      to:      process.env.ALERT_EMAIL || 'info@synviajointandspine.com',
      from:    process.env.FROM_EMAIL,
      subject: `New Patient Intake — ${patientName}`,
      text:    `New intake: ${patientName} | ${data.cell} | ${data.chief} | Pain: ${data.pain}/10 | ${submittedAt} CT`,
      html: `<div style="font-family:Helvetica,sans-serif;max-width:540px;color:#1A202C"><div style="border-bottom:2px solid #0F2550;padding-bottom:12px;margin-bottom:20px"><span style="font-size:18px;font-weight:bold;color:#0F2550">SYNVIA Joint &amp; Spine</span><br><span style="font-size:12px;color:#4A5568">New Patient Intake Received</span></div><table style="width:100%;font-size:13px"><tr><td style="color:#4A5568;padding:4px 0;width:120px">PATIENT</td><td style="font-weight:bold">${patientName}</td></tr><tr><td style="color:#4A5568;padding:4px 0">DOB</td><td>${data.dob||'—'}</td></tr><tr><td style="color:#4A5568;padding:4px 0">PHONE</td><td>${data.cell||'—'}</td></tr><tr><td style="color:#4A5568;padding:4px 0">EMAIL</td><td>${data.email||'—'}</td></tr><tr><td style="color:#4A5568;padding:4px 0">CHIEF COMPLAINT</td><td style="font-weight:bold">${data.chief||'—'}</td></tr><tr><td style="color:#4A5568;padding:4px 0">PAIN SCORE</td><td style="font-weight:bold;color:#C0392B;font-size:16px">${data.pain||'—'} / 10</td></tr><tr><td style="color:#4A5568;padding:4px 0">SUBMITTED</td><td>${submittedAt} CT</td></tr></table><p style="margin-top:20px;font-size:12px;color:#4A5568">Full intake attached as PDF.</p></div>`,
      attachments: [{ content: pdfBuffer.toString('base64'), filename: `SYNVIA_Intake_${patientName.replace(/\s+/g,'_')}.pdf`, type: 'application/pdf', disposition: 'attachment' }],
    });

    console.log(`[intake-pdf] Email sent for ${patientName}`);

    const scriptUrl = process.env.APPS_SCRIPT_URL;
    if (scriptUrl) {
      fetch(scriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'INTAKE_SUBMISSION', status: 'UNREAD', submittedAt: new Date().toISOString(), source: 'synviaintakeform.netlify.app', patient: data }) })
        .catch(e => console.error('[intake-pdf] Apps Script error:', e.message));
    }

    res.json({ success: true, message: `Intake PDF emailed for ${patientName}` });
  } catch (err) {
    console.error('[intake-pdf] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
// ============================================================
// SYNVIA REVENUE SYNC ROUTES
// Add these routes to your existing server.js on Render.
// Paste BEFORE the last line: app.listen(PORT, ...)
// No new dependencies needed — uses fs, path (already imported).
// ============================================================

// ── helper: read all patient JSONs from disk ──────────────────
function getAllPatients() {
  const dir = '/data/patients';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch(e) { return null; }
    })
    .filter(Boolean);
}

// ── helper: extract billed amount from a treatment plan ──────
function extractBilled(tp) {
  if (!tp) return 0;
  // Treatment Plan stores paymentOptions with per-option prices
  // and injectionRows / therapyRows with quantities
  let total = 0;
  // Try payInFull price first (most accurate single-number)
  if (tp.payInFull && tp.payInFull > 0) return Number(tp.payInFull);
  // Fall back to summing injection + therapy line items
  const rows = [...(tp.injectionRows || []), ...(tp.therapyRows || [])];
  rows.forEach(r => {
    const qty   = Number(r.qty || r.quantity || 1);
    const price = Number(r.price || r.unitPrice || r.cost || 0);
    total += qty * price;
  });
  // Last resort: payAsYouGo total
  if (!total && tp.payAsYouGo) total = Number(tp.payAsYouGo);
  return total;
}

// ── helper: extract month label from a date string ───────────
function toMonthKey(dateStr) {
  if (!dateStr) return 'Unknown';
  const d = new Date(dateStr);
  if (isNaN(d)) return 'Unknown';
  return d.toLocaleString('en-US', { month: 'short', year: '2-digit' }); // "Mar 26"
}

// ────────────────────────────────────────────────────────────
// GET /revenue/summary
// Returns aggregated revenue derived from all patient JSON files.
// Used by the Revenue Dashboard for EHR-side ground truth.
// ────────────────────────────────────────────────────────────
app.get('/revenue/summary', (req, res) => {
  // Optional API key check (same key as EHR routes)
  const key = req.headers['x-api-key'] || req.query.key;
  if (process.env.EHR_API_KEY && key !== process.env.EHR_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const patients = getAllPatients();
    let grandTotal = 0;
    const byProvider   = {};
    const byMonth      = {};
    const byTreatment  = {};
    const patientRows  = [];

    patients.forEach(p => {
      const name     = p.patient?.name || p.name || 'Unknown';
      const provider = p.history?.provider || p.examination?.provider || 'Unassigned';
      const createdAt= p.createdAt || p.patient?.createdAt || null;
      const monthKey = toMonthKey(createdAt);
      const billed   = extractBilled(p.treatmentPlan);

      grandTotal += billed;

      // by provider
      byProvider[provider] = (byProvider[provider] || 0) + billed;

      // by month
      byMonth[monthKey] = (byMonth[monthKey] || 0) + billed;

      // by treatment type (from injection/therapy rows)
      const rows = [
        ...(p.treatmentPlan?.injectionRows || []),
        ...(p.treatmentPlan?.therapyRows   || [])
      ];
      rows.forEach(r => {
        const tName = r.name || r.type || r.treatment || 'Other';
        const qty   = Number(r.qty || r.quantity || 1);
        const price = Number(r.price || r.unitPrice || r.cost || 0);
        byTreatment[tName] = (byTreatment[tName] || 0) + (qty * price);
      });

      // patient-level row for drilldown table
      patientRows.push({
        name,
        provider,
        monthKey,
        billed,
        dob:       p.patient?.dob     || p.dob     || null,
        phone:     p.patient?.phone   || p.phone   || null,
        condition: p.history?.primaryComplaint || p.examination?.primaryComplaint || null,
        soapCount: (p.soapNotes || []).length,
        hasPhoto:  !!p.photoUrl,
      });
    });

    // Sort month keys chronologically
    const monthOrder = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sortedMonths = Object.entries(byMonth).sort(([a],[b]) => {
      const [aM, aY] = a.split(' ');
      const [bM, bY] = b.split(' ');
      if (aY !== bY) return Number(aY) - Number(bY);
      return monthOrder.indexOf(aM) - monthOrder.indexOf(bM);
    });

    res.json({
      ok: true,
      generatedAt:   new Date().toISOString(),
      totalPatients: patients.length,
      grandTotal,
      byMonth:       Object.fromEntries(sortedMonths),
      byMonthSorted: sortedMonths.map(([k, v]) => ({ month: k, revenue: v })),
      byProvider,
      byTreatment,
      patients: patientRows.sort((a, b) => b.billed - a.billed),
    });
  } catch (err) {
    console.error('[revenue/summary]', err);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /revenue/patient/:id
// Returns revenue detail for a single patient by name-slug or DOB key.
// id format: "firstname-lastname-YYYYMMDD"  (same as filename without .json)
// ────────────────────────────────────────────────────────────
app.get('/revenue/patient/:id', (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (process.env.EHR_API_KEY && key !== process.env.EHR_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const filePath = `/data/patients/${req.params.id}.json`;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Patient not found' });
  }
  try {
    const p      = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const billed = extractBilled(p.treatmentPlan);
    res.json({
      ok: true,
      name:    p.patient?.name,
      billed,
      treatmentPlan: p.treatmentPlan || null,
      soapNotes:     (p.soapNotes || []).map(n => ({
        date:  n.date,
        pain:  n.pain,
        subj:  n.sComplaint || n.subjective,
        plan:  n.plan,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// POST /revenue/manual
// Lets the dashboard push a manual revenue entry (e.g. from
// Google Sheets rows that don't map to a patient chart yet).
// Body: { month, label, amount, source, apiKey }
// Appended to /data/revenue_manual.json
// ────────────────────────────────────────────────────────────
app.post('/revenue/manual', (req, res) => {
  const key = req.headers['x-api-key'] || req.body?.apiKey;
  if (process.env.EHR_API_KEY && key !== process.env.EHR_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { month, label, amount, source } = req.body || {};
  if (!amount || isNaN(Number(amount))) {
    return res.status(400).json({ error: 'amount is required and must be numeric' });
  }
  const manualFile = '/data/revenue_manual.json';
  let entries = [];
  if (fs.existsSync(manualFile)) {
    try { entries = JSON.parse(fs.readFileSync(manualFile, 'utf8')); } catch(e) {}
  }
  const entry = { id: Date.now(), month, label, amount: Number(amount), source, addedAt: new Date().toISOString() };
  entries.push(entry);
  fs.writeFileSync(manualFile, JSON.stringify(entries, null, 2));
  res.json({ ok: true, entry });
});app.listen(PORT, () => {
  console.log(`SYNVIA Backend running on port ${PORT}`);
});
