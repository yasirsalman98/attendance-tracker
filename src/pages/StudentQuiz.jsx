import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import jsPDF from 'jspdf';
import { supabase } from '../supabaseClient';
import './Quiz.css';

function formatDate(value) {
  if (!value) return 'Not provided';

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString();
}

function formatDateTime(value) {
  if (!value) return 'N/A';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';

  return date.toLocaleString();
}

function arraysMatch(left, right) {
  if (left.length !== right.length) return false;

  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();

  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function cleanFileName(value, fallback = 'quiz-completion-report') {
  const cleaned = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || fallback;
}

function getStoredAttemptKey(quizId, attemptId) {
  return `excourse_quiz_attempt_${quizId}_${attemptId}`;
}

function getStoredQuizStartKey(quizId) {
  return `excourse_quiz_started_${quizId}`;
}

function formatRemainingTime(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const paddedMinutes = String(minutes).padStart(hours ? 2 : 1, '0');
  const paddedSeconds = String(remainingSeconds).padStart(2, '0');

  return hours
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`;
}

export default function StudentQuiz() {
  const { quizId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [quiz, setQuiz] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [studentName, setStudentName] = useState('');
  const [studentEmail, setStudentEmail] = useState('');
  const [company, setCompany] = useState('');
  const [answers, setAnswers] = useState({});
  const [status, setStatus] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [remainingSeconds, setRemainingSeconds] = useState(null);
  const [isTimeExpired, setIsTimeExpired] = useState(false);
  const attemptIdFromUrl = searchParams.get('attemptId') || '';

  const orderedQuestions = useMemo(() => {
    return [...(quiz?.quiz_questions || [])].sort(
      (left, right) => left.sort_order - right.sort_order
    );
  }, [quiz]);

  useEffect(() => {
    let isActive = true;

    async function loadQuiz() {
      if (!quizId) {
        setLoadError('Invalid quiz link. Please use the link provided by your instructor.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setLoadError('');

      const { data, error } = await supabase
        .from('quiz_templates')
        .select(`
          id,
          course_name,
          quiz_title,
          quiz_description,
          instructor_name,
          class_date,
          passing_score,
          quiz_duration_minutes,
          is_active,
          quiz_questions (
            id,
            question_text,
            question_type,
            sort_order,
            quiz_answer_choices (
              id,
              choice_text,
              sort_order
            )
          )
        `)
        .eq('id', quizId)
        .maybeSingle();

      if (!isActive) return;

      if (error || !data || !data.is_active) {
        console.error('Load quiz error:', error);
        setQuiz(null);
        setLoadError('Invalid quiz link. Please use the link provided by your instructor.');
      } else {
        const sortedQuiz = {
          ...data,
          quiz_questions: (data.quiz_questions || []).map((question) => ({
            ...question,
            quiz_answer_choices: [...(question.quiz_answer_choices || [])].sort(
              (left, right) => left.sort_order - right.sort_order
            ),
          })),
        };

        setQuiz(sortedQuiz);
      }

      setIsLoading(false);
    }

    loadQuiz();

    return () => {
      isActive = false;
    };
  }, [quizId]);

  useEffect(() => {
    if (!quizId || !attemptIdFromUrl) return;

    const storedAttempt = window.localStorage.getItem(
      getStoredAttemptKey(quizId, attemptIdFromUrl)
    );

    if (!storedAttempt) return;

    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResult(JSON.parse(storedAttempt));
      setStatus('');
    } catch (error) {
      console.error('Stored quiz attempt parse error:', error);
      window.localStorage.removeItem(getStoredAttemptKey(quizId, attemptIdFromUrl));
    }
  }, [attemptIdFromUrl, quizId]);

  useEffect(() => {
    if (!quiz?.id || result) return undefined;

    const parsedLimitMinutes = Number(quiz.quiz_duration_minutes || 30);
    const limitMinutes =
      Number.isFinite(parsedLimitMinutes) && parsedLimitMinutes > 0
        ? parsedLimitMinutes
        : 30;

    const storageKey = getStoredQuizStartKey(quiz.id);
    let startedAt = Number(window.localStorage.getItem(storageKey));

    if (!startedAt || Number.isNaN(startedAt)) {
      startedAt = Date.now();
      window.localStorage.setItem(storageKey, String(startedAt));
    }

    function updateRemainingTime() {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const nextRemainingSeconds = Math.max(0, limitMinutes * 60 - elapsedSeconds);

      setRemainingSeconds(nextRemainingSeconds);

      if (nextRemainingSeconds === 0) {
        setIsTimeExpired(true);
        setStatus('Time is up. This quiz can no longer be submitted.');
      } else {
        setIsTimeExpired(false);
      }
    }

    const immediateTimerId = window.setTimeout(updateRemainingTime, 0);
    const timerId = window.setInterval(updateRemainingTime, 1000);

    return () => {
      window.clearTimeout(immediateTimerId);
      window.clearInterval(timerId);
    };
  }, [quiz?.id, quiz?.quiz_duration_minutes, result]);

  function setSingleAnswer(questionId, choiceId) {
    setAnswers((currentAnswers) => ({ ...currentAnswers, [questionId]: [choiceId] }));
  }

  function toggleMultipleAnswer(questionId, choiceId) {
    setAnswers((currentAnswers) => {
      const selectedChoices = currentAnswers[questionId] || [];
      const nextChoices = selectedChoices.includes(choiceId)
        ? selectedChoices.filter((id) => id !== choiceId)
        : [...selectedChoices, choiceId];

      return { ...currentAnswers, [questionId]: nextChoices };
    });
  }

  function validateSubmission() {
    if (isTimeExpired) return 'Time is up. This quiz can no longer be submitted.';
    if (!studentName.trim()) return 'Student name is required.';
    if (!studentEmail.trim()) return 'Student email is required.';

    for (const question of orderedQuestions) {
      if (!answers[question.id]?.length) {
        return 'Please answer every question before submitting.';
      }
    }

    return '';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus('');

    const validationMessage = validateSubmission();

    if (validationMessage) {
      setStatus(validationMessage);
      return;
    }

    setIsSubmitting(true);

    try {
      const questionIds = orderedQuestions.map((question) => question.id);
      const { data: answerKeyRows, error: answerKeyError } = await supabase
        .from('quiz_answer_choices')
        .select('id, question_id, is_correct')
        .in('question_id', questionIds);

      if (answerKeyError) throw answerKeyError;

      const correctChoiceIdsByQuestion = new Map();

      answerKeyRows.forEach((choice) => {
        if (!choice.is_correct) return;

        const currentIds = correctChoiceIdsByQuestion.get(choice.question_id) || [];
        correctChoiceIdsByQuestion.set(choice.question_id, [...currentIds, choice.id]);
      });

      let score = 0;
      const gradedAnswers = orderedQuestions.map((question) => {
        const selectedChoiceIds = answers[question.id] || [];
        const correctChoiceIds = correctChoiceIdsByQuestion.get(question.id) || [];
        const isCorrect = arraysMatch(selectedChoiceIds, correctChoiceIds);

        if (isCorrect) score += 1;

        return {
          questionId: question.id,
          selectedChoiceIds,
          isCorrect,
        };
      });

      const totalQuestions = orderedQuestions.length;
      const percentage =
        totalQuestions > 0 ? Math.round((score / totalQuestions) * 10000) / 100 : 0;
      const passed = percentage >= Number(quiz.passing_score || 80);
      const submittedAt = new Date().toISOString();

      const { data: attempt, error: attemptError } = await supabase
        .from('quiz_attempts')
        .insert({
          quiz_template_id: quiz.id,
          student_name: studentName.trim(),
          student_email: studentEmail.trim().toLowerCase(),
          company: company.trim() || null,
          score,
          total_questions: totalQuestions,
          percentage,
          passed,
          submitted_at: submittedAt,
        })
        .select()
        .single();

      if (attemptError) throw attemptError;

      const attemptAnswers = gradedAnswers.map((answer) => ({
        quiz_attempt_id: attempt.id,
        question_id: answer.questionId,
        selected_choice_ids: answer.selectedChoiceIds,
        is_correct: answer.isCorrect,
      }));

      const { error: answersError } = await supabase
        .from('quiz_attempt_answers')
        .insert(attemptAnswers);

      if (answersError) throw answersError;

      const submittedResult = { ...attempt, submitted_at: submittedAt };

      window.localStorage.setItem(
        getStoredAttemptKey(quiz.id, attempt.id),
        JSON.stringify(submittedResult)
      );
      window.localStorage.removeItem(getStoredQuizStartKey(quiz.id));

      setResult(submittedResult);
      setSearchParams({ attemptId: attempt.id }, { replace: true });
      setStatus('');
    } catch (error) {
      console.error('Submit quiz error:', error);
      setStatus(error?.message || 'Unable to submit the quiz. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function downloadCompletionReport() {
    if (!result || !quiz) return;

    const doc = new jsPDF();
    const submittedAt = formatDateTime(result.submitted_at);

    doc.setTextColor('#036f5e');
    doc.setFontSize(20);
    doc.setFont(undefined, 'bold');
    doc.text('Quiz Completion Report', 20, 24);

    doc.setTextColor('#111827');
    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');

    const rows = [
      ['Student Name', result.student_name],
      ['Student Email', result.student_email],
      ['Company', result.company || 'N/A'],
      ['Course Name', quiz.course_name],
      ['Quiz Title', quiz.quiz_title],
      ['Class Date', formatDate(quiz.class_date)],
      ['Final Score', `${result.score} / ${result.total_questions}`],
      ['Percentage', `${Number(result.percentage).toFixed(2)}%`],
      ['Status', result.passed ? 'Passed' : 'Failed'],
      ['Submitted', submittedAt],
    ];

    rows.forEach(([label, value], index) => {
      const y = 46 + index * 10;
      doc.setFont(undefined, 'bold');
      doc.text(`${label}:`, 20, y);
      doc.setFont(undefined, 'normal');
      doc.text(String(value || 'N/A'), 72, y);
    });

    doc.save(`${cleanFileName(result.student_name)}-quiz-completion-report.pdf`);
  }

  if (isLoading) {
    return (
      <section className="card">
        <h2>Student Quiz</h2>
        <p className="status">Loading quiz...</p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="card invalid-attendance-link">
        <h2>Invalid Quiz Link</h2>
        <p>{loadError}</p>
      </section>
    );
  }

  if (result) {
    return (
      <section className="card quiz-student-card">
        <h2>Quiz Submitted</h2>

        <dl className="quiz-result-details">
          <div>
            <dt>Course</dt>
            <dd>{quiz.course_name}</dd>
          </div>
          <div>
            <dt>Quiz</dt>
            <dd>{quiz.quiz_title}</dd>
          </div>
          <div>
            <dt>Score</dt>
            <dd>
              {result.score} / {result.total_questions}
            </dd>
          </div>
          <div>
            <dt>Percentage</dt>
            <dd>{Number(result.percentage).toFixed(2)}%</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className={result.passed ? 'passed-text' : 'failed-text'}>
              {result.passed ? (
                <span className="passed-status-stack">
                  <span className="passed-status-word">Passed</span>
                  <span aria-hidden="true">🎉</span>
                </span>
              ) : (
                <span className="failed-status-word">Failed</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Submitted</dt>
            <dd>{formatDateTime(result.submitted_at)}</dd>
          </div>
        </dl>

        <button type="button" onClick={downloadCompletionReport}>
          Download Completion Report
        </button>
      </section>
    );
  }

  return (
    <section className="card quiz-student-card">
      <h2>{quiz.quiz_title}</h2>

      <dl className="quiz-result-details">
        <div>
          <dt>Course</dt>
          <dd>{quiz.course_name}</dd>
        </div>
        <div>
          <dt>Class Date</dt>
          <dd>{formatDate(quiz.class_date)}</dd>
        </div>
        <div>
          <dt>Passing Score</dt>
          <dd>{quiz.passing_score}%</dd>
        </div>
      </dl>

      {remainingSeconds !== null && (
        <div className={`quiz-countdown ${isTimeExpired ? 'is-expired' : ''}`}>
          <span>Time Remaining</span>
          <strong>{formatRemainingTime(remainingSeconds)}</strong>
        </div>
      )}

      {quiz.quiz_description && <p className="muted">{quiz.quiz_description}</p>}

      <form className="quiz-form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>
            Student Name *
            <input
              type="text"
              value={studentName}
              onChange={(event) => setStudentName(event.target.value)}
              disabled={isTimeExpired}
            />
          </label>

          <label>
            Student Email *
            <input
              type="email"
              value={studentEmail}
              onChange={(event) => setStudentEmail(event.target.value)}
              disabled={isTimeExpired}
            />
          </label>
        </div>

        <label>
          Company
          <input
            type="text"
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            disabled={isTimeExpired}
          />
        </label>

        <div className="question-list">
          {orderedQuestions.map((question, questionIndex) => (
            <fieldset className="student-question-card" key={question.id}>
              <legend>
                {questionIndex + 1}. {question.question_text}
              </legend>

              {question.quiz_answer_choices.map((choice) => (
                <label className="student-answer-choice" key={choice.id}>
                  <input
                    type={question.question_type === 'multiple_choice' ? 'checkbox' : 'radio'}
                    name={`student-answer-${question.id}`}
                    checked={(answers[question.id] || []).includes(choice.id)}
                    disabled={isTimeExpired}
                    onChange={() => {
                      if (question.question_type === 'multiple_choice') {
                        toggleMultipleAnswer(question.id, choice.id);
                      } else {
                        setSingleAnswer(question.id, choice.id);
                      }
                    }}
                  />
                  {choice.choice_text}
                </label>
              ))}
            </fieldset>
          ))}
        </div>

        <button type="submit" disabled={isSubmitting || isTimeExpired}>
          {isSubmitting ? 'Submitting Quiz...' : 'Submit Quiz'}
        </button>

        {status && <p className="status">{status}</p>}
      </form>
    </section>
  );
}
