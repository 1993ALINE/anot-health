#!/usr/bin/env node
'use strict'

const path = require('path')
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const HTML = path.join(ROOT, 'anot-health-presentation.html')
const OUTPUT = path.join(ROOT, 'Anot-Health-Presentation.pdf')

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto('file://' + HTML.replace(/\\/g, '/'), { waitUntil: 'networkidle' })
  await page.pdf({
    path: OUTPUT,
    width: '297mm',
    height: '210mm',
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  })
  await browser.close()
  console.log('PDF written to', OUTPUT)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
