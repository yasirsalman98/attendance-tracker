# Archived Dangerous SQL

This folder contains SQL that is dangerous to ExCourse production data.

The archived cleanup script must never be run on production. It deletes attendance records, training sessions, signature storage objects, and attendance photo storage objects.

This file was involved in deleting attendance/session/signature/photo data. It is kept only so future maintainers can recognize and avoid the same risk.

Any future cleanup requires a full Supabase backup/export first, written approval, and a reviewed rollback plan before any production action.
