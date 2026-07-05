#!/usr/bin/env node
'use strict'
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const script = `async function main() {
  await require('./src/config/loadSecrets').loadSecrets()
  const fs = require('fs')
  const { Client } = require('pg')
  const caPath = '/var/app/current/certs/rds-global-bundle.pem'
  const ssl = fs.existsSync(caPath)
    ? { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
    : { rejectUnauthorized: true }
  let conn = process.env.DATABASE_URL || ''
  if (!conn.startsWith('postgres')) {
    conn = undefined
  } else {
    try {
      const u = new URL(conn)
      for (const k of [...u.searchParams.keys()]) {
        if (/^ssl/i.test(k)) u.searchParams.delete(k)
      }
      conn = u.toString()
    } catch (_) {
      conn = undefined
    }
  }
  const client = conn
    ? new Client({ connectionString: conn, ssl })
    : new Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl,
      })
  await client.connect()
  const updates = [
    [124, '/uploads/visit_124_1783078487689.mp4'],
    [380, '/uploads/visit_380_1783082724128.webm'],
  ]
  let n = 0
  for (const [id, audioPath] of updates) {
    const before = await client.query('SELECT audio_file FROM visits WHERE id = $1', [id])
    console.log('Before', id, before.rows[0]?.audio_file)
    const r = await client.query(
      'UPDATE visits SET audio_file = $1 WHERE id = $2 RETURNING id, audio_file',
      [audioPath, id],
    )
    console.log('Updated', id, r.rows[0]?.audio_file)
    n++
  }
  console.log('REPORT', JSON.stringify({ dbUpdated: n, ok: true }))
  await client.end()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
`

const b64 = Buffer.from(script).toString('base64')
const params = {
  commands: [
    `echo ${b64} | base64 -d > /var/app/current/_day1_db.js`,
    "cd /var/app/current && USE_SSM=true node _day1_db.js 2>&1 | tr -cd '\\11\\12\\15\\40-\\176'",
  ],
}
const paramsPath = path.join(__dirname, 'ssm-day1-db-update.json')
fs.writeFileSync(paramsPath, JSON.stringify(params), 'utf8')

const instanceId = 'i-0085d5d19bace35ae'
const region = 'ap-southeast-1'
const cmdId = execSync(
  `aws ssm send-command --instance-ids ${instanceId} --document-name AWS-RunShellScript --parameters file://${paramsPath.replace(/\\/g, '/')} --region ${region} --query Command.CommandId --output text`,
  { encoding: 'utf8' },
).trim()
console.log('CommandId:', cmdId)

for (let i = 0; i < 12; i++) {
  const out = execSync(
    `aws ssm get-command-invocation --command-id ${cmdId} --instance-id ${instanceId} --region ${region} --output json`,
    { encoding: 'utf8' },
  )
  const inv = JSON.parse(out)
  if (inv.Status === 'Success' || inv.Status === 'Failed' || inv.Status === 'Cancelled') {
    console.log('Status:', inv.Status)
    console.log('Output:', inv.StandardOutputContent || '(empty)')
    if (inv.StandardErrorContent) console.log('Stderr:', inv.StandardErrorContent)
    process.exit(inv.Status === 'Success' ? 0 : 1)
  }
  console.log('Waiting...', inv.Status)
  execSync('node -e "setTimeout(()=>{},3000)"')
}
