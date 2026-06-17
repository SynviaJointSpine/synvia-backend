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

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'SYNVIA SMS Backend running', time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// ANTHROPIC PROXY — existing endpoint
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
// TWILIO SMS — existing endpoint
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
// OS SYNC — Google Sheets write bridge
// POST /sheets-write
// Proxies to the Apps Script /exec URL stored in APPS_SCRIPT_URL env var.
// Accepts any JSON body and forwards it straight through.
// Optional header: x-shared-secret (must match SHARED_SECRET env var if set)
// ═══════════════════════════════════════════════════════════════
app.post('/sheets-write', async (req, res) => {
  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) {
      return res.status(500).json({ success: false, error: 'APPS_SCRIPT_URL env var not set on Render' });
    }

    // Optional shared-secret auth check
    const sharedSecret = process.env.SHARED_SECRET;
    if (sharedSecret) {
      const incoming = req.headers['x-shared-secret'] || req.body?.secret;
      if (incoming !== sharedSecret) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
    }

    const payload = req.body;
    const response = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(response.status).json({ success: response.ok, ...data });
  } catch (err) {
    console.error('sheets-write error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GHL OAUTH — get an access token via GHL's OAuth flow
// ═══════════════════════════════════════════════════════════════
app.get('/ghl/auth', (req, res) => {
  const clientId = process.env.GHL_CLIENT_ID;
  const redirectUri = process.env.GHL_REDIRECT_URI || 'https://synvia-backend.onrender.com/ghl/callback';
  const scope = 'contacts.readonly contacts.write conversations/message.write workflows.readonly calendars/events.readonly locations.readonly';
  const authUrl = `https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${clientId}&scope=${encodeURIComponent(scope)}`;
  res.redirect(authUrl);
});

app.get('/ghl/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received from GHL');
  try {
    const resp = await fetch('https://services.leadconnectorhq.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
        redirect_uri: process.env.GHL_REDIRECT_URI || 'https://synvia-backend.onrender.com/ghl/callback',
      }),
    });
    const data = await resp.json();
    if (data.access_token) {
      global.GHL_ACCESS_TOKEN = data.access_token;
      global.GHL_REFRESH_TOKEN = data.refresh_token;
      global.GHL_LOCATION_ID = data.locationId || process.env.GHL_LOCATION_ID;
      global.GHL_TOKEN_EXPIRY = Date.now() + (data.expires_in * 1000);
      console.log('GHL OAuth success. Location:', global.GHL_LOCATION_ID);
      res.send(`
        <html><body style="font-family:sans-serif;padding:40px;background:#0F1E3D;color:#F5F1E8">
          <h2 style="color:#C9A961">✓ GHL Connected</h2>
          <p>SYNVIA OS is now connected to GoHighLevel.</p>
          <p style="font-size:12px;color:rgba(245,241,232,0.5)">Location ID: ${global.GHL_LOCATION_ID}</p>
          <p style="font-size:12px;color:rgba(245,241,232,0.5)">Token expires: ${new Date(global.GHL_TOKEN_EXPIRY).toLocaleString()}</p>
          <p style="margin-top:20px"><a href="https://synviajointandspine.netlify.app" style="color:#18B6C8">← Return to SYNVIA OS</a></p>
        </body></html>
      `);
    } else {
      res.status(400).json({ error: 'Token exchange failed', details: data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function refreshGHLToken() {
  if (!global.GHL_REFRESH_TOKEN) return false;
  try {
    const resp = await fetch('https://services.leadconnectorhq.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: global.GHL_REFRESH_TOKEN,
        client_id: process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
      }),
    });
    const data = await resp.json();
    if (data.access_token) {
      global.GHL_ACCESS_TOKEN = data.access_token;
      global.GHL_REFRESH_TOKEN = data.refresh_token || global.GHL_REFRESH_TOKEN;
      global.GHL_TOKEN_EXPIRY = Date.now() + (data.expires_in * 1000);
      console.log('GHL token refreshed');
      return true;
    }
  } catch (e) { console.error('Token refresh error:', e.message); }
  return false;
}

async function ghlApi(path, opts = {}) {
  if (global.GHL_TOKEN_EXPIRY && Date.now() > global.GHL_TOKEN_EXPIRY - 300000) {
    await refreshGHLToken();
  }
  if (!global.GHL_ACCESS_TOKEN) throw new Error('GHL not connected — visit /ghl/auth first');
  const url = 'https://services.leadconnectorhq.com' + path;
  const res = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + global.GHL_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      'Version': '2021-07-28',
      ...opts.headers,
    },
    ...opts,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GHL ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

app.post('/ghl/action', async (req, res) => {
  const { type, contact_phone, contact_email, contact_name } = req.body;
  const locId = global.GHL_LOCATION_ID || process.env.GHL_LOCATION_ID;

  try {
    let contactId = null;
    const searchVal = contact_phone || contact_email;
    if (searchVal) {
      const searchResp = await ghlApi(
        `/contacts/?locationId=${locId}&query=${encodeURIComponent(searchVal)}&limit=1`
      );
      contactId = (searchResp.contacts || [])[0]?.id || null;
    }

    if (!contactId && type !== 'test') {
      return res.status(404).json({ success: false, error: `Contact not found: ${searchVal}` });
    }

    let result = {};

    switch (type) {
      case 'test':
        result = { message: 'SYNVIA OS → GHL connection working', timestamp: new Date().toISOString() };
        break;
      case 'move_stage': {
        const { new_stage } = req.body;
        await ghlApi(`/contacts/${contactId}`, { method: 'PUT', body: JSON.stringify({ tags: [new_stage] }) });
        result = { success: true, stage: new_stage, contact: contact_name };
        break;
      }
      case 'fire_workflow': {
        const { workflow, workflow_name } = req.body;
        const wfId = process.env['GHL_WF_' + workflow.toUpperCase()];
        if (!wfId) return res.status(400).json({ success: false, error: `Workflow env var GHL_WF_${workflow.toUpperCase()} not set in Render` });
        await ghlApi(`/contacts/${contactId}/workflow/${wfId}`, { method: 'POST', body: JSON.stringify({}) });
        result = { success: true, workflow: workflow_name || workflow, contact: contact_name };
        break;
      }
      case 'send_sms': {
        const { message } = req.body;
        await ghlApi('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message }) });
        result = { success: true, sms: 'sent', contact: contact_name };
        break;
      }
      case 'add_note': {
        const { note } = req.body;
        await ghlApi(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: note }) });
        result = { success: true, note: 'added', contact: contact_name };
        break;
      }
      case 'add_tag': {
        const { tag } = req.body;
        const contact = await ghlApi(`/contacts/${contactId}`);
        const newTags = [...new Set([...(contact.contact?.tags || []), tag])];
        await ghlApi(`/contacts/${contactId}`, { method: 'PUT', body: JSON.stringify({ tags: newTags }) });
        result = { success: true, tag, contact: contact_name };
        break;
      }
      case 'remove_tag': {
        const { tag } = req.body;
        const contact = await ghlApi(`/contacts/${contactId}`);
        const filtered = (contact.contact?.tags || []).filter(t => t !== tag);
        await ghlApi(`/contacts/${contactId}`, { method: 'PUT', body: JSON.stringify({ tags: filtered }) });
        result = { success: true, removed_tag: tag, contact: contact_name };
        break;
      }
      case 'get_contacts': {
        const { limit = 100, query = '' } = req.body;
        result = await ghlApi(`/contacts/?locationId=${locId}&limit=${limit}${query ? '&query=' + encodeURIComponent(query) : ''}`);
        break;
      }
      case 'get_appointments': {
        const today = new Date().toISOString().split('T')[0];
        const end = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
        result = await ghlApi(`/calendars/events?locationId=${locId}&startTime=${today}&endTime=${end}&limit=50`);
        break;
      }
      case 'get_workflows': {
        result = await ghlApi(`/workflows/?locationId=${locId}`);
        break;
      }
      default:
        return res.status(400).json({ success: false, error: `Unknown action type: ${type}` });
    }

    res.json({ success: true, type, result });

  } catch (err) {
    console.error('GHL action error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/ghl/status', (req, res) => {
  res.json({
    connected: !!global.GHL_ACCESS_TOKEN,
    locationId: global.GHL_LOCATION_ID || null,
    tokenExpiry: global.GHL_TOKEN_EXPIRY ? new Date(global.GHL_TOKEN_EXPIRY).toISOString() : null,
    authUrl: 'https://synvia-backend.onrender.com/ghl/auth',
  });
});

app.listen(PORT, () => {
  console.log(`SYNVIA Backend running on port ${PORT}`);
});
