#!/usr/bin/env node
'use strict'

/**
 * Upsert rate-limit parameters into AWS SSM Parameter Store so production
 * instances pick them up via loadSecrets() at boot (USE_SSM=true).
 *
 * Usage:
 *   node scripts/sync-rate-limit-config.js
 *   SSM_PREFIX=/anot/staging RATE_LIMIT_API_MAX=300 node scripts/sync-rate-limit-config.js
 *
 * Requires AWS credentials with ssm:PutParameter on the target prefix.
 */

const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm')

const REGION = process.env.SSM_REGION || process.env.AWS_REGION || 'ap-southeast-1'
const PREFIX = (process.env.SSM_PREFIX || '/anot/prod').replace(/\/$/, '')

const PARAMS = [
  {
    name: 'RATE_LIMIT_LOGIN_MAX',
    value: process.env.RATE_LIMIT_LOGIN_MAX || '5',
  },
  {
    name: 'RATE_LIMIT_LOGIN_WINDOW_MINUTES',
    value: process.env.RATE_LIMIT_LOGIN_WINDOW_MINUTES || '15',
  },
  {
    name: 'RATE_LIMIT_API_MAX',
    value: process.env.RATE_LIMIT_API_MAX || '100',
  },
  {
    name: 'RATE_LIMIT_API_WINDOW_MINUTES',
    value: process.env.RATE_LIMIT_API_WINDOW_MINUTES || '1',
  },
  {
    name: 'JWT_EXPIRES_IN',
    value: process.env.JWT_EXPIRES_IN || '1h',
  },
  {
    name: 'FFMPEG_MAX_UPLOAD_MB',
    value: process.env.FFMPEG_MAX_UPLOAD_MB || '500',
  },
]

async function main() {
  const client = new SSMClient({ region: REGION })

  console.log(`[sync-rate-limit-config] Syncing ${PARAMS.length} parameter(s) to ${PREFIX} (${REGION})`)

  for (const param of PARAMS) {
    const fullName = `${PREFIX}/${param.name}`
    await client.send(
      new PutParameterCommand({
        Name: fullName,
        Value: param.value,
        Type: 'String',
        Overwrite: true,
        Description: 'Anot API rate limit (managed by scripts/sync-rate-limit-config.js)',
      }),
    )
    console.log(`[sync-rate-limit-config] ${fullName} = ${param.value}`)
  }

  console.log('[sync-rate-limit-config] Done.')
}

main().catch((err) => {
  console.error('[sync-rate-limit-config] Failed:', err.message)
  process.exit(1)
})
