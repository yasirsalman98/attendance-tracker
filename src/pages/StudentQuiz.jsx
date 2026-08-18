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

function isMissingQuizSessionLinkColumn(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    message.includes('schema cache') &&
    (message.includes('training_session_id') ||
      message.includes('attendance_record_id') ||
      message.includes('completed_at'))
  );
}

function isMissingForceSubmitColumns(error) {
  const message = String(error?.message || '').toLowerCase();

  return message.includes('force_submit') || message.includes('finalizing');
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
  const [isSessionEnded, setIsSessionEnded] = useState(false);
  const submissionInFlightRef = useRef(false);
  const forcedSubmitTriggeredRef = useRef(false);
  const attemptIdFromUrl = searchParams.get('attemptId') || '';

  const orderedQuestions = useMemo(() => {
    return [...(quiz?.quiz_questions || [])].sort(
      (left, right) => left.sort_order - right.sort_order
    );
  }, [quiz]);
  const orderedQuestionResults = useMemo(() => {
    return [...(result?.questionResults || [])].sort((left, right) => {
      if (left.isCorrect === right.isCorrect) return 0;
      return left.isCorrect ? 1 : -1;
    });
  }, [result?.questionResults]);

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

      const selectQuiz = (includeSessionLink) => {
        const sessionLinkField = includeSessionLink ? 'training_session_id,' : '';

        return supabase
          .from('quiz_templates')
          .select(`
            id,
            course_name,
            quiz_title,
            quiz_description,
            instructor_name,
            class_date,
            passing_score,
            is_active,
            results_saved,
            ${sessionLinkField}
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
      };

      let { data, error } = await selectQuiz(true);

      if (isMissingQuizSessionLinkColumn(error)) {
        const fallbackResponse = await selectQuiz(false);
        data = fallbackResponse.data;
        error = fallbackResponse.error;
      }

      if (!isActive) return;

      if (error || !data || !data.is_active || data.results_saved) {
        console.error('Load quiz error:', error);
        setQuiz(null);
        setLoadError(
          data?.results_saved || data?.is_active === false
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
    if (!studentName.trim()) return 'Student name is required.';
    if (!studentEmail.trim()) return 'Student email is required.';

    for (const question of orderedQuestions) {
      if (!answers[question.id]?.length) {
        return 'Please answer every question before submitting.';
      }
    }

    return '';
  }, [answers, orderedQuestions, studentEmail, studentName]);

  const submitQuiz = useCallback(
    async function submitQuiz({ forced = false } = {}) {
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
          .select('id, question_id, choice_text, is_correct')
          .in('question_id', questionIds);

        if (answerKeyError) throw answerKeyError;

        const correctChoiceIdsByQuestion = new Map();
        const choiceTextById = new Map();

        answerKeyRows.forEach((choice) => {
          choiceTextById.set(choice.id, choice.choice_text || '');

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
            questionText: question.question_text || '',
            selectedChoiceIds,
            selectedAnswers: selectedChoiceIds.map(
              (choiceId) => choiceTextById.get(choiceId) || 'Unknown answer'
            ),
            correctAnswers: correctChoiceIds.map(
              (choiceId) => choiceTextById.get(choiceId) || 'Unknown answer'
            ),
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
          completed_at: submittedAt,
          training_session_id: quiz.training_session_id || null,
          attendance_record_id: null,
        };

        let { data: attempt, error: attemptError } = await supabase
          .from('quiz_attempts')
          .insert(attemptPayload)
          .select()
          .single();

        if (
          isMissingSubmissionKeyColumn(attemptError) ||
          isMissingQuizSessionLinkColumn(attemptError)
        ) {
          const legacyAttemptPayload = { ...attemptPayload };
          if (isMissingSubmissionKeyColumn(attemptError)) {
            delete legacyAttemptPayload.submission_key;
          }

          if (isMissingQuizSessionLinkColumn(attemptError)) {
            delete legacyAttemptPayload.completed_at;
            delete legacyAttemptPayload.training_session_id;
            delete legacyAttemptPayload.attendance_record_id;
          }

          console.warn(
            'quiz_attempts is missing newer optional columns. Retrying submission with a legacy payload.'
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

        const submittedResult = {
          ...attempt,
          submitted_at: submittedAt,
          questionResults: gradedAnswers,
        };

        window.localStorage.setItem(
          getStoredAttemptKey(quiz.id, attempt.id),
          JSON.stringify(submittedResult)
        );
        setResult(submittedResult);
        setResultNotice(
          forced
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

        {orderedQuestionResults.length > 0 && (
          <section className="student-result-review">
            <h3>Question Results</h3>
            <div className="student-result-question-list">
              {orderedQuestionResults.map((question, questionIndex) => (
                <article
                  className={`student-result-question ${
                    question.isCorrect ? 'is-correct' : 'is-missed'
                  }`}
                  key={question.questionId}
                >
                  <div className="student-result-question-header">
                    <strong>
                      {questionIndex + 1}. {question.questionText}
                    </strong>
                    <span>{question.isCorrect ? 'Correct' : 'Missed'}</span>
                  </div>

                  <dl>
                    <div>
                      <dt>Your answer</dt>
                      <dd>
                        {question.selectedAnswers?.length
                          ? question.selectedAnswers.join('; ')
                          : 'No answer'}
                      </dd>
                    </div>
                    <div>
                      <dt>Correct answer</dt>
                      <dd>
                        {question.correctAnswers?.length
                          ? question.correctAnswers.join('; ')
                          : 'Not provided'}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </section>
        )}

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
              disabled={isSessionEnded}
            />
          </label>

          <label>
            Student Email *
            <input
              type="email"
              value={studentEmail}
              onChange={(event) => setStudentEmail(event.target.value)}
              disabled={isSessionEnded}
            />
          </label>
        </div>

        <label>
          Company
          <input
            type="text"
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            disabled={isSessionEnded}
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
                    disabled={isSessionEnded}
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

        <button type="submit" disabled={isSubmitting || isSessionEnded}>
          {isSubmitting ? 'Submitting Quiz...' : 'Submit Quiz'}
        </button>

        {status && <p className="status">{status}</p>}
      </form>
    </section>
  );
}
