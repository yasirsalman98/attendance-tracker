import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isEligibleArchivedQuiz,
  quizPurgeControls,
} from '../netlify/functions/quiz-archive-cleanup-core.js';

const cleanupSource = await readFile(
  new URL('../netlify/functions/quiz-archive-cleanup.js', import.meta.url),
  'utf8'
);
const netlifyConfig = await readFile(
  new URL('../netlify.toml', import.meta.url),
  'utf8'
);

const now = new Date('2026-08-13T12:00:00Z');

test('only overdue archived saved quizzes and saved results are eligible', () => {
  assert.equal(isEligibleArchivedQuiz({
    id: 'quiz-1',
    archived_at: '2026-06-01T00:00:00Z',
    archive_delete_after: '2026-07-01T00:00:00Z',
    archive_source: 'saved_quiz',
  }, now), true);
  assert.equal(isEligibleArchivedQuiz({
    id: 'quiz-2',
    archived_at: '2026-06-01T00:00:00Z',
    archive_delete_after: '2026-07-01T00:00:00Z',
    archive_source: 'saved_quiz_results',
  }, now), true);
  assert.equal(isEligibleArchivedQuiz({
    id: 'quiz-3',
    archived_at: '2026-08-01T00:00:00Z',
    archive_delete_after: '2026-09-01T00:00:00Z',
    archive_source: 'saved_quiz',
  }, now), false);
  assert.equal(isEligibleArchivedQuiz({
    id: 'quiz-4',
    archived_at: null,
    archive_delete_after: '2026-07-01T00:00:00Z',
    archive_source: 'saved_quiz',
  }, now), false);
  assert.equal(isEligibleArchivedQuiz({
    id: 'quiz-5',
    archived_at: '2026-06-01T00:00:00Z',
    archive_delete_after: '2026-07-01T00:00:00Z',
    archive_source: 'deleted_student',
  }, now), false);
});

test('automatic quiz purge is disabled without both environment controls', () => {
  assert.equal(quizPurgeControls({}).enabled, false);
  assert.equal(quizPurgeControls({ QUIZ_ARCHIVE_PURGE_ENABLED: 'true' }).enabled, false);
  assert.equal(quizPurgeControls({
    QUIZ_ARCHIVE_PURGE_ENABLED: 'true',
    QUIZ_ARCHIVE_BACKUP_VERIFIED_AT: '2026-08-13T10:00:00Z',
  }).enabled, true);
});

test('cleanup is quiz-only, rechecks archive status, and runs daily', () => {
  assert.match(cleanupSource, /\.from\('quiz_templates'\)/);
  assert.match(cleanupSource, /isEligibleArchivedQuiz\(recheck\.data/);
  assert.doesNotMatch(cleanupSource, /attendance_records|training_sessions|\.storage/);
  assert.match(netlifyConfig, /\[functions\."quiz-archive-cleanup"\][\s\S]*schedule = "@daily"/);
});
