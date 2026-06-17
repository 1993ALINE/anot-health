# Cost Monitoring Guide

**Anot Health** · Version 1.0 · June 16, 2026

This document describes how Anot Health tracks and controls its monthly cloud and AI spend. It covers the
AWS budget alert, the expected per-service cost breakdown, third-party AI usage monitoring (Deepgram and
Anthropic), how to check current spend, the monthly cost report procedure, and ongoing optimization
practices.

> **Audience:** `super_admin` operators and the finance/infrastructure owner with AWS Billing and
> third-party console access. Budget and billing changes affect the whole account and should only be
> made by authorized personnel.

> **Spending guardrails at a glance:**
> - **Hard cap:** $200/month (AWS budget)
> - **Alert trigger:** 80% → $160/month
> - **Target run-rate:** ~$135/month (AWS) + AI usage within budget
> - **Owner / notifications:** `admin@anot.health`

---

## 1. AWS Budget Alert

Set up a monthly cost budget so the team is notified before spend approaches the $200 cap.

### Set up a $200/month budget with an 80% alert

1. Open the **AWS Console → Billing and Cost Management → Budgets**.
2. Click **Create budget**.
3. Choose **Use a template (simplified)** → **Monthly cost budget** (or **Customize (advanced)** for a
   cost budget).
4. Configure:
   - **Budget name:** `anot-monthly-cap`
   - **Period:** Monthly
   - **Budget amount:** **`$200`** (fixed)
5. Configure the **alert threshold**:
   - Trigger at **80% of budgeted amount** → **$160** (actual spend).
   - Recommended: add a second alert at **100% ($200)** and a **forecasted** alert at 100% for early
     warning.
6. **Notification:** email to **`admin@anot.health`**.
7. Click **Create budget**.

> **Note:** AWS Budgets evaluates a few times per day, so alerts are near-real-time, not instant. The
> first notification can take up to ~24 hours after the budget is created.

---

## 2. Service Cost Breakdown

Expected steady-state AWS spend. These are planning targets, not hard limits — reconcile against
**Cost Explorer** monthly (see [§5](#5-how-to-check-current-spend)).

| Service | Role | Target / month |
| --- | --- | --- |
| **RDS** | PostgreSQL database (`anot-postgres`) | ~$50 |
| **S3** | Audio storage (`S3_AUDIO_BUCKET`) | ~$20 |
| **EC2 / Elastic Beanstalk** | Backend API host | ~$50 |
| **CloudFront** | Frontend / API distribution | ~$10 |
| **Other** | SNS, CloudWatch, misc. | ~$5 |
| **Total (AWS)** | | **~$135** |

> **Buffer:** the ~$135 target leaves ~$65 of headroom below the **$200** cap to absorb traffic spikes
> and growth. AI usage (Deepgram + Anthropic) is billed by their respective vendors, **not** AWS — see
> [§3](#3-deepgram-usage-monitoring) and [§4](#4-anthropic-api-usage-monitoring).

---

## 3. Deepgram Usage Monitoring

Deepgram powers audio transcription and is billed by minutes transcribed.

- **Console:** [`https://console.deepgram.com/usage`](https://console.deepgram.com/usage)
- **Metric to watch:** **minutes transcribed per month**
- **Budget:** **5,000 minutes/month** (~$50 at standard rates)
- **Alert threshold:** if usage exceeds **4,000 minutes/month** (80%), review usage and projected
  end-of-month total before it crosses budget.

### What to do when usage is high

- Confirm spikes correspond to real visit volume (not retries or stuck jobs).
- Verify transcription uses **webhook/callback mode** (see [§7](#7-cost-optimization-tips)) so failed or
  retried jobs aren't double-charged.

---

## 4. Anthropic API Usage Monitoring

Anthropic powers AI note generation and is billed by tokens consumed.

- **Track:** **tokens used per month** (input + output) via the Anthropic Console usage/billing page.
- **Budget:** **10M tokens/month** (~$50)
- **Alert threshold:** if usage exceeds **8M tokens/month** (80%), review usage.
- **Optimize:** cache identical/repeated requests where possible to avoid re-spending tokens on the same
  input (see [§7](#7-cost-optimization-tips)).

---

## 5. How to Check Current Spend

1. Open the **AWS Console → Billing and Cost Management → Cost Explorer**.
2. **Group by / filter by Service** (RDS, S3, EC2, CloudFront, etc.).
3. Set the **date range** to **This month** (month-to-date).
4. **Compare** current month-to-date spend and the **forecasted** month-end total against the **$200**
   budget and the per-service targets in [§2](#2-service-cost-breakdown).
5. For AI spend, check the Deepgram and Anthropic consoles separately — these do not appear in AWS Cost
   Explorer.

---

## 6. Monthly Cost Report Procedure

Run on the **first day of each month** for the prior month.

1. **Run the cost analysis** in Cost Explorer (prior month) and pull Deepgram + Anthropic usage totals.
2. **Document:** total spend, breakdown by service, AI minutes/tokens used, and variance vs budget.
3. **Share** the report with the **CEO / stakeholders**.
4. **Store** the report in the **Google Drive compliance folder**.
5. **Alert/act:** if total spend exceeded **$160**, investigate the driver and apply optimizations from
   [§7](#7-cost-optimization-tips). Record the action taken in the log below.

### Monthly cost report log

| Month | Prepared by | AWS total | Deepgram (min) | Anthropic (tokens) | Over $160? | Notes / action |
| --- | --- | --- | --- | --- | --- | --- |
| _YYYY-MM_ | _name_ | _$_ | _min_ | _tokens_ | _Y/N_ | _link to report_ |

---

## 7. Cost Optimization Tips

| Area | Optimization | Status |
| --- | --- | --- |
| **S3 audio** | Lifecycle rule deletes audio after **90 days** | Enabled ✓ |
| **Deepgram** | Use **webhook/callback mode** (instant response, no polling) | Recommended |
| **Anthropic** | **Cache identical requests** to reduce repeated token spend | Recommended |
| **RDS** | Monitor and **close idle/unused connections**; right-size instance | Ongoing |
| **CloudFront** | Tune **cache TTLs** for static assets to maximize cache hit ratio | Ongoing |
| **Elastic Beanstalk** | Use **auto-scaling** to match capacity to real traffic | Ongoing |

---

## 8. Quick Reference Table

Update monthly with actual spend from [§5](#5-how-to-check-current-spend) and [§6](#6-monthly-cost-report-procedure).

| Service | Monthly Budget | Current Spend | Alert Level | Owner |
| --- | --- | --- | --- | --- |
| AWS Total | $200 | TBD | $160 | Admin |
| RDS | $50 | TBD | $40 | Admin |
| S3 Audio | $20 | TBD | $15 | Admin |
| Deepgram | $50 | TBD | $40 | Admin |
| Anthropic | $50 | TBD | $40 | Admin |

> **Contact / notifications:** `admin@anot.health`
