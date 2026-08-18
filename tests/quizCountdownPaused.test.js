import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const createQuizSource = await readFile(
  new URL('../src/pages/CreateQuiz.jsx', import.meta.url),
  'utf8'
);
const studentQuizSource = await readFile(
  new URL('../src/pages/StudentQuiz.jsx', import.meta.url),
  'utf8'
);
const quizSchema = await readFile(
  new URL('../supabase-quiz-tables.sql', import.meta.url),
  'utf8'
);
const countdownMigration = await readFile(
  new URL('../supabase-pause-quiz-countdown-migration.sql', import.meta.url),
  'utf8'
);

test('published quizzes have no browser countdown or time-based auto-submit path', () => {
  for (const source of [createQuizSource, studentQuizSource]) {
    assert.doesNotMatch(source, /getQuizRemainingSeconds|time_expired|Time Remaining/);
  }

  assert.doesNotMatch(createQuizSource, /Countdown Time|liveRemainingSeconds/);
  assert.doesNotMatch(studentQuizSource, /isTimeExpired|finalizeExpiredQuizSession/);
});

test('Save Quiz Results still signals students before closing the session', () => {
  assert.match(
    createQuizSource,
    /update\(\{ force_submit: true, finalizing: true \}\)/
  );
  assert.match(createQuizSource, /STUDENT_AUTO_SUBMIT_WAIT_MS/);
  assert.match(
    createQuizSource,
    /results_saved: true,[\s\S]*is_active: false/
  );
  assert.match(studentQuizSource, /updatedQuiz\.force_submit/);
  assert.match(studentQuizSource, /submitQuiz\(\{ forced: true \}\)/);
});

test('Supabase removes the legacy elapsed-time finalization RPC', () => {
  const dropStatement = /drop function if exists public\.finalize_expired_quiz_session\(uuid\)/;

  assert.match(quizSchema, dropStatement);
  assert.match(countdownMigration, dropStatement);
  assert.doesNotMatch(quizSchema, /make_interval\(mins => quiz_duration_minutes\)/);
  assert.doesNotMatch(quizSchema, /grant execute on function public\.finalize_expired_quiz_session/);
});
