import { createClient } from '@supabase/supabase-js';
import {
  isEligibleArchivedQuiz,
  QUIZ_ARCHIVE_SOURCES,
  quizPurgeControls,
  safeQuizCleanupErrorCode,
} from './quiz-archive-cleanup-core.js';

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function getClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_SECRET ||
    process.env.service_role_secret;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isScheduled(event) {
  const scheduledPayload = (() => {
    try {
      const body = JSON.parse(event.body || '{}');
      return Boolean(
        body.next_run && Number.isFinite(new Date(body.next_run).getTime())
      );
    } catch {
      return false;
    }
  })();
  return Boolean(
    event.type === 'schedule' ||
      event.headers?.['x-netlify-event'] === 'schedule' ||
      event.headers?.['x-nf-event'] === 'schedule' ||
      scheduledPayload
  );
}

function isAuthorizedManualRequest(event) {
  const expected = process.env.QUIZ_ARCHIVE_CLEANUP_SECRET;
  const provided = String(
    event.headers?.authorization || event.headers?.Authorization || ''
  ).replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && provided === expected);
}

async function countDependencies(client, quizId) {
  const [questions, attempts] = await Promise.all([
    client.from('quiz_questions').select('id').eq('quiz_template_id', quizId),
    client.from('quiz_attempts').select('id').eq('quiz_template_id', quizId),
  ]);
  if (questions.error) throw questions.error;
  if (attempts.error) throw attempts.error;
  const questionIds = (questions.data || []).map((row) => row.id);
  const attemptIds = (attempts.data || []).map((row) => row.id);
  const [choices, answers] = await Promise.all([
    questionIds.length
      ? client
          .from('quiz_answer_choices')
          .select('id', { count: 'exact', head: true })
          .in('question_id', questionIds)
      : Promise.resolve({ count: 0, error: null }),
    attemptIds.length
      ? client
          .from('quiz_attempt_answers')
          .select('id', { count: 'exact', head: true })
          .in('quiz_attempt_id', attemptIds)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  if (choices.error) throw choices.error;
  if (answers.error) throw answers.error;
  return {
    quizTemplates: 1,
    quizQuestions: questionIds.length,
    quizAnswerChoices: choices.count || 0,
    quizAttempts: attemptIds.length,
    quizAttemptAnswers: answers.count || 0,
  };
}

async function discover(client, now) {
  const result = await client
    .from('quiz_templates')
    .select('id, archived_at, archive_delete_after, archive_source')
    .not('archived_at', 'is', null)
    .lte('archive_delete_after', now.toISOString())
    .in('archive_source', QUIZ_ARCHIVE_SOURCES)
    .order('archive_delete_after');
  if (result.error) throw result.error;
  return (result.data || []).filter((quiz) => isEligibleArchivedQuiz(quiz, now));
}

async function deleteEligibleQuiz(client, quiz, now) {
  const recheck = await client
    .from('quiz_templates')
    .select('id, archived_at, archive_delete_after, archive_source')
    .eq('id', quiz.id)
    .maybeSingle();
  if (recheck.error) throw recheck.error;
  if (!isEligibleArchivedQuiz(recheck.data, now)) return 'skipped';

  const deleted = await client
    .from('quiz_templates')
    .delete()
    .eq('id', quiz.id)
    .not('archived_at', 'is', null)
    .lte('archive_delete_after', now.toISOString())
    .in('archive_source', QUIZ_ARCHIVE_SOURCES)
    .select('id');
  if (deleted.error) throw deleted.error;
  return deleted.data?.length === 1 ? 'success' : 'skipped';
}

export async function handler(event) {
  const scheduled = isScheduled(event);
  if (!scheduled && event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed.' });
  }
  if (!scheduled && !isAuthorizedManualRequest(event)) {
    return jsonResponse(401, { error: 'Unauthorized.' });
  }

  const client = getClient();
  if (!client) return jsonResponse(500, { error: 'Cleanup configuration is incomplete.' });
  const now = new Date();
  const runId = globalThis.crypto?.randomUUID?.() || `quiz-cleanup-${Date.now()}`;
  const controls = quizPurgeControls();

  try {
    const eligible = await discover(client, now);
    const items = [];
    for (const quiz of eligible) {
      try {
        const dependencies = await countDependencies(client, quiz.id);
        const outcome = controls.enabled
          ? await deleteEligibleQuiz(client, quiz, now)
          : 'dry_run';
        items.push({ quizId: quiz.id, outcome, dependencies });
      } catch (error) {
        items.push({
          quizId: quiz.id,
          outcome: 'failed',
          errorCode: safeQuizCleanupErrorCode(error),
        });
      }
    }

    console.log('Quiz archive cleanup audit:', JSON.stringify({
      runId,
      mode: controls.enabled ? 'purge' : 'dry-run',
      eligibleQuizIds: eligible.map((quiz) => quiz.id),
      items,
    }));
    return jsonResponse(200, {
      runId,
      scope: 'archived-quizzes-only',
      mode: controls.enabled ? 'purge' : 'dry-run',
      purgeRequested: controls.requested,
      backupVerified: controls.backupVerified,
      eligibleCount: eligible.length,
      items,
    });
  } catch (error) {
    const errorCode = safeQuizCleanupErrorCode(error);
    console.error('Quiz archive cleanup failed:', errorCode);
    return jsonResponse(500, { error: 'Quiz archive cleanup failed.', errorCode });
  }
}
