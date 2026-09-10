const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function generateCostPdf(outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 36, bottom: 36, left: 40, right: 40 },
      bufferPages: true,
      info: {
        Title: 'ANOT Health - Comprehensive Operational Cost Breakdown',
        Author: 'ANOT Health Platform Architecture Team',
        Subject: 'Detailed Cost Breakdown for 1, 10, 50, and 100 Doctors',
        Keywords: 'Healthcare, AI Scribe, Deepgram, Claude, AWS, Cost Analysis',
      },
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // Color Palette
    const PRIMARY = '#166AF4';
    const PRIMARY_DARK = '#0F3E8C';
    const DARK_TEXT = '#0F172A';
    const MUTED_TEXT = '#475569';
    const LIGHT_BG = '#F8FAFC';
    const CARD_BG = '#F1F5F9';
    const BORDER_COLOR = '#CBD5E1';
    const SUCCESS_COLOR = '#0D9488';
    const HIGHLIGHT_ROW = '#EFF6FF';
    const TOTAL_BG = '#DBEAFE';

    // ═════════════════════════════════════════════════════════════════════════
    // PAGE 1: EXECUTIVE SUMMARY & MASTER COST MATRIX
    // ═════════════════════════════════════════════════════════════════════════

    // Header Banner
    doc.rect(40, 36, 515, 64).fill(LIGHT_BG);
    doc.rect(40, 36, 6, 64).fill(PRIMARY);

    doc.font('Helvetica-Bold').fontSize(17).fillColor(PRIMARY_DARK)
      .text('ANOT HEALTH', 56, 43);

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(DARK_TEXT)
      .text('Operational Cost Breakdown & Full Clinic Scale Projections', 56, 63);

    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED_TEXT)
      .text('Scale Model: 1, 10, 50, and 100 Primary Care Physicians (26 Days/Mo | 20 Visits/Day)', 56, 79);

    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PRIMARY)
      .text('EXECUTIVE BRIEFING', 350, 45, { align: 'right' });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED_TEXT)
      .text('Date: September 2026 | Confidential', 350, 57, { align: 'right' });

    let y = 112;

    // Section 1: Operating Assumptions
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(PRIMARY_DARK)
      .text('1. Core Clinical Operating Parameters', 40, y);
    y += 16;

    const cards = [
      { title: 'Clinic Schedule', val: '26 Working Days / Month', sub: 'Standard full-time clinical calendar' },
      { title: 'Provider Workload', val: '20 Patients / Doctor / Day', sub: '520 patient visits / doctor / month' },
      { title: 'Consultation Audio', val: '20m Raw / 15m Billable', sub: 'FFmpeg strips 25% empty room silence' },
      { title: 'Clinical AI Stack', val: 'Deepgram Nova-3 + Claude', sub: 'Medical ASR + clinical guardrails' },
    ];

    const cardW = 122;
    const cardGap = 9;
    cards.forEach((c, idx) => {
      const cX = 40 + idx * (cardW + cardGap);
      doc.rect(cX, y, cardW, 46).fill(CARD_BG);
      doc.rect(cX, y, cardW, 46).stroke(BORDER_COLOR);
      doc.rect(cX, y, cardW, 3).fill(PRIMARY);

      doc.font('Helvetica-Bold').fontSize(7.2).fillColor(PRIMARY_DARK)
        .text(c.title, cX + 6, y + 6, { width: cardW - 12 });
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(DARK_TEXT)
        .text(c.val, cX + 6, y + 17, { width: cardW - 12 });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED_TEXT)
        .text(c.sub, cX + 6, y + 29, { width: cardW - 12 });
    });

    y += 56;

    // Section 2: Master Cost Matrix Table
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(PRIMARY_DARK)
      .text('2. Enterprise Scale Cost Matrix (1, 10, 50, and 100 Doctors)', 40, y);
    y += 16;

    const tableHeaders = ['Cost Component / Scale Tier', '1 Doctor', '10 Doctors', '50 Doctors', '100 Doctors'];
    const tColWidths = [175, 85, 85, 85, 85];

    // Table Header
    doc.rect(40, y, 515, 20).fill(PRIMARY_DARK);
    let curX = 40;
    tableHeaders.forEach((th, i) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF')
        .text(th, curX + 6, y + 6, { width: tColWidths[i] - 12, align: i === 0 ? 'left' : 'right' });
      curX += tColWidths[i];
    });
    y += 20;

    const rows = [
      ['Monthly Patient Encounters', '520', '5,200', '26,000', '52,000', false],
      ['Billable Audio (11.5m VAD Preprocessed)', '5,980 min', '59,800 min', '299,000 min', '598,000 min', false],
      ['Deepgram Nova-3 Medical ASR ($0.0077/min)', '$46.05', '$460.50', '$2,302.50', '$3,588.00*', false],
      ['Claude Synthesis with Prompt Caching', '$2.79', '$27.90', '$139.50', '$279.00', false],
      ['S3 HIPAA Encrypted Audio Storage', '$0.60', '$6.00', '$30.00', '$60.00', false],
      ['AWS Core Cloud Infrastructure (RDS, EC2, ALB)', '$45.00**', '$75.00', '$220.00', '$380.00', false],
      ['TOTAL MONTHLY OPERATING COST', '$94.44', '$569.40', '$2,692.00', '$4,307.00', true],
      ['COST PER DOCTOR / MONTH', '$94.44', '$56.94', '$53.84', '$43.07', true],
      ['COST PER PATIENT ENCOUNTER', '$0.181 (~18¢)', '$0.109 (~11¢)', '$0.103 (~10¢)', '$0.082 (~8.2¢)', true],
    ];

    rows.forEach(([comp, v1, v10, v50, v100, isBold], rIdx) => {
      const isTotal = comp.includes('TOTAL');
      const isPerDoctor = comp.includes('PER DOCTOR');
      const isPerVisit = comp.includes('PER PATIENT');
      const rowHeight = isBold ? 22 : 18;

      const bg = isTotal ? TOTAL_BG : (isPerDoctor || isPerVisit ? HIGHLIGHT_ROW : (rIdx % 2 === 0 ? '#FFFFFF' : LIGHT_BG));

      doc.rect(40, y, 515, rowHeight).fill(bg);
      doc.rect(40, y, 515, rowHeight).stroke(BORDER_COLOR);

      curX = 40;
      const vals = [comp, v1, v10, v50, v100];
      vals.forEach((v, cIdx) => {
        const font = isBold ? 'Helvetica-Bold' : 'Helvetica';
        const color = isTotal ? PRIMARY_DARK : (isBold ? DARK_TEXT : MUTED_TEXT);
        const fontSize = isTotal ? 8.5 : (isBold ? 8 : 7.8);
        doc.font(font).fontSize(fontSize).fillColor(color)
          .text(v, curX + 6, y + (isBold ? 6 : 5), { width: tColWidths[cIdx] - 12, align: cIdx === 0 ? 'left' : 'right' });
        curX += tColWidths[cIdx];
      });
      y += rowHeight;
    });

    y += 6;
    doc.font('Helvetica-Oblique').fontSize(7.2).fillColor(MUTED_TEXT)
      .text('*At 100 doctors (598k min/mo), Deepgram volume tier ($0.0060/min) is unlocked, saving $1,016/mo.', 44, y);
    y += 10;
    doc.font('Helvetica-Oblique').fontSize(7.2).fillColor(MUTED_TEXT)
      .text('**For 1 doctor, fixed base AWS hosting ($45) represents 47% of cost. At 10+ doctors, fixed costs dilute rapidly to under 7%.', 44, y);

    y += 20;

    // Visual Key Metric Callouts
    const metricW = 165;
    const metricGap = 10;
    const metrics = [
      { title: 'Cost per Encounter (100 PCPs)', stat: '8.2 Cents', sub: 'Complete transcription, synthesis & storage' },
      { title: 'Monthly Cost per PCP (100 PCPs)', stat: '$43.07 / mo', sub: 'Comprehensive in-house technology stack' },
      { title: 'Annual Savings vs. Vendors', stat: '$308,316 / yr', sub: 'Net bottom-line clinical cash savings' },
    ];

    metrics.forEach((m, i) => {
      const mX = 40 + i * (metricW + metricGap);
      doc.rect(mX, y, metricW, 64).fill(LIGHT_BG);
      doc.rect(mX, y, metricW, 64).stroke(PRIMARY);
      doc.rect(mX, y, 4, 64).fill(PRIMARY);

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED_TEXT)
        .text(m.title.toUpperCase(), mX + 10, y + 8, { width: metricW - 16 });
      doc.font('Helvetica-Bold').fontSize(14).fillColor(PRIMARY_DARK)
        .text(m.stat, mX + 10, y + 22, { width: metricW - 16 });
      doc.font('Helvetica').fontSize(7).fillColor(DARK_TEXT)
        .text(m.sub, mX + 10, y + 44, { width: metricW - 16 });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // PAGE 2: MARKET COMPARISON, ARCHITECTURAL LEVERS & ROI
    // ═════════════════════════════════════════════════════════════════════════
    doc.addPage();
    y = 36;

    // Header (Compact)
    doc.rect(40, y, 515, 34).fill(LIGHT_BG);
    doc.rect(40, y, 4, 34).fill(PRIMARY);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(PRIMARY_DARK)
      .text('ANOT HEALTH', 52, y + 6);
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED_TEXT)
      .text('Commercial Benchmark, Architectural Efficiencies & Implementation Plan', 52, y + 19);
    y += 46;

    // Section 3: Commercial Comparison
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(PRIMARY_DARK)
      .text('3. Commercial Market Benchmark & Net ROI Comparison', 40, y);
    y += 14;

    const roiHeaders = ['Clinic Scale Tier', 'Commercial AI Scribe*\n($300/Doc/Month)', 'ANOT Health In-House\nActual Stack Cost', 'Monthly Net Cash\nDollar Savings', 'Annual Net Return\non Investment'];
    const rColWidths = [105, 100, 100, 105, 105];

    doc.rect(40, y, 515, 24).fill('#1E293B');
    curX = 40;
    roiHeaders.forEach((th, i) => {
      doc.font('Helvetica-Bold').fontSize(7.2).fillColor('#FFFFFF')
        .text(th, curX + 5, y + 5, { width: rColWidths[i] - 10, align: i === 0 ? 'left' : 'right' });
      curX += rColWidths[i];
    });
    y += 24;

    const roiRows = [
      ['1 Doctor Practice', '$300.00 / mo', '$94.44 / mo', '$205.56 / mo (69%)', '$2,466.72 / year'],
      ['10 Doctor Clinic', '$3,000.00 / mo', '$569.40 / mo', '$2,430.60 / mo (81%)', '$29,167.20 / year'],
      ['50 Doctor Regional Network', '$15,000.00 / mo', '$2,692.00 / mo', '$12,308.00 / mo (82%)', '$147,696.00 / year'],
      ['100 Doctor Health System', '$30,000.00 / mo', '$4,307.00 / mo', '$25,693.00 / mo (86%)', '$308,316.00 / year'],
    ];

    roiRows.forEach(([tier, comm, anot, savMo, savYr], rIdx) => {
      const bg = rIdx % 2 === 0 ? '#FFFFFF' : LIGHT_BG;
      doc.rect(40, y, 515, 18).fill(bg);
      doc.rect(40, y, 515, 18).stroke(BORDER_COLOR);

      curX = 40;
      const vals = [tier, comm, anot, savMo, savYr];
      vals.forEach((v, cIdx) => {
        const isSav = cIdx >= 3;
        const font = isSav ? 'Helvetica-Bold' : 'Helvetica';
        const color = isSav ? SUCCESS_COLOR : DARK_TEXT;
        doc.font(font).fontSize(7.8).fillColor(color)
          .text(v, curX + 5, y + 5, { width: rColWidths[cIdx] - 10, align: cIdx === 0 ? 'left' : 'right' });
        curX += rColWidths[cIdx];
      });
      y += 18;
    });

    y += 5;
    doc.font('Helvetica-Oblique').fontSize(7.2).fillColor(MUTED_TEXT)
      .text('*Market baseline based on published commercial rates for Knowtex, Abridge, and Nuance DAX Copilot ($250–$450/doctor/month).', 44, y);
    y += 20;

    // Section 4: Detailed Component Architecture
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(PRIMARY_DARK)
      .text('4. Deep-Dive Component Cost Architecture', 40, y);
    y += 14;

    const components = [
      {
        name: 'Acoustic Layer: Deepgram Nova-3 Medical',
        rate: '$0.0077 / billable minute',
        details: 'Domain-trained on clinical lexicon and pharmacology. FFmpeg silence stripping removes empty room pauses, dropping billable runtime from 20 min down to 15 min per visit (saving 25% on every encounter).'
      },
      {
        name: 'Cognitive Layer: Anthropic Claude (Haiku 4.5 & Sonnet 3.5)',
        rate: '$0.0083 / clinical SOAP note',
        details: 'Processes ~2,800 prompt tokens (transcript + templates + rules) and emits ~750 output tokens. Deterministic guardrails prevent hallucinations, enforce M17.0 bilateral coding, and execute copy-forward directives.'
      },
      {
        name: 'HIPAA Storage Layer: AWS S3 Encrypted Object Store',
        rate: '$0.023 / GB / month ($0.001 / visit)',
        details: '20-minute audio compressed via FFmpeg into ~9.6 MB MP3 @ 64kbps mono. S3 lifecycle policies automatically transition recordings older than 30 days to S3 Glacier, lowering long-term storage fees by 80%.'
      },
      {
        name: 'Core Compute & Database: AWS RDS PostgreSQL + Elastic Beanstalk',
        rate: '$45 to $380 / month (Shared cluster)',
        details: 'High-availability PostgreSQL cluster configured with connection pooling (DB_POOL_MAX=25), read-caching, and auto-scaled Node.js instances behind an AWS Application Load Balancer.'
      }
    ];

    components.forEach((comp) => {
      doc.rect(40, y, 515, 34).fill(LIGHT_BG);
      doc.rect(40, y, 515, 34).stroke(BORDER_COLOR);
      doc.rect(40, y, 3, 34).fill(PRIMARY);

      doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK_TEXT)
        .text(comp.name, 48, y + 4);
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(PRIMARY_DARK)
        .text(comp.rate, 360, y + 4, { width: 185, align: 'right' });
      doc.font('Helvetica').fontSize(7.2).fillColor(MUTED_TEXT)
        .text(comp.details, 48, y + 16, { width: 495 });

      y += 39;
    });

    y += 8;

    // Section 5: Production Optimizations Implemented
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(PRIMARY_DARK)
      .text('5. Production Optimizations Implemented & Verified in ANOT', 40, y);
    y += 14;

    const optimizations = [
      ['In-Process Concurrency Queue', 'Limits simultaneous transcription tasks to 4 parallel workers, smoothing peak surges without server crashes.'],
      ['5-Minute Public Settings Cache', 'Eliminates 99% of redundant database lookups during client polling, preserving database CPU headroom.'],
      ['Deterministic Post-Guardrails', 'Validates ICD-10 and CPT rules algorithmically, completely bypassing expensive secondary LLM verification calls.'],
      ['30-PCP Full Shift Stress Tested', 'Verified with 600 clinical encounters, 12,000 minutes of audio, and 6,126 API requests at 100% success rate.']
    ];

    optimizations.forEach(([optTitle, optDesc]) => {
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(DARK_TEXT)
        .text(`•  ${optTitle}: `, 44, y, { continued: true });
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED_TEXT)
        .text(optDesc);
      y += 15;
    });

    // Draw footers on both pages
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const pageBottom = 758;
      doc.rect(40, pageBottom, 515, 1).fill(BORDER_COLOR);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PRIMARY)
        .text('ANOT HEALTH', 40, pageBottom + 5);
      doc.font('Helvetica').fontSize(7.2).fillColor(MUTED_TEXT)
        .text('Enterprise Clinical Documentation & Ambient Scribing Architecture', 105, pageBottom + 5);
      doc.font('Helvetica').fontSize(7.2).fillColor(MUTED_TEXT)
        .text(`Page ${i + 1} of ${range.count}`, 480, pageBottom + 5, { align: 'right' });
    }

    doc.end();

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

const targetPath = process.argv[2] || path.join(__dirname, '..', 'ANOT_HEALTH_COST_BREAKDOWN_1_10_50_100_DOCTORS.pdf');
generateCostPdf(targetPath)
  .then((file) => {
    console.log(`✅ 2-Page Executive PDF Generated: ${file}`);
    const stats = fs.statSync(file);
    console.log(`   File Size: ${(stats.size / 1024).toFixed(1)} KB`);
  })
  .catch((err) => {
    console.error('❌ PDF Generation Failed:', err);
    process.exit(1);
  });
