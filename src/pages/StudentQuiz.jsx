import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function getStoredSubmissionKey(quizId) {
  return `excourse_quiz_submission_key_${quizId}`;
}

function getOrCreateSubmissionKey(quizId) {
  const storageKey = getStoredSubmissionKey(quizId);
  let submissionKey = window.localStorage.getItem(storageKey);

  if (!submissionKey) {
    submissionKey = crypto.randomUUID();
    window.localStorage.setItem(storageKey, submissionKey);
  }

  return submissionKey;
}

function isMissingSubmissionKeyColumn(error) {
  const message = String(error?.message || '').toLowerCase();

  return message.includes('submission_key') && message.includes('schema cache');
}

function isMissingForceSubmitColumns(error) {
  const message = String(error?.message || '').toLowerCase();

  return message.includes('force_submit') || message.includes('finalizing');
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

function getQuizRemainingSeconds(quiz) {
  if (!quiz?.created_at) return null;

  const startedAt = new Date(quiz.created_at).getTime();
  const durationMinutes = Number(quiz.quiz_duration_minutes || 30);

  if (
    Number.isNaN(startedAt) ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0
  ) {
    return null;
  }

  const deadline = startedAt + durationMinutes * 60 * 1000;

  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

async function finalizeExpiredQuizSession(quizId) {
  const { error } = await supabase.rpc('finalize_expired_quiz_session', {
    p_quiz_id: quizId,
  });

  if (error) {
    console.warn('Unable to finalize expired quiz session:', error);
  }
}

export default function StudentQuiz() {
  const { quizId: quizIdFromPath } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const quizId = quizIdFromPath || searchParams.get('quizId') || '';
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
  const [resultNotice, setResultNotice] = useState('');
  const [remainingSeconds, setRemainingSeconds] = useState(null);
  const [isTimeExpired, setIsTimeExpired] = useState(false);
  const [isSessionEnded, setIsSessionEnded] = useState(false);
  const submissionInFlightRef = useRef(false);
  const forcedSubmitTriggeredRef = useRef(false);
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
          results_saved,
          created_at,
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

      const isExpired = data ? getQuizRemainingSeconds(data) === 0 : false;

      if (error || !data || !data.is_active || data.results_saved || isExpired) {
        console.error('Load quiz error:', error);
        if (data?.id && isExpired) {
          finalizeExpiredQuizSession(data.id);
        }
        setQuiz(null);
        setLoadError(
          data?.results_saved || data?.is_active === false || isExpired
            ? 'This quiz session has ended.'
            : 'Invalid quiz link. Please use the link provided by your instructor.'
        );
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
        setIsSessionEnded(false);
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

  const validateSubmission = useCallback(function validateSubmission() {
    if (isTimeExpired) return 'Time is up. This quiz can no longer be submitted.';
    if (!studentName.trim()) return 'Student name is required.';
    if (!studentEmail.trim()) return 'Student email is required.';

    for (const question of orderedQuestions) {
      if (!answers[question.id]?.length) {
        return 'Please answer every question before submitting.';
      }
    }

    return '';
  }, [answers, isTimeExpired, orderedQuestions, studentEmail, studentName]);

  const submitQuiz = useCallback(
    async function submitQuiz({ forced = false, reason = '' } = {}) {
      if (!quiz || result || submissionInFlightRef.current) return;

      submissionInFlightRef.current = true;
      setIsSubmitting(true);
      setStatus('');

      const normalizedStudentName = studentName.trim();
      const normalizedStudentEmail = studentEmail.trim().toLowerCase();

      if (!forced) {
        const validationMessage = validateSubmission();

        if (validationMessage) {
          setStatus(validationMessage);
          setIsSubmitting(false);
          submissionInFlightRef.current = false;
          return;
        }
      }

      try {
        const submissionKey = getOrCreateSubmissionKey(quiz.id);
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
          const isCorrect =
            selectedChoiceIds.length > 0 &&
            arraysMatch(selectedChoiceIds, correctChoiceIds);

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
        const attemptPayload = {
          quiz_template_id: quiz.id,
          submission_key: submissionKey,
          student_name:
            normalizedStudentName ||
            (forced ? 'Unidentified Student' : normalizedStudentName),
          student_email:
            normalizedStudentEmail ||
            (forced
              ? `unprovided-${submissionKey}@excourse.local`
              : normalizedStudentEmail),
          company: company.trim() || null,
          score,
          total_questions: totalQuestions,
          percentage,
          passed,
          submitted_at: submittedAt,
        };

        let { data: attempt, error: attemptError } = await supabase
          .from('quiz_attempts')
          .insert(attemptPayload)
          .select()
          .single();

        if (isMissingSubmissionKeyColumn(attemptError)) {
          const legacyAttemptPayload = { ...attemptPayload };
          delete legacyAttemptPayload.submission_key;

          console.warn(
            'quiz_attempts.submission_key is missing. Retrying submission without duplicate-key protection.'
          );

          const legacyAttemptResponse = await supabase
            .from('quiz_attempts')
            .insert(legacyAttemptPayload)
            .select()
            .single();

          attempt = legacyAttemptResponse.data;
          attemptError = legacyAttemptResponse.error;
        }

        if (attemptError) {
          if (attemptError.code === '23505') {
            setStatus('This quiz attempt was already submitted.');
            return;
          }

          throw attemptError;
        }

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

        if (reason === 'time_expired') {
          await finalizeExpiredQuizSession(quiz.id);
        }

        setResult(submittedResult);
        setResultNotice(
          reason === 'time_expired'
            ? 'Time is up. Your quiz was submitted automatically.'
            : forced
            ? 'The instructor ended the quiz. Your answers were submitted automatically.'
            : ''
        );
        setSearchParams({ attemptId: attempt.id }, { replace: true });
        setStatus('');
      } catch (error) {
        console.error('Submit quiz error:', error);
        if (forced) {
          setIsSessionEnded(true);
          setStatus(
            error?.message?.toLowerCase().includes('row-level security')
              ? 'The instructor ended the quiz. Your answers could not be submitted because the live session is already closed.'
              : error?.message ||
                  'The instructor ended the quiz, but your answers could not be submitted.'
          );
        } else {
          setStatus(error?.message || 'Unable to submit the quiz. Please try again.');
        }
      } finally {
        setIsSubmitting(false);
        submissionInFlightRef.current = false;
      }
    },
    [
      answers,
      company,
      orderedQuestions,
      quiz,
      result,
      setSearchParams,
      studentEmail,
      studentName,
      validateSubmission,
    ]
  );

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus('');
    await submitQuiz();
  }

  const triggerForcedSubmit = useCallback(
    async function triggerForcedSubmit() {
      if (forcedSubmitTriggeredRef.current || submissionInFlightRef.current || result) {
        return;
      }

      forcedSubmitTriggeredRef.current = true;
      setIsSessionEnded(true);
      setStatus('The instructor ended the quiz. Submitting your answers automatically...');
      await submitQuiz({ forced: true });
    },
    [result, submitQuiz]
  );

  useEffect(() => {
    if (!quiz?.id || result) return undefined;

    async function updateRemainingTime() {
      const nextRemainingSeconds = getQuizRemainingSeconds(quiz);

      if (nextRemainingSeconds === null) {
        setRemainingSeconds(null);
        return;
      }

      setRemainingSeconds(nextRemainingSeconds);

      if (nextRemainingSeconds > 0) {
        setIsTimeExpired(false);
        return;
      }

      setIsTimeExpired(true);

      if (forcedSubmitTriggeredRef.current || submissionInFlightRef.current) return;

      forcedSubmitTriggeredRef.current = true;
      setIsSessionEnded(true);
      setStatus('Time is up. Submitting your quiz automatically...');
      await submitQuiz({ forced: true, reason: 'time_expired' });
    }

    const immediateTimerId = window.setTimeout(updateRemainingTime, 0);
    const timerId = window.setInterval(updateRemainingTime, 1000);

    return () => {
      window.clearTimeout(immediateTimerId);
      window.clearInterval(timerId);
    };
  }, [quiz, result, submitQuiz]);

  useEffect(() => {
    if (!quiz?.id || result) return undefined;

    let isActive = true;

    async function checkForceSubmit() {
      if (forcedSubmitTriggeredRef.current || submissionInFlightRef.current) return;

      let { data, error } = await supabase
        .from('quiz_templates')
        .select('id, is_active, results_saved, force_submit, finalizing')
        .eq('id', quiz.id)
        .maybeSingle();

      if (isMissingForceSubmitColumns(error)) {
        const fallbackResponse = await supabase
          .from('quiz_templates')
          .select('id, is_active, results_saved')
          .eq('id', quiz.id)
          .maybeSingle();

        data = fallbackResponse.data;
        error = fallbackResponse.error;
      }

      if (!isActive) return;

      if (error) {
        console.error('Force submit status check error:', error);
        return;
      }

      const shouldForceSubmit =
        !data ||
        data.is_active === false ||
        data.force_submit ||
        data.finalizing ||
        data.results_saved;

      if (!shouldForceSubmit) return;

      await triggerForcedSubmit();
    }

    const immediateTimerId = window.setTimeout(checkForceSubmit, 0);
    const intervalId = window.setInterval(checkForceSubmit, 2000);
    const channel = supabase
      .channel(`quiz-force-submit-${quiz.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'quiz_templates',
          filter: `id=eq.${quiz.id}`,
        },
        (payload) => {
          const updatedQuiz = payload.new || {};
          const shouldForceSubmit =
            updatedQuiz.is_active === false ||
            updatedQuiz.force_submit ||
            updatedQuiz.finalizing ||
            updatedQuiz.results_saved;

          if (shouldForceSubmit) {
            triggerForcedSubmit();
          }
        }
      )
      .subscribe();

    function checkWhenVisible() {
      if (document.visibilityState === 'visible') {
        checkForceSubmit();
      }
    }

    window.addEventListener('focus', checkForceSubmit);
    document.addEventListener('visibilitychange', checkWhenVisible);

    return () => {
      isActive = false;
      window.clearTimeout(immediateTimerId);
      window.clearInterval(intervalId);
      window.removeEventListener('focus', checkForceSubmit);
      document.removeEventListener('visibilitychange', checkWhenVisible);
      supabase.removeChannel(channel);
    };
  }, [quiz?.id, result, triggerForcedSubmit]);

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
    const isEndedSession = loadError === 'This quiz session has ended.';

    return (
      <section className="card invalid-attendance-link">
        <h2>{isEndedSession ? 'Quiz submitted' : 'Invalid Quiz Link'}</h2>
        <p>{loadError}</p>
      </section>
    );
  }

  if (result) {
    return (
      <section className="card quiz-student-card">
        <h2>Quiz Submitted</h2>

        {resultNotice && (
          <div className="alert alert-success" role="status">
            {resultNotice}
          </div>
        )}

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

      {isSessionEnded && !result && (
        <div className="alert alert-error" role="status">
          The instructor ended this quiz session.
        </div>
      )}

      <form className="quiz-form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>
            Student Name *
            <input
              type="text"
              value={studentName}
              onChange={(event) => setStudentName(event.target.value)}
              disabled={isTimeExpired || isSessionEnded}
            />
          </label>

          <label>
            Student Email *
            <input
              type="email"
              value={studentEmail}
              onChange={(event) => setStudentEmail(event.target.value)}
              disabled={isTimeExpired || isSessionEnded}
            />
          </label>
        </div>

        <label>
          Company
          <input
            type="text"
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            disabled={isTimeExpired || isSessionEnded}
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
                    disabled={isTimeExpired || isSessionEnded}
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

        <button type="submit" disabled={isSubmitting || isTimeExpired || isSessionEnded}>
          {isSubmitting ? 'Submitting Quiz...' : 'Submit Quiz'}
        </button>

        {status && <p className="status">{status}</p>}
      </form>
    </section>
  );
}
