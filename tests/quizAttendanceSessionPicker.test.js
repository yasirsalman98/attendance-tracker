import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const createQuizSource = readFileSync(
  new URL('../src/pages/CreateQuiz.jsx', import.meta.url),
  'utf8'
);
const attendanceRecordsSource = readFileSync(
  new URL('../netlify/functions/attendance-records.js', import.meta.url),
  'utf8'
);

test('quiz attendance picker loads zero-student sessions from training sessions', () => {
  assert.match(attendanceRecordsSource, /view === 'session-picker'/);
  assert.match(attendanceRecordsSource, /\.from\('training_sessions'\)/);
  assert.match(attendanceRecordsSource, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(attendanceRecordsSource, /signedInCount: signedInCounts\.get\(session\.id\) \|\| 0/);
});

test('quiz attendance picker defaults to five sessions and supports remote search', () => {
  assert.match(createQuizSource, /limit: searchTerm \? '25' : '5'/);
  assert.match(createQuizSource, /Search by class, company, or instructor/);
  assert.match(createQuizSource, /loadAttendanceSessions\(attendanceSessionSearch\.trim\(\)\)/);
  assert.doesNotMatch(createQuizSource, /<select\s+id="attendanceSessionId"/);
});

test('attendance sessions are ordered by class date and do not show extra helper copy', () => {
  assert.match(
    createQuizSource,
    /orderAttendanceSessionChoices\(data\?\.sessions \|\| \[\]\)/
  );
  assert.doesNotMatch(createQuizSource, /5 most recently created sessions/);
  assert.doesNotMatch(
    createQuizSource,
    /You can publish without connecting an attendance session\./
  );
});

test('expired empty sessions are excluded while completed sessions remain available', () => {
  assert.match(createQuizSource, /function orderAttendanceSessionChoices\(sessions\)/);
  assert.match(createQuizSource, /expiresAt <= now/);
  assert.match(createQuizSource, /\(session\?\.signedInCount \|\| 0\) > 0/);
  assert.match(attendanceRecordsSource, /const activeSessions = availableSessions\.filter/);
  assert.match(attendanceRecordsSource, /const completedSessions = availableSessions/);
  assert.match(attendanceRecordsSource, /\.\.\.activeSessions, \.\.\.completedSessions/);
});

test('the five-session list is filled with the most recent attendance record classes', () => {
  assert.match(attendanceRecordsSource, /lastAttendanceBySessionId/);
  assert.match(attendanceRecordsSource, /attendanceOrder/);
  assert.match(attendanceRecordsSource, /visibleSessions = \[\.\.\.activeSessions, \.\.\.completedSessions\]\.slice\(0, limit\)/);
  assert.match(createQuizSource, /orderAttendanceSessionChoices\(data\?\.sessions \|\| \[\]\)\.slice/);
});

test('the empty attendance choice is presented as an intentional optional state', () => {
  assert.match(createQuizSource, /Choose an attendance session/);
  assert.match(createQuizSource, /attendance-session-optional-badge/);
  assert.match(createQuizSource, /Continue without an attendance session/);
  assert.match(createQuizSource, /Quiz results will not be linked to attendance\./);
  assert.doesNotMatch(createQuizSource, />\s*No attendance session\s*</);
});
