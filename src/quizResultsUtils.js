export function formatDateTime(value) {
  if (!value) return 'N/A';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';

  return date.toLocaleString();
}

export function getAveragePercentage(attempts) {
  if (attempts.length === 0) return 0;

  const total = attempts.reduce(
    (sum, attempt) => sum + Number(attempt.percentage || 0),
    0
  );

  return total / attempts.length;
}

export function getMostMissedQuestions(quiz, attempts) {
  const attemptAnswers = attempts.flatMap(
    (attempt) => attempt.quiz_attempt_answers || []
  );

  return [...(quiz?.quiz_questions || [])]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((question) => {
      const missedCount = attemptAnswers.filter(
        (answer) => answer.question_id === question.id && !answer.is_correct
      ).length;
      const correctCount = attemptAnswers.filter(
        (answer) => answer.question_id === question.id && answer.is_correct
      ).length;
      const missPercentage =
        attempts.length > 0 ? (missedCount / attempts.length) * 100 : 0;
      const correctPercentage =
        attempts.length > 0 ? (correctCount / attempts.length) * 100 : 0;

      return {
        id: question.id,
        questionText: question.question_text,
        correctCount,
        correctPercentage,
        missedCount,
        missPercentage,
      };
    })
    .sort((left, right) => right.missedCount - left.missedCount);
}

export function getQuizResultSummary(quiz, attempts) {
  const passCount = attempts.filter((attempt) => attempt.passed).length;
  const failCount = attempts.length - passCount;
  const mostMissedQuestions = getMostMissedQuestions(quiz, attempts);

  return {
    totalAttempts: attempts.length,
    averagePercentage: getAveragePercentage(attempts),
    passCount,
    failCount,
    mostMissedQuestions,
    mostMissedQuestion: mostMissedQuestions[0] || null,
  };
}

export function downloadQuizResultsCsv(quiz, attempts) {
  const header = [
    'Student name',
    'Email',
    'Company',
    'Score',
    'Total questions',
    'Percentage',
    'Passed',
    'Submitted date/time',
  ];
  const rows = attempts.map((attempt) => [
    attempt.student_name,
    attempt.student_email,
    attempt.company || '',
    attempt.score,
    attempt.total_questions,
    Number(attempt.percentage).toFixed(2),
    attempt.passed ? 'Passed' : 'Failed',
    formatDateTime(attempt.submitted_at),
  ]);
  const csv = [header, ...rows]
    .map((row) =>
      row
        .map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`)
        .join(',')
    )
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  const fileName = `${quiz.course_name}-${quiz.quiz_title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  link.href = url;
  link.download = `${fileName || 'quiz-results'}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
