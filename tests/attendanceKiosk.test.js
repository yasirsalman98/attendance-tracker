import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sessionSource = await readFile(
  new URL('../src/pages/CreateTrainingSession.jsx', import.meta.url),
  'utf8'
);
const attendanceSource = await readFile(
  new URL('../src/pages/AttendanceForm.jsx', import.meta.url),
  'utf8'
);

test('training sessions expose a separate shared-device link below the normal link', () => {
  assert.match(sessionSource, /return `\$\{studentSignInLink\}\?kiosk=1`/);
  assert.match(sessionSource, /Student Sign-In Link[\s\S]*Shared Device Sign-In Link/);
  assert.match(sessionSource, /value=\{studentSignInLink\}/);
  assert.match(sessionSource, /value=\{kioskSignInLink\}/);
});

test('kiosk mode confirms briefly and resets only after a successful insert', () => {
  assert.match(attendanceSource, /const KIOSK_CONFIRMATION_MS = 3000/);
  assert.match(attendanceSource, /searchParams\.get\('kiosk'\) === '1'/);
  assert.match(
    attendanceSource,
    /if \(insertResult\.error\)[\s\S]*if \(isKioskMode\)[\s\S]*setShowKioskConfirmation\(true\)/
  );
  assert.match(
    attendanceSource,
    /setShowKioskConfirmation\(false\)[\s\S]*KIOSK_CONFIRMATION_MS/
  );
  assert.match(attendanceSource, /window\.clearTimeout\(kioskResetTimerRef\.current\)/);
});

test('deleted sessions are excluded from instructor lists and attendance links', () => {
  assert.match(sessionSource, /data\?\.attendance_archived_at/);
  assert.match(sessionSource, /query\.is\('attendance_archived_at', null\)/);
  assert.match(attendanceSource, /!data \|\| data\.attendance_archived_at/);
});
