# ExCourse Data Safety Policy

This repository must protect ExCourse production data by default.

## Protected Data

Protected data includes attendance records, training sessions, signatures storage, attendance photos storage, quiz results, student attempts, uploaded files, certificate records, wallet card records, client/company data, and any related Supabase storage objects.

## Rules

- Never run destructive SQL against production without a verified backup/export and written approval.
- Never delete from `attendance_records`, `training_sessions`, `storage.objects`, quiz results, certificates, wallet cards, uploaded files, or client/company data without written approval.
- Any cleanup script must be reviewed before use and must include backup/export instructions.
- Any production delete script must be blocked by default.
- Prefer soft-delete/archive fields over hard `DELETE`.
- Do not run archived SQL against production.
- Do not reset, migrate, truncate, or clean production data without a documented recovery path.

## Required Checks

Before every commit or deployment, run:

```sh
npm run safety:check
npm run build
```

The safety check blocks destructive SQL that touches protected ExCourse data unless the file is archived under `archived-dangerous-sql/`.
