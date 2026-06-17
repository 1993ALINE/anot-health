# Disaster Recovery Plan

**Anot Health** · Version 1.0 · June 16, 2026

This document describes how Anot Health protects its production PostgreSQL database against data loss
and how to recover it after a corruption, accidental deletion, or infrastructure failure. It covers
automated backups, point-in-time recovery (PITR), recovery objectives, the monthly backup test, and the
emergency recovery procedure.

> **Audience:** `super_admin` operators and infrastructure owners with AWS Console access to the
> production account. Recovery actions create or modify production infrastructure and must only be
> performed by authorized personnel.

> **Production references:**
> - RDS instance: **`anot-postgres`** (PostgreSQL)
> - Application host: AWS Elastic Beanstalk (env var **`DATABASE_URL`**)
> - Frontend: CloudFront → backend API
> - Audio storage: S3 bucket (`S3_AUDIO_BUCKET`) — backed up independently of the database

---

## 1. RDS Automated Backups

Amazon RDS takes a daily automated snapshot of the `anot-postgres` instance and continuously archives
transaction logs, which together enable point-in-time recovery.

### Verify automated backups are enabled

1. Open the **AWS Console → RDS → Databases**.
2. Select the **`anot-postgres`** instance.
3. Open the **Maintenance & backups** tab.
4. Under **Backup**, confirm:
   - **Automated backups:** `Enabled`
   - **Backup retention period:** `7 days`
   - **Backup window:** a defined daily window (e.g. a low-traffic UTC window)
   - **Latest restorable time:** within the last few minutes (confirms log archiving is healthy)

If automated backups show `Disabled`, enable them immediately:

- Click **Modify**, set **Backup retention period** to **7 days** (range 1–35; `0` disables backups),
  choose a backup window, then **Continue → Apply immediately**.

> **Retention:** 7 days is the standard for Anot Health. Increase it via the same **Modify** screen if
> your compliance window requires longer retention. Longer retention increases backup storage cost.

### Access backups in the AWS Console

- **Automated snapshots & PITR window:** RDS → Databases → `anot-postgres` → **Maintenance & backups**.
- **All snapshots (automated + manual):** RDS → **Snapshots**. Filter by instance `anot-postgres`.
  Automated snapshots are named `rds:anot-postgres-YYYY-MM-DD-HH-MM`.
- **Take a manual snapshot anytime:** select the instance → **Actions → Take snapshot**. Manual
  snapshots are **not** deleted when the retention window passes (they persist until you delete them).

---

## 2. Point-in-Time Recovery (PITR)

**Definition:** PITR restores the database to **any second within the retention window** (up to the
**latest restorable time**, typically ~5 minutes ago). RDS does this by restoring the most recent daily
snapshot and replaying archived transaction logs up to your chosen timestamp. The restore always
creates a **brand-new instance** — your existing instance is never modified.

### Steps to perform PITR

1. Go to the **AWS Console → RDS**.
2. Select the **`anot-postgres`** instance.
3. Click **Actions → Restore to point in time**.
4. Choose the **recovery time**:
   - **Latest restorable time** (most recent safe point), or
   - **Custom** — enter the exact date/time (in your console timezone) to restore to. Pick a time
     **just before** the incident (e.g. before an accidental delete) to avoid replaying the bad change.
5. Configure the **new DB instance**:
   - **DB instance identifier:** e.g. `anot-postgres-restore-YYYYMMDD`.
   - Match the **instance class**, **storage**, **VPC/subnet group**, and **security group** of
     production so the application can reach it.
   - Confirm **Encryption** is enabled (a restore of an encrypted source is encrypted).
6. Click **Restore to point in time** and wait for the new instance to reach **Available** (typically
   15–45 minutes depending on database size).
7. **Cut over the application:** update the Elastic Beanstalk **`DATABASE_URL`** environment variable to
   the **new instance endpoint** (Console → Elastic Beanstalk → environment → **Configuration →
   Software → Environment properties**). Apply the change; EB restarts the app against the restored DB.
   - The connection string format is:
     `postgres://<user>:<password>@<new-endpoint>:5432/<dbname>?sslmode=require`
8. **Verify** (see [§5 Emergency Recovery](#5-emergency-recovery)) before announcing recovery complete.
9. Once verified and stable, decommission the old/corrupted instance (take a final manual snapshot first
   if it may be needed for forensics).

---

## 3. Recovery Targets

| Objective | Target | Meaning |
| --- | --- | --- |
| **RPO (Recovery Point Objective)** | **1 hour** | Maximum acceptable data loss. RDS continuous log archiving keeps the latest restorable time within minutes, so realistic data loss is far below 1 hour. |
| **RTO (Recovery Time Objective)** | **2 hours** | Maximum acceptable time from incident declaration to a verified, serving database. Includes restore time, cutover, and verification. |

> These targets assume a single-region recovery using PITR/automated backups. If actual restore time
> trends toward RTO during a monthly test, consider a larger instance class for faster restores or a
> standby replica.

---

## 4. Monthly Backup Test

Run a non-destructive recovery drill on the **first Monday of each month** to prove backups are valid
and the team can meet RTO/RPO. This uses a throwaway instance and never touches production.

1. **Perform a test restore** to a point-in-time from **~24 hours ago** (see [§2](#2-point-in-time-recovery-pitr)).
   Name the instance `anot-postgres-drtest-YYYYMMDD`. **Do not** repoint production `DATABASE_URL` at it.
2. **Verify data integrity** against the restored instance (connect with a read-only client):
   - `SELECT COUNT(*) FROM users;` — row count is sane / matches expectations for that time.
   - `SELECT MAX(created_at) FROM audit_logs;` — confirms the data is from ~24h ago, as expected.
   - Spot-check a recent visit/note record to confirm referential integrity.
3. **Delete the test instance:** RDS → select `anot-postgres-drtest-YYYYMMDD` → **Actions → Delete**.
   Decline the final snapshot prompt (it's a disposable test instance) to avoid storage cost.
4. **Document test completion** in the log below: date, who ran it, restore time achieved, row counts
   observed, and any issues.

### Backup test log

| Date | Performed by | Restore time achieved | `users` count | Result / notes |
| --- | --- | --- | --- | --- |
| _YYYY-MM-DD_ | _name_ | _e.g. 38 min_ | _e.g. 142_ | _Pass / issues_ |

---

## 5. Emergency Recovery

Use this when production data is lost, corrupted, or the instance is unavailable.

- **Primary contact:** `admin@anot.health`
- **Declare the incident** and record the start time (RTO clock starts here).

### Procedure

1. **Stop further writes** if data is being corrupted (e.g. temporarily scale the app down or put it in
   maintenance) to prevent the bad state from spreading.
2. **Choose the recovery source:**
   - **Accidental delete / corruption with a known time:** use **PITR** to a timestamp **just before**
     the incident ([§2](#2-point-in-time-recovery-pitr)).
   - **Instance/host failure with no bad data:** restore the **latest automated backup** (RDS →
     Snapshots → latest `rds:anot-postgres-…` → **Restore snapshot**), or PITR to **latest restorable
     time** for the smallest data loss.
3. **Cut over** the application by updating Elastic Beanstalk **`DATABASE_URL`** to the restored
   instance endpoint and applying the change.
4. **Verify** before declaring recovery complete:
   - `SELECT COUNT(*) FROM users;` — confirms the users table is present and populated.
   - Confirm a known recent user/visit exists and the app can log in and load the dashboard.
5. **Announce recovery** and record the end time. Capture RPO (data loss window) and RTO (elapsed time)
   for the post-incident review.
6. **Post-incident:** take a manual snapshot of the recovered instance, document root cause, and update
   this plan if any step was unclear or slow.

---

## 6. Backup Storage

- **Where:** RDS automated backups and snapshots are stored by AWS in **Amazon S3**, managed entirely by
  RDS (not visible as objects in your own S3 buckets).
- **Encryption:** backups are **encrypted at rest** using the same KMS key as the production database —
  a restore of an encrypted instance is always encrypted. No additional action is required.
- **Retention:** **7 days** for automated backups (configurable 1–35 days via RDS → **Modify**). Manual
  snapshots persist until explicitly deleted.
- **Audio (S3):** patient audio in the `S3_AUDIO_BUCKET` is a separate data store with its own bucket
  encryption and lifecycle policy; it is **not** included in RDS backups. Ensure S3 versioning and/or
  cross-region replication is enabled on that bucket if audio is in scope for recovery.

---

## 7. Quick Reference

| Item | Value |
| --- | --- |
| Production DB instance | `anot-postgres` |
| Backup retention | 7 days |
| RPO / RTO | 1 hour / 2 hours |
| Monthly test | First Monday |
| App DB config | Elastic Beanstalk env var `DATABASE_URL` |
| Verify command | `SELECT COUNT(*) FROM users;` |
| Emergency contact | `admin@anot.health` |
