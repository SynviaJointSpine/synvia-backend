'use strict';

const PDFDocument = require('pdfkit');

// ── SJS color palette ──────────────────────────────────────────
const NAVY  = '#0F2550';
const MID   = '#4A5568';
const RULE  = '#CBD5E0';
const RED   = '#C0392B';
const BLACK = '#1A202C';

// ── Layout constants (points) ──────────────────────────────────
const LM   = 0.65 * 72;   // left margin
const RM   = 7.95 * 72;   // right margin
const TM   = (11 - 0.55) * 72;  // top margin (from bottom of page)
const BM   = 0.55 * 72;
const PW   = 8.5 * 72;
const PH   = 11  * 72;
const CW   = RM - LM;

/**
 * Generate SJS intake PDF buffer from Netlify form data.
 * @param {Object} data  — parsed Netlify form fields
 * @param {Buffer} logoBuffer — the SYNVIA logo PNG as a buffer
 * @returns {Promise<Buffer>}
 */
function generateIntakePDF(data, logoBuffer) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: {
      Title: `SYNVIA Intake — ${data.firstName || ''} ${data.lastName || ''}`,
      Author: 'SYNVIA Joint & Spine',
    }});

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── helpers ─────────────────────────────────────────────────
    const y = () => PH - doc.y;   // PDFKit y=0 is top; convert for mental model

    function hline(yPos, opts = {}) {
      const { x1 = LM, x2 = RM, w = 0.4, color = RULE } = opts;
      doc.save().strokeColor(color).lineWidth(w).moveTo(x1, yPos).lineTo(x2, yPos).stroke().restore();
    }

    function cap(xPos, yPos, text) {
      doc.save().font('Helvetica').fontSize(6.5).fillColor(MID)
         .text(text.toUpperCase(), xPos, yPos, { lineBreak: false }).restore();
    }

    function val(xPos, yPos, text, size = 9.5) {
      doc.save().font('Helvetica-Bold').fontSize(size).fillColor(BLACK)
         .text(String(text || '—'), xPos, yPos, { lineBreak: false }).restore();
    }

    function sectionHeader(yPos, title) {
      hline(yPos, { w: 0.5, color: NAVY });
      doc.save().font('Helvetica-Bold').fontSize(7).fillColor(NAVY)
         .text(title.toUpperCase(), LM, yPos + 3, { lineBreak: false }).restore();
      return yPos + 18;
    }

    function sep(yPos) {
      hline(yPos, { w: 0.3, color: RULE });
      return yPos + 12;
    }

    // shorthand for "or dash if empty"
    const d = v => (v && String(v).trim()) ? String(v).trim() : '—';

    // ── derived fields ───────────────────────────────────────────
    const patientName = `${d(data.firstName)} ${d(data.lastName)}`.trim();
    const dob = d(data.dob);
    const address = [data.street, data.city, data.state, data.zip].filter(Boolean).join(', ');
    const submittedAt = data.submittedAt
      ? new Date(data.submittedAt).toLocaleDateString('en-US')
      : new Date().toLocaleDateString('en-US');

    // tried / activities / commPref may come as arrays or newline strings
    const listField = v => {
      if (!v) return '—';
      const arr = Array.isArray(v) ? v : String(v).split(/[\n\r]+/);
      const cleaned = arr.map(s => s.replace(/^[\s\-·]+/, '').trim()).filter(Boolean);
      return cleaned.length ? cleaned.join('  ·  ') : '—';
    };

    // ── START DRAWING ────────────────────────────────────────────
    let curY = 0.55 * 72;  // top of page (PDFKit coords, 0=top)

    // ── LOGO ────────────────────────────────────────────────────
    const logoH = 0.55 * 72;
    const logoW = logoH * (1542 / 424);  // cropped aspect ratio
    doc.image(logoBuffer, LM, curY, { width: logoW, height: logoH });

    // right-side form label
    doc.save().font('Helvetica').fontSize(8).fillColor(MID)
       .text('Patient Intake & Health History', 0, curY, { align: 'right', width: RM, lineBreak: false })
       .text(submittedAt, 0, curY + 13, { align: 'right', width: RM, lineBreak: false })
       .restore();

    // navy divider under header
    curY += logoH + 8;
    hline(curY, { w: 1.2, color: NAVY });
    curY += 16;

    // ── PATIENT BLOCK ────────────────────────────────────────────
    doc.save().font('Helvetica-Bold').fontSize(14).fillColor(NAVY)
       .text(patientName, LM, curY, { lineBreak: false }).restore();

    const dobLine = `DOB ${dob}  ·  ${d(data.gender)}  ·  ${d(data.marital)}`;
    doc.save().font('Helvetica').fontSize(8.5).fillColor(MID)
       .text(dobLine, 0, curY, { align: 'right', width: RM, lineBreak: false }).restore();
    curY += 16;

    doc.save().font('Helvetica').fontSize(8.5).fillColor(MID)
       .text(`${d(data.cell)}  ·  ${d(data.email)}  ·  ${d(address)}`, LM, curY, { lineBreak: false }).restore();
    curY += 13;

    doc.save().font('Helvetica').fontSize(8.5).fillColor(MID)
       .text(`Emergency: ${d(data.emName)}  ${d(data.emPhone)}  ·  Employer: ${d(data.employer)}  ·  Referral: ${d(data.referral)}`, LM, curY, { lineBreak: false }).restore();
    curY += 10;

    hline(curY, { w: 0.4, color: RULE });
    curY += 14;

    // ── INSURANCE ───────────────────────────────────────────────
    curY = sectionHeader(curY, 'Insurance');
    const insFields = [
      [LM,              'Coverage',   d(data.coverage)],
      [LM + 79,         'Carrier',    d(data.insCompany)],
      [LM + 187,        'State',      d(data.insState)],
      [LM + 226,        'Member ID',  d(data.insMember)],
      [LM + 338,        'Group',      d(data.insGroup)],
      [LM + 382,        'Employer',   d(data.insEmployer)],
    ];
    insFields.forEach(([x, lb, v]) => { cap(x, curY, lb); val(x, curY + 10, v, 9); });
    curY += 30;
    curY = sep(curY);

    // ── CHIEF COMPLAINT ─────────────────────────────────────────
    curY = sectionHeader(curY, 'Chief Complaint');
    cap(LM,           curY, 'Complaint'); val(LM,           curY + 10, d(data.chief), 9);
    cap(LM + 144,     curY, 'Duration');  val(LM + 144,     curY + 10, d(data.duration), 9);
    cap(LM + 245,     curY, 'Symptoms');  val(LM + 245,     curY + 10, d(data.symptoms), 9);
    // pain score
    cap(LM + 418, curY, 'Pain Score (0–10)');
    doc.save().font('Helvetica-Bold').fontSize(22).fillColor(RED)
       .text(d(data.pain) + ' / 10', LM + 418, curY + 6, { lineBreak: false }).restore();
    curY += 38;
    curY = sep(curY);

    // ── MEDICAL HISTORY ─────────────────────────────────────────
    curY = sectionHeader(curY, 'Medical History');
    cap(LM,           curY, 'Conditions');  val(LM,           curY + 10, d(data.conditions), 9);
    cap(LM + 130,     curY, 'Medications'); val(LM + 130,     curY + 10, d(data.medications), 9);
    cap(LM + 260,     curY, 'Allergies');   val(LM + 260,     curY + 10, d(data.allergies), 9);
    cap(LM + 390,     curY, 'Surgeries');   val(LM + 390,     curY + 10, d(data.surgeries), 9);
    curY += 28;
    cap(LM, curY, 'Family History'); val(LM, curY + 10, d(data.familyHistory), 9);
    curY += 28;
    curY = sep(curY);

    // ── LIFESTYLE ───────────────────────────────────────────────
    curY = sectionHeader(curY, 'Lifestyle & Habits');
    const lifeCols = [
      [LM,       'Activity', d(data.activity)],
      [LM + 101, 'Sleep',    d(data.sleep)],
      [LM + 180, 'Stress',   d(data.stress)],
      [LM + 259, 'Tobacco',  d(data.tobacco)],
      [LM + 324, 'Alcohol',  d(data.alcohol)],
      [LM + 389, 'Exercise', d(data.exercise)],
    ];
    lifeCols.forEach(([x, lb, v]) => { cap(x, curY, lb); val(x, curY + 10, v, 9); });
    curY += 30;
    curY = sep(curY);

    // ── PRIOR TREATMENT ─────────────────────────────────────────
    curY = sectionHeader(curY, 'Prior Treatment');
    cap(LM, curY, 'Previously tried');
    val(LM, curY + 10, listField(data.tried), 9);
    curY += 28;
    cap(LM,       curY, 'Bone-on-bone');     val(LM,       curY + 10, d(data.boneOnBone), 9);
    cap(LM + 115, curY, "Surgery rec'd");    val(LM + 115, curY + 10, d(data.surgeryRec), 9);
    cap(LM + 216, curY, 'Seeking help for'); val(LM + 216, curY + 10, d(data.seekingHelp), 9);
    curY += 30;
    curY = sep(curY);

    // ── GOALS ───────────────────────────────────────────────────
    curY = sectionHeader(curY, 'Activities & Goals');
    cap(LM, curY, 'Affected activities');
    val(LM, curY + 10, listField(data.activities), 9);
    curY += 28;
    cap(LM, curY, 'Patient goals');
    doc.save().font('Helvetica-Oblique').fontSize(9.5).fillColor(BLACK)
       .text(`"${d(data.goals)}"`, LM, curY + 10, { lineBreak: false }).restore();
    curY += 28;
    curY = sep(curY);

    // ── AUTHORIZED CONTACTS ─────────────────────────────────────
    curY = sectionHeader(curY, 'Authorized Contacts & Communication');
    cap(LM,       curY, 'Contact');      val(LM,       curY + 10, d(data.ac1Name), 9);
    cap(LM + 144, curY, 'Relationship'); val(LM + 144, curY + 10, d(data.ac1Rel), 9);
    cap(LM + 230, curY, 'Phone');        val(LM + 230, curY + 10, d(data.ac1Phone), 9);
    cap(LM + 332, curY, 'May Discuss');  val(LM + 332, curY + 10, d(data.discuss), 9);
    curY += 28;
    cap(LM, curY, 'Preferred contact methods');
    val(LM, curY + 10, listField(data.commPref), 9);
    curY += 28;
    curY = sep(curY);

    // ── CONSENT & SIGNATURES ────────────────────────────────────
    curY = sectionHeader(curY, 'Consent & Authorization');
    const policies = [
      ['HIPAA / Privacy',      data.init1],
      ['Consent to Treatment', data.init2],
      ['Financial Policy',     data.init3],
      ['Release of Records',   data.init4],
      ['Notice of Privacy',    data.init5],
    ];
    const colW = CW / 5;
    policies.forEach(([policy, initial], i) => {
      const x = LM + i * colW;
      cap(x, curY, policy);
      doc.save().font('Times-BoldItalic').fontSize(16).fillColor(NAVY)
         .text(d(initial), x, curY + 11, { lineBreak: false }).restore();
      doc.save().strokeColor(NAVY).lineWidth(0.6)
         .moveTo(x, curY + 29).lineTo(x + 25, curY + 29).stroke().restore();
    });
    curY += 46;

    hline(curY, { w: 0.5, color: NAVY });
    curY += 16;

    // Signature row
    cap(LM, curY, 'Patient Signature');
    doc.save().font('Times-BoldItalic').fontSize(26).fillColor(NAVY)
       .text(d(data.signature), LM, curY + 10, { lineBreak: false }).restore();
    doc.save().strokeColor(NAVY).lineWidth(0.6)
       .moveTo(LM, curY + 38).lineTo(LM + 202, curY + 38).stroke().restore();

    cap(LM + 230, curY, 'Printed Name');
    val(LM + 230, curY + 14, d(data.printedName), 10);

    cap(LM + 389, curY, 'Date Signed');
    val(LM + 389, curY + 14, d(data.sigDate), 10);

    curY += 55;

    // ── FOOTER ──────────────────────────────────────────────────
    const footerY = PH - BM - 14;
    hline(footerY, { w: 0.5, color: NAVY });
    doc.save().font('Helvetica').fontSize(7).fillColor(MID)
       .text('SYNVIA Joint & Spine  ·  Confidential Patient Record  ·  Submitted electronically via synviaintakeform.netlify.app',
             LM, footerY + 4, { lineBreak: false })
       .text('Page 1 of 1', 0, footerY + 4, { align: 'right', width: RM, lineBreak: false })
       .restore();

    doc.end();
  });
}

module.exports = { generateIntakePDF };
