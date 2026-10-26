const { createHash, createHmac, randomUUID } = require('node:crypto');

async function sendIntakeMail(message, sendgrid, receiptId, env = process.env, fetcher = fetch) {
  const url = env.GMAIL_INTAKE_WEBHOOK_URL;
  if (!url) return sendgrid.send(message);
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) ||
      !/^[a-f0-9]{64}$/.test(env.GMAIL_INTAKE_WEBHOOK_SECRET || '')) {
    throw new Error('Office PDF email connection is not configured');
  }
  if (message.to !== 'info@synviajointandspine.com' || message.attachments?.length !== 1) {
    throw new Error('Office PDF recipient or attachment is invalid');
  }
  const attachment = message.attachments[0];
  const id = /^[a-f0-9-]{36,64}$/.test(receiptId || '') ? receiptId : randomUUID();
  const payload = JSON.stringify({
    id,
    subject: 'NEW PATIENT INTAKE SUBMISSION',
    text: 'A completed SYNVIA intake has been received. The full paperwork is attached as a PDF.\n\n' +
      'Open and print the attached PDF for the patient chart. No SYNVIA OS access is required.',
    pdfBase64: attachment.content,
    filename: 'SYNVIA_Intake_' + id + '.pdf'
  });
  const issuedAt = Math.floor(Date.now()/1000);
  const digest = createHash('sha256').update(payload).digest('hex');
  const signature = createHmac('sha256',env.GMAIL_INTAKE_WEBHOOK_SECRET).update(issuedAt+'\n'+digest).digest('hex');
  const response = await fetcher(url, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({issuedAt,payload,signature}), signal:AbortSignal.timeout(30000), redirect:'follow'
  });
  let result;
  try { result = await response.json(); } catch (_) { throw new Error('Office PDF email returned an invalid response'); }
  if (!response.ok || result.success !== true || result.id !== id) {
    throw new Error('Office PDF email was not accepted: ' + (result.error || 'delivery unavailable'));
  }
  return {accepted:true,duplicate:result.duplicate===true,id};
}

module.exports = { sendIntakeMail };
