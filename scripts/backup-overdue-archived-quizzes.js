import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Supabase service-role configuration is missing.');

const client = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function required(query, label) {
  const result = await query;
  if (result.error) throw new Error(`${label}:${result.error.code || 'failed'}`);
  return result.data || [];
}

const now = new Date();
const quizTemplates = await required(
  client
    .from('quiz_templates')
    .select('*')
    .not('archived_at', 'is', null)
    .lte('archive_delete_after', now.toISOString())
    .in('archive_source', ['saved_quiz', 'saved_quiz_results'])
    .order('archived_at'),
  'quiz_templates'
);
const quizIds = quizTemplates.map((quiz) => quiz.id);
const quizQuestions = quizIds.length
  ? await required(
      client.from('quiz_questions').select('*').in('quiz_template_id', quizIds),
      'quiz_questions'
    )
  : [];
const questionIds = quizQuestions.map((question) => question.id);
const quizAnswerChoices = questionIds.length
  ? await required(
      client.from('quiz_answer_choices').select('*').in('question_id', questionIds),
      'quiz_answer_choices'
    )
  : [];
const quizAttempts = quizIds.length
  ? await required(
      client.from('quiz_attempts').select('*').in('quiz_template_id', quizIds),
      'quiz_attempts'
    )
  : [];
const attemptIds = quizAttempts.map((attempt) => attempt.id);
const quizAttemptAnswers = attemptIds.length
  ? await required(
      client.from('quiz_attempt_answers').select('*').in('quiz_attempt_id', attemptIds),
      'quiz_attempt_answers'
    )
  : [];

const backup = {
  format: 'excourse-overdue-archived-quizzes-v1',
  createdAt: now.toISOString(),
  selection: {
    archived: true,
    deadlineAtOrBefore: now.toISOString(),
    archiveSources: ['saved_quiz', 'saved_quiz_results'],
  },
  quizTemplates,
  quizQuestions,
  quizAnswerChoices,
  quizAttempts,
  quizAttemptAnswers,
};
const serialized = `${JSON.stringify(backup, null, 2)}\n`;
const digest = createHash('sha256').update(serialized).digest('hex');
const timestamp = now.toISOString().replace(/[:.]/g, '-');
const backupDirectory = path.resolve('storage-backups', 'database');
const backupPath = path.join(backupDirectory, `${timestamp}-overdue-archived-quizzes.json`);
const digestPath = `${backupPath}.sha256`;

await mkdir(backupDirectory, { recursive: true });
await writeFile(backupPath, serialized, { encoding: 'utf8', flag: 'wx' });
await writeFile(digestPath, `${digest}  ${path.basename(backupPath)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
});
const verification = await readFile(backupPath, 'utf8');
if (createHash('sha256').update(verification).digest('hex') !== digest) {
  throw new Error('Backup checksum verification failed.');
}

console.log(JSON.stringify({
  backupPath,
  digestPath,
  sha256: digest,
  quizTemplateIds: quizIds,
  counts: {
    quizTemplates: quizTemplates.length,
    quizQuestions: quizQuestions.length,
    quizAnswerChoices: quizAnswerChoices.length,
    quizAttempts: quizAttempts.length,
    quizAttemptAnswers: quizAttemptAnswers.length,
  },
}));
