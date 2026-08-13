import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildHistoricalClassDraft,
  selectBasicStudentFields,
} from '../src/historicalClassModel.js';
import {
  archiveLocalHistoricalStudent,
  createHistoricalClassFixture,
  getLocalHistoricalClass,
  getLocalHistoricalClasses,
  getLocalHistoricalStudentArchives,
  loadHistoricalSourceStudentsFixture,
  resetHistoricalClassFixtureSubmissions,
  restoreLocalHistoricalStudent,
} from '../src/historicalClassLocalService.js';
import { canCreateHistoricalClass } from '../src/userFeatureAccess.js';
import { createHistoricalClassHandler } from '../netlify/functions/historical-class.js';

const dashboardSource = await readFile(new URL('../src/pages/InstructorDashboard.jsx', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../src/pages/CreateHistoricalClass.jsx', import.meta.url), 'utf8');
const migrationSource = await readFile(new URL('../supabase-historical-class-migration.sql', import.meta.url), 'utf8');
const historicalEndpointSource = await readFile(new URL('../netlify/functions/historical-class.js', import.meta.url), 'utf8');
const historicalServiceSource = await readFile(new URL('../src/historicalClassLocalService.js', import.meta.url), 'utf8');
const adminRecordsSource = await readFile(new URL('../src/pages/AdminRecords.jsx', import.meta.url), 'utf8');

const classInfo = {
  courseName: 'Historical Fixture Class',
  trainingDate: '2025-01-10',
  startTime: '09:00',
  endTime: '13:00',
  trainerName: 'Fixture Trainer',
  companyName: 'Fixture Company',
  location: 'Fixture Room',
  courseOutline: 'Fixture outline',
  reasonCategory: 'Administrative correction',
  reasonExplanation: '',
};
const sourceSession = {
  id: 'fixture-session',
  course_name: 'Source Fixture',
  training_date: '2025-01-01',
};
const createdBy = { id: 'fixture-admin', email: 'excourse7233@gmail.com' };

test('dashboard card and frontend route are restricted to the settings administrator', () => {
  assert.equal(canCreateHistoricalClass({ email: 'excourse7233@gmail.com' }), true);
  assert.equal(canCreateHistoricalClass({ email: 'trainer@example.test' }), false);
  assert.match(dashboardSource, /canCreateHistoricalClass\(session\?\.user\)/);
  assert.match(dashboardSource, /Create Historical Class/);
  assert.match(appSource, /HistoricalClassRoute/);
  assert.match(appSource, /!canCreateHistoricalClass\(session\.user\)/);
});

test('backend rejects unauthorized users and requires the explicit production write flag', async () => {
  const unauthorized = createHistoricalClassHandler({
    authenticate: async () => ({ id: 'trainer', email: 'trainer@example.test' }),
    environment: {},
  });
  const denied = await unauthorized({ httpMethod: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}' });
  assert.equal(denied.statusCode, 403);

  const admin = createHistoricalClassHandler({
    authenticate: async () => createdBy,
    environment: { CONTEXT: 'dev' },
  });
  const disabled = await admin({ httpMethod: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}' });
  assert.equal(disabled.statusCode, 503);
  assert.match(disabled.body, /not enabled for this deployment/);

  const enabled = createHistoricalClassHandler({
    authenticate: async () => createdBy,
    environment: { CONTEXT: 'production', HISTORICAL_CLASS_WRITES_ENABLED: 'true' },
  });
  const invalidSignature = await enabled({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer fixture' },
    body: JSON.stringify({
      classInfo,
      sourceSessionId: sourceSession.id,
      selectedSourceAttendanceIds: ['student-1'],
      idempotencyKey: 'production-enabled-test',
    }),
  });
  assert.equal(invalidSignature.statusCode, 400);
  assert.match(invalidSignature.body, /trainer signature/i);
});

test('116-student fixture is paginated and source data remains unchanged', async () => {
  const first = await loadHistoricalSourceStudentsFixture('fixture-session-116');
  const snapshot = JSON.stringify(first);
  first[0].student_name = 'Changed only in caller';
  const second = await loadHistoricalSourceStudentsFixture('fixture-session-116');
  assert.equal(second.length, 116);
  assert.equal(JSON.stringify(second), snapshot);
  assert.match(pageSource, /const ROSTER_PAGE_SIZE = 25/);
  assert.match(pageSource, /filteredStudents\.slice/);
  assert.match(pageSource, /Search students/);
  assert.match(pageSource, /Select all/);
  assert.match(pageSource, /Clear all/);
});

test('student details and attendance evidence are prepared without system metadata', () => {
  const source = {
    id: 'source-record',
    student_name: 'Fixture Student',
    student_email: 'fixture@example.test',
    company: 'Fixture Company',
    signature_path: 'forbidden.png',
    signature_url: 'forbidden-url',
    photo_path: 'forbidden.jpg',
    signed_at: '2025-01-01T00:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    quiz_completed: true,
    archive_source: 'forbidden',
    training_session_id: 'forbidden-session',
  };
  assert.deepEqual(selectBasicStudentFields(source), {
    student_name: 'Fixture Student',
    student_email: 'fixture@example.test',
    company: 'Fixture Company',
    signature_path: 'forbidden.png',
    photo_path: 'forbidden.jpg',
    signed_at: '2025-01-01T00:00:00Z',
  });
});

test('historical date is preserved and created_at is not backdated', () => {
  const draft = buildHistoricalClassDraft({
    classInfo,
    sourceSession,
    selectedStudents: [{ id: 'student-1', student_name: 'Fixture', student_email: 'fixture@example.test' }],
    createdBy,
    idempotencyKey: 'fixture-idempotency-1',
  });
  assert.equal(draft.class.training_date, '2025-01-10');
  assert.equal(draft.created_at, null);
  assert.equal(draft.students[0].signature_path, null);
  assert.equal(draft.students[0].photo_path, null);
  assert.equal(draft.students[0].signed_at, null);
});

test('duplicates are rejected and repeated local submissions are idempotent', async () => {
  assert.throws(() => buildHistoricalClassDraft({
    classInfo,
    sourceSession,
    selectedStudents: [
      { id: 'duplicate', student_name: 'One' },
      { id: 'duplicate', student_name: 'One' },
    ],
    createdBy,
    idempotencyKey: 'fixture-idempotency-2',
  }), /more than once/);

  resetHistoricalClassFixtureSubmissions();
  const draft = buildHistoricalClassDraft({
    classInfo,
    sourceSession,
    selectedStudents: [{ id: 'student-1', student_name: 'Fixture', student_email: 'fixture@example.test' }],
    createdBy,
    idempotencyKey: 'fixture-idempotency-3',
  });
  const first = await createHistoricalClassFixture(draft);
  const second = await createHistoricalClassFixture(draft);
  assert.equal(first.createdAt, second.createdAt);
  assert.equal(first.historicalClassId, undefined);
  assert.equal(second.repeated, true);
});

test('failed local requests write nothing and can be retried safely', async () => {
  resetHistoricalClassFixtureSubmissions();
  const draft = buildHistoricalClassDraft({
    classInfo,
    sourceSession,
    selectedStudents: [{ id: 'student-1', student_name: 'Fixture', student_email: 'fixture@example.test' }],
    createdBy,
    idempotencyKey: 'fixture-idempotency-4',
  });
  await assert.rejects(createHistoricalClassFixture(draft, { fail: true }), /Simulated/);
  const retry = await createHistoricalClassFixture(draft);
  assert.equal(retry.repeated, undefined);
  assert.equal(retry.productionWrites, 0);
  assert.equal(retry.storageWrites, 0);
});

test('private local creation persists a class for Attendance Records only in browser storage', async () => {
  const storedValues = new Map();
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => storedValues.get(key) || null,
      setItem: (key, value) => storedValues.set(key, value),
    },
  });
  try {
    const draft = buildHistoricalClassDraft({
      classInfo,
      sourceSession,
      selectedStudents: [{ id: 'private-student-1', student_name: 'Private Fixture' }],
      createdBy,
      idempotencyKey: 'private-local-attendance-test',
    });
    const result = await createHistoricalClassFixture(draft);
    assert.match(result.sessionId, /^local-historical-/);
    assert.equal(getLocalHistoricalClasses().length, 1);
    assert.equal(getLocalHistoricalClass(result.sessionId).course_name, classInfo.courseName);
    archiveLocalHistoricalStudent(result.sessionId, 'private-student-1');
    assert.equal(getLocalHistoricalClass(result.sessionId).student_count, 0);
    assert.equal(getLocalHistoricalStudentArchives().length, 1);
    restoreLocalHistoricalStudent(result.sessionId, 'private-student-1');
    assert.equal(getLocalHistoricalClass(result.sessionId).student_count, 1);
    assert.equal(getLocalHistoricalStudentArchives().length, 0);
    assert.match(adminRecordsSource, /mergeLocalHistoricalSessions/);
    assert.match(adminRecordsSource, /Private local test/);
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    else delete globalThis.localStorage;
  }
});

test('unapplied migration prepares transactional copy and never backdates created_at', () => {
  assert.match(migrationSource, /create or replace function public\.create_historical_class/);
  assert.match(migrationSource, /idempotency_key text not null unique/);
  assert.doesNotMatch(migrationSource, /verification|attestation/i);
  assert.match(migrationSource, /from public\.attendance_records as source/);
  assert.match(migrationSource, /source\.signature_path, source\.photo_path/);
  assert.match(migrationSource, /p_class->>'trainer_signature_path'/);
  const sessionInsert = migrationSource.match(/insert into public\.training_sessions[\s\S]*?returning id/)?.[0] || '';
  assert.doesNotMatch(sessionInsert, /created_at/);
});

test('historical page uses protected reads and never imports Supabase or Storage directly', () => {
  assert.match(pageSource, /historicalClassLocalService/);
  assert.match(pageSource, /searchHistoricalSourceClasses/);
  assert.match(pageSource, /loadHistoricalSourceStudents/);
  assert.doesNotMatch(pageSource, /The database.*created_at.*not be backdated/);
  assert.doesNotMatch(pageSource, /supabaseClient|supabase\.|\.storage\.|createSignedUrl/);
  assert.match(pageSource, /import\.meta\.env\.DEV/);
});

test('historical frontend and endpoint enforce matching read and write versions', () => {
  assert.match(historicalServiceSource, /READ_RESPONSE_VERSION = 'historical-class-read-v1'/);
  assert.match(historicalServiceSource, /WRITE_RESPONSE_VERSION = 'historical-class-v1'/);
  assert.match(historicalServiceSource, /data\?\.responseVersion !== WRITE_RESPONSE_VERSION/);
  assert.match(historicalEndpointSource, /READ_RESPONSE_VERSION = 'historical-class-read-v1'/);
  assert.match(historicalEndpointSource, /WRITE_RESPONSE_VERSION = 'historical-class-v1'/);
  assert.match(historicalEndpointSource, /responseVersion: WRITE_RESPONSE_VERSION/);
});

test('source reads include student evidence paths without generating storage URLs', () => {
  assert.match(historicalEndpointSource, /view === 'sources'/);
  assert.match(historicalEndpointSource, /view === 'students'/);
  assert.match(historicalEndpointSource, /id, student_name, student_email, company/);
  assert.doesNotMatch(pageSource, /Employee ID|employee_identifier/);
  assert.match(historicalEndpointSource, /signature_path, photo_path, signed_at/);
  assert.doesNotMatch(historicalEndpointSource, /createSignedUrl/);
});
