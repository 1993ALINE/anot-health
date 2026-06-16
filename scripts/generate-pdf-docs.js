#!/usr/bin/env node
/**
 * generate-pdf-docs.js
 *
 * Bundles the Anot Health documentation set into a single, professionally
 * formatted PDF that the IT team can download and print.
 *
 * It reads the curated list of Markdown files (docs/ + repo root), renders each
 * one as its own section with page breaks in between, builds a Table of
 * Contents with page numbers, and stamps every page with a running header and a
 * footer (title, generated timestamp, page numbers).
 *
 * Rendering uses `markdown-it` (pure-JS Markdown parser) + `pdfkit` (pure-JS PDF
 * writer). This avoids the deprecated PhantomJS dependency that markdown-pdf /
 * html-pdf rely on, so it installs and runs cleanly on Node 22 / Windows.
 *
 * Usage:
 *   npm install markdown-it pdfkit   # one-time
 *   node scripts/generate-pdf-docs.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

let PDFDocument
let MarkdownIt
try {
  PDFDocument = require('pdfkit')
  MarkdownIt = require('markdown-it')
} catch (err) {
  console.error('\n[generate-pdf-docs] Missing dependencies.')
  console.error('Install them first:\n\n  npm install markdown-it pdfkit\n')
  console.error(`Original error: ${err.message}`)
  process.exit(1)
}

const ROOT = path.resolve(__dirname, '..')
const DOCS_DIR = path.join(ROOT, 'docs')
const OUTPUT = path.join(DOCS_DIR, 'ANOT_HEALTH_COMPLETE_DOCUMENTATION.pdf')

// Ordered list of documents to include. `docs/` first, then repo-root files.
const DOCUMENTS = [
  { title: 'Platform Documentation',        file: path.join(DOCS_DIR, 'PLATFORM_DOCUMENTATION.md') },
  { title: 'Admin Onboarding',              file: path.join(DOCS_DIR, 'ADMIN_ONBOARDING.md') },
  { title: 'Clinician Onboarding',          file: path.join(DOCS_DIR, 'CLINICIAN_ONBOARDING.md') },
  { title: 'Disaster Recovery',             file: path.join(DOCS_DIR, 'DISASTER_RECOVERY.md') },
  { title: 'Cost Monitoring',               file: path.join(DOCS_DIR, 'COST_MONITORING.md') },
  { title: 'Security & Compliance Manual',  file: path.join(ROOT, 'SECURITY_AND_COMPLIANCE_MANUAL.md') },
  { title: 'Breach Response Plan',          file: path.join(ROOT, 'BREACH_RESPONSE_PLAN.md') },
  { title: 'Risk Assessment',               file: path.join(ROOT, 'RISK_ASSESSMENT.md') },
  { title: 'Privacy Policy',                file: path.join(ROOT, 'PRIVACY_POLICY.md') },
  { title: 'Terms of Service',              file: path.join(ROOT, 'TERMS_OF_SERVICE.md') },
  { title: 'HIPAA Compliance Sign-Off',     file: path.join(ROOT, 'HIPAA_COMPLIANCE_SIGN_OFF.md') },
]

const BRAND_TITLE = 'Anot Health Platform Documentation'

// ─── PALETTE & TYPOGRAPHY ──────────────────────────────────────────────────
const COLOR = {
  brand:  '#0F766E', // teal
  accent: '#115E59',
  text:   '#1F2937',
  muted:  '#6B7280',
  link:   '#1D4ED8',
  code:   '#9D174D',
  rule:   '#E5E7EB',
  codeBg: '#F3F4F6',
  headBg: '#ECFDF5',
}

const SIZE = { h1: 20, h2: 15, h3: 12.5, h4: 11, body: 10.5, code: 9, small: 8.5 }
const LINE_GAP = 3
const MARGIN = { top: 72, bottom: 72, left: 58, right: 58 }

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })

// ─── TOKEN → TREE ──────────────────────────────────────────────────────────
// markdown-it emits a flat list of tokens with _open/_close pairs. Fold them
// into a nested tree so rendering can recurse (lists, blockquotes, tables).
function nest(tokens) {
  const root = { type: 'root', children: [] }
  const stack = [root]
  for (const tok of tokens) {
    const top = stack[stack.length - 1]
    if (tok.nesting === 1) {
      const node = { type: tok.type.replace(/_open$/, ''), token: tok, children: [] }
      top.children.push(node)
      stack.push(node)
    } else if (tok.nesting === -1) {
      if (stack.length > 1) stack.pop()
    } else {
      top.children.push({ type: tok.type, token: tok, children: tok.children || [] })
    }
  }
  return root.children
}

// Flatten an inline token list into styled runs: { text, bold, italic, code, link }.
function inlineRuns(tokens) {
  const runs = []
  let bold = 0
  let italic = 0
  let link = null
  for (const tk of tokens || []) {
    switch (tk.type) {
      case 'strong_open': bold++; break
      case 'strong_close': bold = Math.max(0, bold - 1); break
      case 'em_open': italic++; break
      case 'em_close': italic = Math.max(0, italic - 1); break
      case 'link_open': link = tk.attrGet('href'); break
      case 'link_close': link = null; break
      case 'code_inline':
        runs.push({ text: sanitizeText(tk.content), code: true, bold: bold > 0, italic: italic > 0, link })
        break
      case 'softbreak': runs.push({ text: ' ' }); break
      case 'hardbreak': runs.push({ text: '\n' }); break
      case 'image': runs.push({ text: sanitizeText(tk.content || '[image]'), italic: true }); break
      case 'text':
        if (tk.content) runs.push({ text: sanitizeText(tk.content), bold: bold > 0, italic: italic > 0, link })
        break
      default:
        if (tk.content) runs.push({ text: sanitizeText(tk.content), bold: bold > 0, italic: italic > 0, link })
    }
  }
  return runs
}

function getRuns(node) {
  const inline = (node.children || []).find((c) => c.type === 'inline')
  return inline ? inlineRuns(inline.children) : []
}

// pdfkit's built-in fonts only encode the WinAnsi character set, so arrows,
// check-marks, and emoji used in the source Markdown would render as garbage.
// Map the common ones to readable ASCII and strip the rest.
function sanitizeText(s) {
  return String(s)
    .replace(/[\u2192\u2794\u279C\u27A1\u21E8\u2799]/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/[\u2194\u21D4]/g, '<->')
    .replace(/[\u2705\u2714\u2713\u2611\u2611\uD83D\uDFE2]/g, '[x]')
    .replace(/[\u274C\u2718\u2717\u2612]/g, '[ ]')
    .replace(/\u26A0\uFE0F?/g, '(!)')
    .replace(/[\u2022\u2023\u25AA\u25CF\u25E6]/g, '\u2022')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\uFE0F/g, '')
}

function runsToPlain(runs) {
  return runs.map((r) => r.text).join('')
}

function pickFont(r) {
  if (r.code) return r.bold ? 'Courier-Bold' : 'Courier'
  if (r.bold && r.italic) return 'Helvetica-BoldOblique'
  if (r.bold) return 'Helvetica-Bold'
  if (r.italic) return 'Helvetica-Oblique'
  return 'Helvetica'
}

// ─── LAYOUT HELPERS ────────────────────────────────────────────────────────
function pageBottom(doc) {
  return doc.page.height - doc.page.margins.bottom
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right
}

// Add a page if `h` units won't fit in the remaining space on the current page.
function ensureSpace(doc, h) {
  if (doc.y + h > pageBottom(doc)) doc.addPage()
}

// Render styled runs starting at (x, y) wrapping within `width`. Uses pdfkit's
// `continued` chaining so mixed fonts/colors share one wrapped text flow.
function writeRuns(doc, runs, opts) {
  const { x, width, size, color, align } = opts
  if (!runs || runs.length === 0) {
    doc.font('Helvetica').fontSize(size).fillColor(color || COLOR.text)
    doc.text(' ', x, doc.y, { width })
    return
  }
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const last = i === runs.length - 1
    doc.font(pickFont(r)).fontSize(size)
    doc.fillColor(r.link ? COLOR.link : r.code ? COLOR.code : color || COLOR.text)
    const o = { continued: !last, width, align: align || 'left', lineGap: LINE_GAP }
    if (r.link) { o.link = r.link; o.underline = true }
    if (i === 0 && x != null) doc.text(r.text, x, doc.y, o)
    else doc.text(r.text, o)
  }
  // Reset any lingering underline/link state for subsequent draws.
  doc.underline = false
}

// Height a run-set will occupy at `width` (approximated with the body font).
function runsHeight(doc, runs, width, size) {
  const plain = runsToPlain(runs) || ' '
  doc.font('Helvetica').fontSize(size)
  return doc.heightOfString(plain, { width, lineGap: LINE_GAP })
}

// ─── BLOCK RENDERERS ───────────────────────────────────────────────────────
function renderHeading(doc, node, ctx) {
  const level = parseInt((node.token.tag || 'h3').replace('h', ''), 10) || 3
  const size = level === 1 ? SIZE.h1 : level === 2 ? SIZE.h2 : level === 3 ? SIZE.h3 : SIZE.h4
  let runs = getRuns(node).map((r) => ({ ...r, bold: !r.code }))
  if (runs.length === 0) runs = [{ text: ' ' }]

  const h = runsHeight(doc, runs, ctx.width, size)
  doc.moveDown(level <= 2 ? 0.6 : 0.4)
  ensureSpace(doc, h + 8)
  const color = level <= 2 ? COLOR.brand : COLOR.accent
  writeRuns(doc, runs, { x: ctx.x, width: ctx.width, size, color })

  if (level === 1) {
    const y = doc.y + 2
    doc.save().strokeColor(COLOR.brand).lineWidth(1.2)
      .moveTo(ctx.x, y).lineTo(ctx.x + ctx.width, y).stroke().restore()
    doc.y = y + 4
  }
  doc.moveDown(0.25)
}

function renderParagraph(doc, node, ctx) {
  const runs = getRuns(node)
  ensureSpace(doc, runsHeight(doc, runs, ctx.width, SIZE.body))
  doc.x = ctx.x
  writeRuns(doc, runs, { x: ctx.x, width: ctx.width, size: SIZE.body, color: COLOR.text })
  doc.moveDown(0.5)
}

function renderList(doc, node, ordered, ctx) {
  const startAttr = node.token && node.token.attrGet ? node.token.attrGet('start') : null
  let idx = ordered ? parseInt(startAttr || '1', 10) : 1
  const markerW = ordered ? 22 : 16
  const itemX = ctx.x + markerW
  const itemWidth = ctx.width - markerW

  for (const item of node.children) {
    if (item.type !== 'list_item') continue
    const marker = ordered ? `${idx}.` : '•'
    const firstRuns = (() => {
      const p = item.children.find((c) => c.type === 'paragraph')
      return p ? getRuns(p) : []
    })()
    ensureSpace(doc, Math.max(SIZE.body + LINE_GAP, runsHeight(doc, firstRuns, itemWidth, SIZE.body)))

    const yStart = doc.y
    doc.font('Helvetica').fontSize(SIZE.body).fillColor(COLOR.brand)
    doc.text(marker, ctx.x, yStart, { width: markerW - 4, lineBreak: false })
    doc.y = yStart
    renderNodes(doc, item.children, { x: itemX, width: itemWidth })
    idx++
  }
  doc.moveDown(0.2)
}

function renderBlockquote(doc, node, ctx) {
  const innerX = ctx.x + 14
  const innerWidth = ctx.width - 14
  const yStart = doc.y
  renderNodes(doc, node.children, { x: innerX, width: innerWidth })
  const yEnd = doc.y
  doc.save().fillColor(COLOR.brand)
    .rect(ctx.x, yStart, 3, Math.max(2, yEnd - yStart)).fill().restore()
  doc.moveDown(0.3)
}

function renderCodeBlock(doc, content, ctx) {
  const text = sanitizeText(String(content).replace(/\n$/, ''))
  const pad = 8
  const innerWidth = ctx.width - pad * 2
  doc.font('Courier').fontSize(SIZE.code)
  const textH = doc.heightOfString(text, { width: innerWidth, lineGap: 2 })
  const boxH = textH + pad * 2

  // Reserve a fresh page when the block fits on one but not in the space left.
  const fullPageHeight = pageBottom(doc) - doc.page.margins.top
  if (boxH <= fullPageHeight) ensureSpace(doc, boxH)
  const fits = doc.y + boxH <= pageBottom(doc)
  const top = doc.y
  if (fits) {
    doc.save().fillColor(COLOR.codeBg)
      .roundedRect(ctx.x, top, ctx.width, boxH, 4).fill().restore()
    doc.fillColor(COLOR.text).font('Courier').fontSize(SIZE.code)
    doc.text(text, ctx.x + pad, top + pad, { width: innerWidth, lineGap: 2 })
    doc.y = top + boxH
  } else {
    doc.fillColor(COLOR.text).font('Courier').fontSize(SIZE.code)
    doc.text(text, ctx.x + pad, doc.y, { width: innerWidth, lineGap: 2 })
  }
  doc.moveDown(0.5)
}

function renderHr(doc, ctx) {
  doc.moveDown(0.3)
  ensureSpace(doc, 12)
  const y = doc.y + 2
  doc.save().strokeColor(COLOR.rule).lineWidth(0.8)
    .moveTo(ctx.x, y).lineTo(ctx.x + ctx.width, y).stroke().restore()
  doc.y = y + 8
}

// ─── TABLES ────────────────────────────────────────────────────────────────
function collectTable(node) {
  const header = []
  const rows = []
  for (const section of node.children) {
    if (section.type === 'thead') {
      for (const tr of section.children) {
        if (tr.type !== 'tr') continue
        for (const cell of tr.children) {
          if (cell.type === 'th' || cell.type === 'td') header.push(getRuns(cell))
        }
      }
    } else if (section.type === 'tbody') {
      for (const tr of section.children) {
        if (tr.type !== 'tr') continue
        const row = []
        for (const cell of tr.children) {
          if (cell.type === 'th' || cell.type === 'td') row.push(getRuns(cell))
        }
        rows.push(row)
      }
    }
  }
  return { header, rows }
}

function renderTable(doc, node, ctx) {
  const { header, rows } = collectTable(node)
  const cols = header.length || (rows[0] ? rows[0].length : 0)
  if (!cols) return

  // Column widths proportional to longest plain-text cell (dampened), clamped.
  const maxLen = new Array(cols).fill(1)
  const consider = (cellRuns, c) => {
    const len = runsToPlain(cellRuns || []).length || 1
    if (len > maxLen[c]) maxLen[c] = len
  }
  header.forEach((c, i) => consider(c, i))
  rows.forEach((r) => r.forEach((c, i) => consider(c, i)))
  const weights = maxLen.map((l) => Math.sqrt(l))
  const wsum = weights.reduce((a, b) => a + b, 0)
  const minW = Math.max(40, ctx.width / (cols * 2.2))
  let widths = weights.map((w) => Math.max(minW, (w / wsum) * ctx.width))
  const scale = ctx.width / widths.reduce((a, b) => a + b, 0)
  widths = widths.map((w) => w * scale)

  const pad = 5

  const measureRow = (cells) => {
    let h = SIZE.body
    cells.forEach((cellRuns, c) => {
      const hh = runsHeight(doc, cellRuns || [], widths[c] - pad * 2, SIZE.body)
      if (hh > h) h = hh
    })
    return h + pad * 2
  }

  const drawRow = (cells, isHeader) => {
    const rowH = measureRow(cells)
    if (doc.y + rowH > pageBottom(doc)) doc.addPage()
    const top = doc.y
    let x = ctx.x
    for (let c = 0; c < cols; c++) {
      const w = widths[c]
      if (isHeader) {
        doc.save().fillColor(COLOR.headBg).rect(x, top, w, rowH).fill().restore()
      }
      doc.save().strokeColor(COLOR.rule).lineWidth(0.6).rect(x, top, w, rowH).stroke().restore()
      let cellRuns = cells[c] || []
      if (isHeader) cellRuns = cellRuns.map((r) => ({ ...r, bold: !r.code }))
      doc.y = top + pad
      writeRuns(doc, cellRuns, {
        x: x + pad,
        width: w - pad * 2,
        size: SIZE.body,
        color: isHeader ? COLOR.accent : COLOR.text,
      })
      x += w
    }
    doc.y = top + rowH
  }

  doc.moveDown(0.3)
  ensureSpace(doc, measureRow(header.length ? header : rows[0] || []) + 6)
  if (header.length) drawRow(header, true)
  for (const r of rows) drawRow(r, false)
  doc.moveDown(0.6)
}

// ─── RECURSIVE DISPATCH ────────────────────────────────────────────────────
function renderNodes(doc, nodes, ctx) {
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': renderHeading(doc, node, ctx); break
      case 'paragraph': renderParagraph(doc, node, ctx); break
      case 'bullet_list': renderList(doc, node, false, ctx); break
      case 'ordered_list': renderList(doc, node, true, ctx); break
      case 'blockquote': renderBlockquote(doc, node, ctx); break
      case 'fence':
      case 'code_block': renderCodeBlock(doc, node.token.content, ctx); break
      case 'hr': renderHr(doc, ctx); break
      case 'table': renderTable(doc, node, ctx); break
      case 'inline': writeRuns(doc, inlineRuns(node.children), { x: ctx.x, width: ctx.width, size: SIZE.body, color: COLOR.text }); break
      case 'html_block': break
      default:
        if (node.children && node.children.length) renderNodes(doc, node.children, ctx)
    }
  }
}

// ─── COVER / TOC / CHROME ──────────────────────────────────────────────────
function drawCover(doc, generatedAt) {
  const cx = doc.page.width / 2
  doc.save()
  doc.rect(0, 0, doc.page.width, 6).fill(COLOR.brand)
  doc.restore()

  doc.fillColor(COLOR.brand).font('Helvetica-Bold').fontSize(34)
  doc.text('Anot Health', doc.page.margins.left, 230, { width: contentWidth(doc), align: 'center' })

  doc.fillColor(COLOR.text).font('Helvetica-Bold').fontSize(20)
  doc.text('Complete Platform Documentation', { width: contentWidth(doc), align: 'center' })

  doc.moveDown(0.6)
  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(12)
  doc.text('Architecture · Operations · Security & Compliance', { width: contentWidth(doc), align: 'center' })

  doc.save().strokeColor(COLOR.rule).lineWidth(1)
    .moveTo(cx - 90, 360).lineTo(cx + 90, 360).stroke().restore()

  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(10.5)
  doc.text(`Generated: ${generatedAt}`, doc.page.margins.left, 380, { width: contentWidth(doc), align: 'center' })
  doc.text('Confidential — for internal IT and operations use only.', { width: contentWidth(doc), align: 'center' })

  doc.save()
  doc.rect(0, doc.page.height - 6, doc.page.width, 6).fill(COLOR.brand)
  doc.restore()
}

function fillToc(doc, tocStartIndex, tocPageCount, entries) {
  let pageOffset = 0
  const startPage = () => {
    doc.switchToPage(tocStartIndex + pageOffset)
    doc.x = doc.page.margins.left
    doc.y = doc.page.margins.top
    doc.fillColor(COLOR.brand).font('Helvetica-Bold').fontSize(SIZE.h1)
    doc.text('Table of Contents', { width: contentWidth(doc) })
    const y = doc.y + 2
    doc.save().strokeColor(COLOR.brand).lineWidth(1.2)
      .moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + contentWidth(doc), y).stroke().restore()
    doc.y = y + 14
  }
  startPage()

  const lineH = 22
  const leftX = doc.page.margins.left
  const width = contentWidth(doc)
  const numX = leftX + width - 40

  entries.forEach((entry, i) => {
    if (doc.y + lineH > pageBottom(doc) && pageOffset + 1 < tocPageCount) {
      pageOffset++
      startPage()
    }
    const y = doc.y
    doc.font('Helvetica').fontSize(SIZE.body).fillColor(COLOR.text)
    const label = `${i + 1}.  ${entry.title}`
    doc.text(label, leftX, y, { width: width - 60, lineBreak: false })

    // Dotted leader.
    const labelW = doc.widthOfString(label)
    const dotsStart = leftX + labelW + 6
    if (numX - 8 > dotsStart) {
      doc.save().fillColor(COLOR.rule)
      let dx = dotsStart
      doc.font('Helvetica').fontSize(SIZE.body)
      while (dx < numX - 8) { doc.text('.', dx, y, { lineBreak: false }); dx += 4 }
      doc.restore()
    }

    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(SIZE.body)
    doc.text(String(entry.page), numX, y, { width: 36, align: 'right', lineBreak: false })
    doc.y = y + lineH
  })
}

function addHeadersFooters(doc, generatedAt) {
  const range = doc.bufferedPageRange()
  const total = range.count
  for (let i = range.start; i < range.start + total; i++) {
    if (i === 0) continue // skip cover
    doc.switchToPage(i)

    // Header/footer text is drawn inside the page margins. Zero the margins for
    // this page while stamping so pdfkit's line-wrapper doesn't think the footer
    // (which sits below the bottom margin) has overflowed and spawn new pages.
    const saved = doc.page.margins
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 }

    const left = MARGIN.left
    const right = doc.page.width - MARGIN.right
    const width = right - left

    // Header.
    doc.font('Helvetica').fontSize(SIZE.small).fillColor(COLOR.muted)
    doc.text(BRAND_TITLE, left, MARGIN.top - 30, { width, align: 'left', lineBreak: false })
    const ruleY = MARGIN.top - 16
    doc.save().strokeColor(COLOR.rule).lineWidth(0.6)
      .moveTo(left, ruleY).lineTo(right, ruleY).stroke().restore()

    // Footer.
    const fY = doc.page.height - MARGIN.bottom + 16
    doc.save().strokeColor(COLOR.rule).lineWidth(0.6)
      .moveTo(left, fY - 6).lineTo(right, fY - 6).stroke().restore()
    doc.font('Helvetica').fontSize(SIZE.small).fillColor(COLOR.muted)
    doc.text(`Generated ${generatedAt}`, left, fY, { width: width / 2, align: 'left', lineBreak: false })
    doc.text(`Page ${i + 1} of ${total}`, left + width / 2, fY, { width: width / 2, align: 'right', lineBreak: false })

    doc.page.margins = saved
  }
}

function renderDocument(doc, mdText, ctx) {
  const tree = nest(md.parse(mdText, {}))
  renderNodes(doc, tree, ctx)
}

async function main() {
  const generatedAt = new Date().toLocaleString('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
  })

  const available = []
  for (const d of DOCUMENTS) {
    if (fs.existsSync(d.file)) available.push(d)
    else console.warn(`[generate-pdf-docs] WARNING: missing, skipping → ${path.relative(ROOT, d.file)}`)
  }
  if (available.length === 0) {
    console.error('[generate-pdf-docs] No source documents found. Nothing to do.')
    process.exit(1)
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: BRAND_TITLE,
      Author: 'Anot Health',
      Subject: 'Complete platform, operations, and compliance documentation',
    },
  })

  const stream = fs.createWriteStream(OUTPUT)
  doc.pipe(stream)

  // 1) Cover (page index 0, auto-created).
  drawCover(doc, generatedAt)

  // 2) Reserve TOC page(s) so content page numbers are final/correct.
  const tocStartIndex = doc.bufferedPageRange().count // 1
  const entriesPerTocPage = 24
  const tocPageCount = Math.max(1, Math.ceil(available.length / entriesPerTocPage))
  for (let k = 0; k < tocPageCount; k++) doc.addPage()

  // 3) Content — one section per document, page break between each.
  const toc = []
  const ctx = { x: doc.page.margins.left, width: contentWidth(doc) }
  for (const d of available) {
    doc.addPage()
    const startPage = doc.bufferedPageRange().count - 1 // current page index
    toc.push({ title: d.title, page: startPage + 1 })

    // Section title.
    doc.fillColor(COLOR.brand).font('Helvetica-Bold').fontSize(SIZE.h1 + 4)
    doc.text(d.title, ctx.x, doc.y, { width: ctx.width })
    const ry = doc.y + 3
    doc.save().strokeColor(COLOR.brand).lineWidth(1.5)
      .moveTo(ctx.x, ry).lineTo(ctx.x + ctx.width, ry).stroke().restore()
    doc.y = ry + 12

    const raw = fs.readFileSync(d.file, 'utf8')
    renderDocument(doc, raw, ctx)
  }

  // 4) Backfill the reserved TOC pages now that page numbers are known.
  fillToc(doc, tocStartIndex, tocPageCount, toc)

  // 5) Headers + footers on every page except the cover.
  addHeadersFooters(doc, generatedAt)

  const pageCount = doc.bufferedPageRange().count
  doc.end()

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })

  const bytes = fs.statSync(OUTPUT).size
  const kb = (bytes / 1024).toFixed(0)
  console.log('\n[generate-pdf-docs] PDF generated successfully.')
  console.log(`  Documents : ${available.length}`)
  console.log(`  Pages     : ${pageCount}`)
  console.log(`  Output    : ${path.relative(ROOT, OUTPUT)} (${kb} KB)`)
  if (process.env.DEBUG_TOC) {
    const withEnd = toc.map((t, i) => ({
      title: t.title,
      startPage: t.page,
      pages: (i + 1 < toc.length ? toc[i + 1].page : pageCount + 1) - t.page,
    }))
    console.table(withEnd)
  }
}

main().catch((err) => {
  console.error('[generate-pdf-docs] Failed:', err)
  process.exit(1)
})
