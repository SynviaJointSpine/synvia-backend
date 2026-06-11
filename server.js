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
        max_tokens: Math.min(Number(max_tokens) || 2000, 3000), // cost guard
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

app.listen(PORT, () => console.log(`SYNVIA backend running on port ${PORT}`));
