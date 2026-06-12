/* ═══════════════════════════════════════════════════════════
   SYNVIA BACKEND — /update-lead endpoint
   Writes VIP flags, Qualifier Score, Consult Score, and
   Consult Note back to the "P1M Leads" tab of the GHL sheet.

   PASTE INTO: synvia-backend (GitHub: SynviaJointSpine/synvia-backend)
   Add to your existing Express server file (same one with /send-sms
   and /claude). Requires: npm install googleapis

   ENV VARS to add on Render (Dashboard → synvia-backend → Environment):
     GOOGLE_SA_EMAIL  = service account email (ends in .iam.gserviceaccount.com)
     GOOGLE_SA_KEY    = service account private key (paste full key incl.
                        -----BEGIN PRIVATE KEY----- block; Render handles
                        multiline values — or replace newlines with \n)

   SETUP (one time, ~5 min):
   1. console.cloud.google.com → create/select a project
   2. APIs & Services → Enable "Google Sheets API"
   3. IAM & Admin → Service Accounts → Create ("synvia-sheets-writer")
   4. On the new account: Keys → Add Key → JSON → download
   5. From the JSON: client_email → GOOGLE_SA_EMAIL, private_key → GOOGLE_SA_KEY
   6. Open the GHL sheet → Share → add the service account email as EDITOR
   7. git push → Render auto-deploys
═══════════════════════════════════════════════════════════ */

const { google } = require('googleapis');

const LEADS_SHEET_ID = '1SI0gUor4T-JuQgOVoP6FxhwWYW7iaBBWbflT-jW_hnI';
const LEADS_TAB_NAME = 'P1M Leads';

// Columns the OS is allowed to write. Anything else is rejected.
const WRITABLE_COLUMNS = ['VIP', 'Qualifier Score', 'Consult Score', 'Consult Note', 'Value'];

function sheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SA_EMAIL,
    key: (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const digits = (s) => String(s || '').replace(/\D/g, '');
const colLetter = (i) => { // 0-based index → A1 column letters
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
};

/* POST /update-lead
   Body: { phone, lastName, firstName, fields: { "VIP": "TRUE", "Consult Score": "82", ... } }
   Matches the row by phone digits (fallback: last+first name).
   Auto-creates any missing header columns at the end of row 1. */
app.post('/update-lead', async (req, res) => {
  try {
    const { phone, lastName, firstName, fields } = req.body || {};
    if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) {
      return res.status(400).json({ success: false, error: 'No fields provided' });
    }
    const badKeys = Object.keys(fields).filter((k) => !WRITABLE_COLUMNS.includes(k));
    if (badKeys.length) {
      return res.status(400).json({ success: false, error: 'Field not writable: ' + badKeys.join(', ') });
    }
    if (!digits(phone) && !(lastName && firstName)) {
      return res.status(400).json({ success: false, error: 'Need a phone or first+last name to match the row' });
    }

    const sheets = sheetsClient();

    // Pull the whole tab once
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: LEADS_SHEET_ID,
      range: `'${LEADS_TAB_NAME}'`,
    });
    const rows = resp.data.values || [];
    if (!rows.length) return res.status(500).json({ success: false, error: 'Sheet tab is empty' });

    const headers = rows[0].map((h) => String(h || '').trim());

    // Ensure every requested field has a header column; create missing ones
    const headerWrites = [];
    for (const key of Object.keys(fields)) {
      if (!headers.includes(key)) {
        headers.push(key);
        headerWrites.push({
          range: `'${LEADS_TAB_NAME}'!${colLetter(headers.length - 1)}1`,
          values: [[key]],
        });
      }
    }
    if (headerWrites.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: LEADS_SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: headerWrites },
      });
    }

    // Find the row: phone digits first, then name fallback
    const phoneCol = headers.indexOf('Phone');
    const lnCol = headers.indexOf('Last Name');
    const fnCol = headers.indexOf('First Name');
    const want = digits(phone);
    let rowIdx = -1; // 0-based within rows[]
    for (let i = 1; i < rows.length; i++) {
      if (want && phoneCol >= 0 && digits(rows[i][phoneCol]) === want) { rowIdx = i; break; }
    }
    if (rowIdx === -1 && lastName && firstName && lnCol >= 0 && fnCol >= 0) {
      const ln = String(lastName).trim().toLowerCase();
      const fn = String(firstName).trim().toLowerCase();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][lnCol] || '').trim().toLowerCase() === ln &&
            String(rows[i][fnCol] || '').trim().toLowerCase() === fn) { rowIdx = i; break; }
      }
    }
    if (rowIdx === -1) {
      return res.status(404).json({ success: false, error: 'Lead not found in sheet (no phone/name match)' });
    }

    // Write each field to its column on the matched row
    const sheetRow = rowIdx + 1; // 1-based A1 row
    const data = Object.entries(fields).map(([key, value]) => ({
      range: `'${LEADS_TAB_NAME}'!${colLetter(headers.indexOf(key))}${sheetRow}`,
      values: [[String(value)]],
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: LEADS_SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    });

    return res.json({ success: true, updated: Object.keys(fields), row: sheetRow });
  } catch (err) {
    console.error('update-lead error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
