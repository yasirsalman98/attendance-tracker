# Supabase Storage Backup and Restore

Supabase database backups do not include Storage object files. ExCourse must back up Storage separately so deleted signatures, attendance photos, and instructor templates can be recovered.

## Buckets Backed Up

- `signatures`: trainer signatures and student attendance signatures
- `attendance-photos`: student attendance photos
- `instructor-templates`: custom certificate templates, wallet card designs, and related instructor template files

## How To Run

Run this from the repository root:

```sh
npm run backup:storage
```

Required environment variables:

- `SUPABASE_URL` or `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The backup script only lists and downloads Storage files. It does not write to Supabase, run SQL, or change app data.

## Output Location

Backups are saved under a timestamped folder:

```text
storage-backups/YYYY-MM-DD-HHMMSS/
```

Example:

```text
storage-backups/2026-06-11-093000/signatures/...
storage-backups/2026-06-11-093000/attendance-photos/...
storage-backups/2026-06-11-093000/instructor-templates/...
```

The script also creates a ZIP file next to the timestamped folder when ZIP creation succeeds.

Do not commit backup files. The `storage-backups/` folder is ignored by Git because it can contain private student, instructor, company, and client files.

## Recommended Frequency

Run a Storage backup before any cleanup, deletion, migration, ownership change, or release that touches attendance records, training sessions, instructor templates, signatures, photos, certificates, or wallet cards.

For normal operations, run at least weekly. For active training periods or heavy usage, run daily.

## Restore One Deleted File

1. Find the missing file path in the database or app. Common fields include `attendance_records.signature_path`, `attendance_records.photo_path`, `training_sessions.trainer_signature_path`, or custom template paths in user metadata.
2. Locate the same bucket and path in the backup folder or ZIP.
3. Upload the file back to the same Supabase Storage bucket and exact same object path.
4. Confirm the app displays it again from Admin Records, attendance exports, certificate generation, or wallet card generation.

Restoring the database alone will not restore deleted Storage objects. Storage files must be restored separately from a Storage backup.
