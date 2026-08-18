import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const createQuizSource = await readFile(
  new URL('../src/pages/CreateQuiz.jsx', import.meta.url),
  'utf8'
);
const quizzesSource = await readFile(
  new URL('../src/pages/Quizzes.jsx', import.meta.url),
  'utf8'
);
const featureAccessSource = await readFile(
  new URL('../src/userFeatureAccess.js', import.meta.url),
  'utf8'
);

test('saved quizzes do not add draft or copy labels to names', () => {
  assert.doesNotMatch(createQuizSource, /getSavedQuizDraftLabel|\$\{data\.quiz_title\} Copy/);
  assert.doesNotMatch(quizzesSource, /getSavedQuizDraftLabel/);
  assert.doesNotMatch(featureAccessSource, /getSavedQuizDraftLabel/);
});

test('quiz save controls use neutral saved-quiz language', () => {
  assert.match(createQuizSource, /'Saving Quiz\.\.\.' : 'Save Quiz'/);
  assert.match(createQuizSource, /Quiz saved\. Students will not see it until you publish\./);
  assert.doesNotMatch(createQuizSource, /Save as Draft|Save as Copy|Saving Draft|Saving Copy/);
});
