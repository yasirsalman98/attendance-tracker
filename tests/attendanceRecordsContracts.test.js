import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const functionSource = await readFile(
  new URL('../netlify/functions/attendance-records.js', import.meta.url),
  'utf8'
);
const pageSource = await readFile(
  new URL('../src/pages/AdminRecords.jsx', import.meta.url),
  'utf8'
);
const migrationSource = await readFile(
  new URL('../supabase-attendance-records-performance-index.sql', import.meta.url),
  'utf8'
);

test('summary flow is RPC-only and performs zero Storage signed-URL work', () => {
  const summaryStart = functionSource.indexOf('const selectSessionSummaries');
  const summaryEnd = functionSource.indexOf('const archiveColumnsAvailable', summaryStart);
  const summaryFlow = functionSource.slice(summaryStart, summaryEnd);

  assert.match(summaryFlow, /get_attendance_session_summaries/);
  assert.doesNotMatch(summaryFlow, /addSignedUrl|\.storage|quiz_attempts/);
  assert.match(summaryFlow, /signedUrlRequestCount:\s*0/);
  assert.match(functionSource, /const RECORDS_PAGE_SIZE = 5/);
});

test('student media work exists only in the explicit student-detail flow', () => {
  const studentStart = functionSource.indexOf("if (view === 'students')");
  const summaryStart = functionSource.indexOf('const requestedPage', studentStart);
  const studentFlow = functionSource.slice(studentStart, summaryStart);

  assert.match(studentFlow, /attendance_records/);
  assert.match(studentFlow, /quiz_attempts/);
  assert.match(studentFlow, /student_storage_complete/);
});

test('summary SQL uses the confirmed FK and distinct attendance primary keys', () => {
  assert.match(
    migrationSource,
    /record\.training_session_id\s*=\s*session\.id/
  );
  assert.match(migrationSource, /count\(distinct record\.id\)/);
  assert.doesNotMatch(migrationSource, /quiz_attempts/);
  assert.doesNotMatch(migrationSource, /trainer_signature_url/);
  assert.match(migrationSource, /max\(record\.archived_at\)/);
});

test('Attendance Archive shows the archived date beside Restore Class', () => {
  assert.match(pageSource, /Archived:\s*{formatDateTime\(group\.session\?\.archived_at\)}/);
  assert.match(pageSource, /className="archived-class-date"/);
  assert.match(pageSource, /Restore Class/);
  assert.match(functionSource, /\.select\('archived_at'\)/);
  assert.match(functionSource, /archive_date_lookup_complete/);
});

test('frontend rejects stale endpoints and isolates trainer errors from summaries', () => {
  const trainerStart = pageSource.indexOf('async function loadTrainerSignature');
  const trainerEnd = pageSource.indexOf('async function fetchStudents', trainerStart);
  const trainerFlow = pageSource.slice(trainerStart, trainerEnd);

  assert.match(pageSource, /attendance-lazy-v2/);
  assert.match(trainerFlow, /setTrainerSignatureErrorByRecordId/);
  assert.doesNotMatch(trainerFlow, /setSummariesError|setStatus/);
  assert.match(pageSource, /finally\s*{/);
});

test('refresh aborts obsolete requests and clears student and signature caches', () => {
  const loadStart = pageSource.indexOf('async function loadRecords');
  const loadEnd = pageSource.indexOf('async function deleteRecord', loadStart);
  const loadFlow = pageSource.slice(loadStart, loadEnd);

  assert.match(loadFlow, /abortPendingRequests\(\)/);
  assert.match(loadFlow, /studentCacheRef\.current\.clear\(\)/);
  assert.match(loadFlow, /trainerSignatureCacheRef\.current\.clear\(\)/);
  assert.match(loadFlow, /setSummariesLoading\(false\)/);
  assert.match(loadFlow, /setLoadMoreLoading\(''\)/);
});

test('student loading clears in finally and permission checks remain server-side', () => {
  const studentStart = pageSource.indexOf('async function fetchStudents');
  const studentEnd = pageSource.indexOf('async function toggleStudents', studentStart);
  const studentFlow = pageSource.slice(studentStart, studentEnd);

  assert.match(studentFlow, /finally\s*{/);
  assert.match(studentFlow, /setStudentsLoadingByRecordId/);
  assert.match(functionSource, /sessionMatchesAttendanceAccess/);
  assert.match(functionSource, /p_owner_ids:\s*isSettingsAdmin/);
});

test('active and archived pagination use independent page values', () => {
  assert.match(pageSource, /page:\s*recordsPage \+ 1/);
  assert.match(pageSource, /nextArchivePage:\s*archivePage \+ 1/);
  assert.match(pageSource, /scope:\s*'active'/);
  assert.match(pageSource, /scope:\s*'archived'/);
});
