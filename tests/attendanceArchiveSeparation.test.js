import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isClassArchive,
  isStudentArchive,
  privacySafeErrorCode,
  purgeControls,
} from '../netlify/functions/attendance-archive-cleanup-core.js';

const migration = await readFile(
  new URL('../supabase-attendance-archive-separation-migration.sql', import.meta.url),
  'utf8'
);
const endpoint = await readFile(
  new URL('../netlify/functions/attendance-records.js', import.meta.url),
  'utf8'
);
const cleanup = await readFile(
  new URL('../netlify/functions/attendance-archive-cleanup.js', import.meta.url),
  'utf8'
);
const page = await readFile(
  new URL('../src/pages/AdminRecords.jsx', import.meta.url),
  'utf8'
);

const now = new Date('2026-08-13T12:00:00Z');

test('legacy deleted_student archives remain individual student archives', () => {
  assert.equal(isStudentArchive({
    archived_at: '2026-06-19T12:00:00Z',
    archive_delete_after: '2026-07-19T12:00:00Z',
    archive_source: 'deleted_student',
    archive_type: null,
  }, now), true);
  assert.match(migration, /archive_source = 'deleted_student' then 'student'/);
  assert.doesNotMatch(migration, /archive_source = 'deleted_student' then 'class'/);
});

test('records younger than 30 days and restored records are never eligible', () => {
  assert.equal(isStudentArchive({
    archived_at: '2026-08-01T12:00:00Z',
    archive_delete_after: '2026-08-31T12:00:00Z',
    archive_type: 'student',
  }, now), false);
  assert.equal(isStudentArchive({
    archived_at: null,
    archive_delete_after: '2026-07-01T12:00:00Z',
    archive_type: 'student',
  }, now), false);
  assert.equal(isClassArchive({
    attendance_archived_at: null,
    attendance_archive_delete_after: '2026-07-01T12:00:00Z',
    attendance_archive_type: 'class',
  }, now), false);
});

test('student and class archive mutations use separate transaction scopes', () => {
  assert.match(endpoint, /buildArchivePayload\(userData\.user\)/);
  assert.match(endpoint, /archive_type:[\s\S]*'student'/);
  assert.match(endpoint, /rpc\('archive_attendance_class'/);
  assert.match(endpoint, /rpc\('restore_attendance_student'/);
  assert.match(endpoint, /rpc\('restore_attendance_class'/);
  assert.match(migration, /update public\.training_sessions[\s\S]*attendance_archive_type = 'class'/);
  assert.match(migration, /update public\.attendance_records[\s\S]*archive_type = 'class'/);
  assert.match(migration, /where id = p_record_id[\s\S]*archive_type = 'student'/);
});

test('archive interface separates student and class restores and marks overdue deadlines', () => {
  assert.match(page, /Archived Students/);
  assert.match(page, /Archived Classes/);
  assert.match(page, /Restore Student/);
  assert.match(page, /Restore Class/);
  assert.match(page, /Deletes permanently:/);
  assert.match(page, /Overdue for cleanup/);
  assert.match(page, /Restored with class/);
});

test('purge requires both explicit enablement and backup verification', () => {
  assert.deepEqual(purgeControls({}), {
    enabled: false,
    requested: false,
    backupVerified: false,
  });
  assert.equal(purgeControls({ ARCHIVE_PURGE_ENABLED: 'true' }).enabled, false);
  assert.equal(purgeControls({
    ARCHIVE_PURGE_ENABLED: 'true',
    ARCHIVE_BACKUP_VERIFIED_AT: '2026-08-13T10:00:00Z',
  }).enabled, true);
});

test('cleanup is queue-based, rechecks targets, protects shared files, and retries partial work', () => {
  assert.match(cleanup, /attendance_archive_cleanup_queue/);
  assert.match(cleanup, /isStudentArchive\(recheck\.data\)/);
  assert.match(cleanup, /isClassArchive\(recheck\.data\)/);
  assert.match(cleanup, /isStoragePathShared/);
  assert.match(cleanup, /partial_failed/);
  assert.match(cleanup, /Missing Storage|not found/i);
  assert.match(cleanup, /staleReset/);
});

test('privacy-safe errors never copy database messages into audit error codes', () => {
  assert.equal(privacySafeErrorCode({ code: 'PGRST-500', message: 'student@example.com' }), 'PGRST-500');
  assert.equal(privacySafeErrorCode({ name: 'Storage Error', message: 'secret' }), 'Storage_Error');
});
