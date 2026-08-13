export const QUIZ_ARCHIVE_SOURCES = ['saved_quiz', 'saved_quiz_results'];

export function isEligibleArchivedQuiz(quiz, now = new Date()) {
  const deadline = new Date(quiz?.archive_delete_after || 0);
  return Boolean(
    quiz?.id &&
      quiz.archived_at &&
      QUIZ_ARCHIVE_SOURCES.includes(quiz.archive_source) &&
      Number.isFinite(deadline.getTime()) &&
      deadline.getTime() <= now.getTime()
  );
}

export function quizPurgeControls(environment = process.env) {
  const requested = environment.QUIZ_ARCHIVE_PURGE_ENABLED === 'true';
  const backupVerifiedAt = new Date(
    environment.QUIZ_ARCHIVE_BACKUP_VERIFIED_AT || ''
  );
  const backupVerified = Number.isFinite(backupVerifiedAt.getTime());
  return { requested, backupVerified, enabled: requested && backupVerified };
}

export function safeQuizCleanupErrorCode(error) {
  return String(error?.code || error?.name || 'quiz_cleanup_failed')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
}
