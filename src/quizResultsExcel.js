import ExcelJS from 'exceljs';
import { formatDateTime, getQuizResultSummary } from './quizResultsUtils';

function formatDate(value) {
  if (!value) return 'Not provided';

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString();
}

function formatDuration(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Not provided';

  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function formatQuizStatus(quiz) {
  if (quiz.results_saved) return 'Saved Results';
  if (quiz.finalizing) return 'Finalizing';
  if (quiz.force_submit) return 'Ending';
  if (quiz.is_active) return 'Active';
  if (quiz.is_saved_template) return 'Saved Template';

  return 'Inactive';
}

function cleanFileName(value, fallback) {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function parseSelectedChoiceIds(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsedValue = JSON.parse(value);
      return Array.isArray(parsedValue) ? parsedValue : [];
    } catch {
      return [];
    }
  }

  return [];
}

function styleHeaderRow(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF036F5E' },
  };
  row.alignment = { vertical: 'middle', wrapText: true };
}

function finishWorksheet(sheet) {
  sheet.eachRow((row) => {
    row.alignment = { vertical: 'middle', wrapText: true };
  });
}

function getSortedQuestions(quiz) {
  return [...(quiz?.quiz_questions || [])].sort(
    (left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0)
  );
}

function getSortedChoices(question) {
  return [...(question?.quiz_answer_choices || [])].sort(
    (left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0)
  );
}

function addQuizDetailsSheet(workbook, quiz, attempts, generatedAt) {
  const summary = getQuizResultSummary(quiz, attempts);
  const sheet = workbook.addWorksheet('Quiz Details');

  sheet.columns = [{ width: 28 }, { width: 90 }];
  sheet.addRow(['Quiz Results Export', '']);
  sheet.addRow(['Generated Date/Time', generatedAt]);
  sheet.addRow(['Course', quiz.course_name || 'Untitled Course']);
  sheet.addRow(['Quiz', quiz.quiz_title || 'Untitled Quiz']);
  sheet.addRow(['Description', quiz.quiz_description || 'Not provided']);
  sheet.addRow(['Instructor', quiz.instructor_name || 'Not provided']);
  sheet.addRow(['Class Date', formatDate(quiz.class_date)]);
  sheet.addRow(['Passing Score', `${quiz.passing_score ?? 0}%`]);
  sheet.addRow(['Duration', formatDuration(quiz.quiz_duration_minutes)]);
  sheet.addRow(['Status', formatQuizStatus(quiz)]);
  sheet.addRow(['Total Questions', getSortedQuestions(quiz).length]);
  sheet.addRow(['Total Attempts', attempts.length]);
  sheet.addRow(['Class Average', `${summary.averagePercentage.toFixed(2)}%`]);
  sheet.addRow(['Passed', summary.passCount]);
  sheet.addRow(['Failed', summary.failCount]);
  sheet.addRow(['Created', formatDateTime(quiz.created_at)]);
  sheet.addRow(['Last Updated', formatDateTime(quiz.updated_at)]);

  sheet.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF036F5E' } };
  finishWorksheet(sheet);
}

function addStudentResultsSheet(workbook, attempts) {
  const sheet = workbook.addWorksheet('Student Results');

  sheet.columns = [
    { header: 'Student Name', key: 'studentName', width: 24 },
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Company', key: 'company', width: 24 },
    { header: 'Score', key: 'score', width: 12 },
    { header: 'Total Questions', key: 'totalQuestions', width: 16 },
    { header: 'Percentage', key: 'percentage', width: 14 },
    { header: 'Passed/Failed', key: 'passedFailed', width: 16 },
    { header: 'Submitted Date/Time', key: 'submittedAt', width: 24 },
  ];
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'H1' };
  styleHeaderRow(sheet.getRow(1));

  attempts.forEach((attempt) => {
    sheet.addRow({
      studentName: attempt.student_name || '',
      email: attempt.student_email || '',
      company: attempt.company || 'N/A',
      score: attempt.score ?? 0,
      totalQuestions: attempt.total_questions ?? 0,
      percentage: `${Number(attempt.percentage || 0).toFixed(2)}%`,
      passedFailed: attempt.passed ? 'Passed' : 'Failed',
      submittedAt: formatDateTime(attempt.submitted_at),
    });
  });

  finishWorksheet(sheet);
}

function addQuestionInsightsSheet(workbook, quiz, attempts) {
  const summary = getQuizResultSummary(quiz, attempts);
  const sheet = workbook.addWorksheet('Question Insights');

  sheet.columns = [
    { header: 'Question', key: 'question', width: 80 },
    { header: 'Correct', key: 'correct', width: 18 },
    { header: 'Missed', key: 'missed', width: 18 },
    { header: 'Miss Percentage', key: 'missPercentage', width: 18 },
  ];
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'D1' };
  styleHeaderRow(sheet.getRow(1));

  summary.mostMissedQuestions.forEach((question) => {
    sheet.addRow({
      question: question.questionText,
      correct: `${question.correctCount} of ${attempts.length} (${question.correctPercentage.toFixed(2)}%)`,
      missed: `${question.missedCount} of ${attempts.length}`,
      missPercentage: `${question.missPercentage.toFixed(2)}%`,
    });
  });

  finishWorksheet(sheet);
}

function addAnswerDetailsSheet(workbook, quiz, attempts) {
  const sheet = workbook.addWorksheet('Answer Details');
  const questions = getSortedQuestions(quiz);

  sheet.columns = [
    { header: 'Student Name', key: 'studentName', width: 24 },
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Question', key: 'question', width: 80 },
    { header: 'Selected Answer(s)', key: 'selectedAnswers', width: 60 },
    { header: 'Correct Answer(s)', key: 'correctAnswers', width: 60 },
    { header: 'Result', key: 'result', width: 14 },
  ];
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'F1' };
  styleHeaderRow(sheet.getRow(1));

  attempts.forEach((attempt) => {
    const answerMap = new Map(
      (attempt.quiz_attempt_answers || []).map((answer) => [
        answer.question_id,
        answer,
      ])
    );

    questions.forEach((question) => {
      const answer = answerMap.get(question.id);
      const choices = getSortedChoices(question);
      const selectedChoiceIds = parseSelectedChoiceIds(answer?.selected_choice_ids);
      const selectedAnswers = choices
        .filter((choice) => selectedChoiceIds.includes(choice.id))
        .map((choice) => choice.choice_text)
        .join('; ');
      const correctAnswers = choices
        .filter((choice) => choice.is_correct)
        .map((choice) => choice.choice_text)
        .join('; ');

      sheet.addRow({
        studentName: attempt.student_name || '',
        email: attempt.student_email || '',
        question: question.question_text || '',
        selectedAnswers: selectedAnswers || 'No answer',
        correctAnswers: correctAnswers || 'Not provided',
        result: answer?.is_correct ? 'Correct' : 'Incorrect',
      });
    });
  });

  finishWorksheet(sheet);
}

export async function downloadQuizResultsExcel(quiz, attempts) {
  const generatedAt = new Date().toLocaleString();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ExCourse';
  workbook.created = new Date();

  addQuizDetailsSheet(workbook, quiz, attempts, generatedAt);
  addStudentResultsSheet(workbook, attempts);
  addQuestionInsightsSheet(workbook, quiz, attempts);
  addAnswerDetailsSheet(workbook, quiz, attempts);

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  const courseName = cleanFileName(quiz.course_name, 'quiz');
  const quizTitle = cleanFileName(quiz.quiz_title, 'results');

  link.href = url;
  link.download = `${courseName}-${quizTitle}-results.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
