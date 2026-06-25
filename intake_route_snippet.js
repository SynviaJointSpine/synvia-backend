// ═══════════════════════════════════════════════════════════════
// INTAKE PDF — Netlify form webhook → SJS PDF → email
// Add this block to server.js AFTER your existing /intake-submit route.
//
// Required env vars (already on Render):
//   SENDGRID_API_KEY   — already set
//   FROM_EMAIL         — already set (e.g. noreply@synviajointandspine.com)
//   ALERT_EMAIL        — set this to: info@synviajointandspine.com
//
// New npm packages needed (add to package.json):
//   "pdfkit": "^0.15.0"
//   "@sendgrid/mail": "^8.1.0"
//
// Also place generateIntakePDF.js and synvia_logo.png
// in the root of your repo alongside server.js.
// ═══════════════════════════════════════════════════════════════

const sgMail   = require('@sendgrid/mail');
const path     = require('path');
const fs       = require('fs');
const { generateIntakePDF } = require('./generateIntakePDF');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Load logo once at startup (same directory as server.js)
const LOGO_BUFFER = fs.readFileSync(path.join(__dirname, 'synvia_logo.png'));

app.post('/intake-pdf', async (req, res) => {
  try {
    // Netlify sends form data as application/x-www-form-urlencoded
    // express.urlencoded() already parses this into req.body
    const data = req.body;

    console.log(`[intake-pdf] New submission: ${data.firstName} ${data.lastName}`);

    // Generate the PDF
    const pdfBuffer = await generateIntakePDF(data, LOGO_BUFFER);

    // Build patient name for subject line
    const patientName = `${(data.firstName || '').trim()} ${(data.lastName || '').trim()}`.trim() || 'New Patient';
    const submittedAt = data.submittedAt
      ? new Date(data.submittedAt).toLocaleString('en-US', { timeZone: 'America/Chicago' })
      : new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });

    await sgMail.send({
      to:      process.env.ALERT_EMAIL || 'info@synviajointandspine.com',
      from:    process.env.FROM_EMAIL,
      subject: `New Patient Intake — ${patientName}`,
      text: [
        `New patient intake form submitted.`,
        ``,
        `Patient:   ${patientName}`,
        `DOB:       ${data.dob || '—'}`,
        `Phone:     ${data.cell || '—'}`,
        `Email:     ${data.email || '—'}`,
        `Chief:     ${data.chief || '—'}`,
        `Pain:      ${data.pain || '—'} / 10`,
        `Submitted: ${submittedAt} CT`,
        ``,
        `Full intake record is attached as a PDF.`,
      ].join('\n'),
      html: `
        <div style="font-family:Helvetica,sans-serif;max-width:540px;color:#1A202C">
          <div style="border-bottom:2px solid #0F2550;padding-bottom:12px;margin-bottom:20px">
            <span style="font-size:18px;font-weight:bold;color:#0F2550">SYNVIA Joint &amp; Spine</span><br>
            <span style="font-size:12px;color:#4A5568">New Patient Intake Received</span>
          </div>
          <table style="width:100%;font-size:13px;border-collapse:collapse">
            <tr><td style="color:#4A5568;padding:4px 0;width:110px">PATIENT</td><td style="font-weight:bold">${patientName}</td></tr>
            <tr><td style="color:#4A5568;padding:4px 0">DOB</td><td>${data.dob || '—'}</td></tr>
            <tr><td style="color:#4A5568;padding:4px 0">PHONE</td><td>${data.cell || '—'}</td></tr>
            <tr><td style="color:#4A5568;padding:4px 0">EMAIL</td><td>${data.email || '—'}</td></tr>
            <tr><td style="color:#4A5568;padding:4px 0">CHIEF</td><td style="font-weight:bold">${data.chief || '—'}</td></tr>
            <tr><td style="color:#4A5568;padding:4px 0">PAIN SCORE</td><td style="font-weight:bold;color:#C0392B;font-size:16px">${data.pain || '—'} / 10</td></tr>
            <tr><td style="color:#4A5568;padding:4px 0">SUBMITTED</td><td>${submittedAt} CT</td></tr>
          </table>
          <p style="margin-top:20px;font-size:12px;color:#4A5568">Full intake record attached as PDF.</p>
        </div>
      `,
      attachments: [{
        content:     pdfBuffer.toString('base64'),
        filename:    `SYNVIA_Intake_${patientName.replace(/\s+/g, '_')}.pdf`,
        type:        'application/pdf',
        disposition: 'attachment',
      }],
    });

    console.log(`[intake-pdf] Email sent for ${patientName}`);

    // Also forward to Apps Script (existing intake pipeline) if configured
    const scriptUrl = process.env.APPS_SCRIPT_URL;
    if (scriptUrl) {
      fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'INTAKE_SUBMISSION',
          status: 'UNREAD',
          submittedAt: new Date().toISOString(),
          source: 'synviaintakeform.netlify.app',
          patient: data,
        }),
      }).catch(e => console.error('[intake-pdf] Apps Script forward error:', e.message));
    }

    res.json({ success: true, message: `Intake PDF emailed for ${patientName}` });

  } catch (err) {
    console.error('[intake-pdf] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
