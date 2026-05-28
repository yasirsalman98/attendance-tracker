import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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

function formatQuizLabel(quiz) {
  return `${quiz.course_name || 'Untitled Course'} - ${quiz.quiz_title || 'Untitled Quiz'}`;
}

function getAveragePercentage(attempts) {
  if (attempts.length === 0) return 0;

  const total = attempts.reduce(
    (sum, attempt) => sum + Number(attempt.percentage || 0),
    0
  );

  return total / attempts.length;
}

function getMostMissedQuestions(quiz, attempts) {
  const attemptAnswers = attempts.flatMap(
    (attempt) => attempt.quiz_attempt_answers || []
  );

  return [...(quiz?.quiz_questions || [])]
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

function downloadCsv(quiz, attempts) {
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

async function getCurrentUserId() {
  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user?.id) {
    throw new Error('Please sign in again.');
  }

  return data.user.id;
}

export default function QuizResults() {
  const quizDropdownRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [quizzes, setQuizzes] = useState([]);
  const [selectedQuizId, setSelectedQuizId] = useState('');
  const [quizSearchTerm, setQuizSearchTerm] = useState('');
  const [appliedQuizSearchTerm, setAppliedQuizSearchTerm] = useState('');
  const [isQuizDropdownOpen, setIsQuizDropdownOpen] = useState(false);
  const [quizToDelete, setQuizToDelete] = useState(null);
  const [isDeletingQuiz, setIsDeletingQuiz] = useState(false);
  const [attempts, setAttempts] = useState([]);
  const [status, setStatus] = useState('Loading quizzes...');
  const [isLoading, setIsLoading] = useState(false);

  const selectedQuiz = useMemo(
    () => quizzes.find((quiz) => quiz.id === selectedQuizId) || null,
    [quizzes, selectedQuizId]
  );
  const selectedQuizLabel = selectedQuiz ? formatQuizLabel(selectedQuiz) : 'Select Quiz';
  const averagePercentage = getAveragePercentage(attempts);
  const passCount = attempts.filter((attempt) => attempt.passed).length;
  const failCount = attempts.length - passCount;
  const mostMissedQuestions = getMostMissedQuestions(selectedQuiz, attempts);
  const quizIdFromUrl = searchParams.get('quizId') || '';
  const filteredQuizzes = useMemo(() => {
    const searchTerm = appliedQuizSearchTerm.trim().toLowerCase();

    if (!searchTerm) return quizzes;

    return quizzes.filter((quiz) =>
      `${quiz.course_name || ''} ${quiz.quiz_title || ''}`
        .toLowerCase()
        .includes(searchTerm)
    );
  }, [appliedQuizSearchTerm, quizzes]);

  async function loadQuizzes(preferredQuizId = selectedQuizId) {
    setStatus('Loading quizzes...');

    let userId;

    try {
      userId = await getCurrentUserId();
    } catch (error) {
      setQuizzes([]);
      setSelectedQuizId('');
      setAttempts([]);
      setStatus(error?.message || 'Please sign in again.');
      return;
    }

    const { data, error } = await supabase
      .from('quiz_templates')
      .select(`
        *,
        quiz_questions (
          id,
          question_text,
          sort_order
        )
      `)
      .eq('owner_user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Load quizzes error:', error);
      setStatus(error.message);
      return;
    }

    const loadedQuizzes = data || [];
    setQuizzes(loadedQuizzes);

    const nextQuizId =
      preferredQuizId && loadedQuizzes.some((quiz) => quiz.id === preferredQuizId)
        ? preferredQuizId
        : '';

    setSelectedQuizId(nextQuizId);
    setStatus(loadedQuizzes.length ? '' : 'No quizzes found yet.');

    if (nextQuizId) {
      await loadAttempts(nextQuizId);
    } else {
      setAttempts([]);
    }
  }

  async function loadAttempts(quizId) {
    if (!quizId) {
      setAttempts([]);
      return;
    }

    setIsLoading(true);
    setStatus('');

    const { data, error } = await supabase
      .from('quiz_attempts')
      .select(`
        *,
        quiz_attempt_answers (
          id,
          question_id,
          selected_choice_ids,
          is_correct
        )
      `)
      .eq('quiz_template_id', quizId)
      .order('submitted_at', { ascending: false });

    if (error) {
      console.error('Load quiz attempts error:', error);
      setStatus(error.message);
      setAttempts([]);
    } else {
      setAttempts(data || []);
    }

    setIsLoading(false);
  }

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      loadQuizzes(quizIdFromUrl);
    }, 0);

    return () => window.clearTimeout(timerId);
    // The initial load intentionally runs once when the hidden results page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleDocumentMouseDown(event) {
      if (
        quizDropdownRef.current &&
        !quizDropdownRef.current.contains(event.target)
      ) {
        setIsQuizDropdownOpen(false);
      }
    }

    document.addEventListener('mousedown', handleDocumentMouseDown);

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
    };
  }, []);

  function selectQuiz(quizId) {
    setSelectedQuizId(quizId);
    setSearchParams(quizId ? { quizId } : {});
    setIsQuizDropdownOpen(false);
    loadAttempts(quizId);
  }

  function openDeleteQuizPopup(event, quiz) {
    event.stopPropagation();
    setQuizToDelete(quiz);
  }

  async function deleteQuiz() {
    if (!quizToDelete?.id) return;

    setIsDeletingQuiz(true);
    setStatus('');

    const { error } = await supabase
      .from('quiz_templates')
      .delete()
      .eq('id', quizToDelete.id);

    if (error) {
      console.error('Delete quiz error:', error);
      setStatus(error.message || 'Unable to delete quiz.');
      setIsDeletingQuiz(false);
      return;
    }

    setQuizzes((currentQuizzes) =>
      currentQuizzes.filter((quiz) => quiz.id !== quizToDelete.id)
    );

    if (selectedQuizId === quizToDelete.id) {
      setSelectedQuizId('');
      setSearchParams({});
      setAttempts([]);
    }

    setQuizToDelete(null);
    setIsDeletingQuiz(false);
    setStatus('Quiz deleted successfully.');
  }

  function handleQuizSearch(event) {
    event.preventDefault();
    const nextSearchTerm = quizSearchTerm.trim();
    const nextFilteredQuizzes = nextSearchTerm
      ? quizzes.filter((quiz) =>
          `${quiz.course_name || ''} ${quiz.quiz_title || ''}`
            .toLowerCase()
            .includes(nextSearchTerm.toLowerCase())
        )
      : quizzes;

    setAppliedQuizSearchTerm(nextSearchTerm);

    if (
      selectedQuizId &&
      !nextFilteredQuizzes.some((quiz) => quiz.id === selectedQuizId)
    ) {
      setSelectedQuizId('');
      setSearchParams({});
      setAttempts([]);
    }
  }

  return (
    <section className="quiz-page">
      <div className="quiz-card quiz-results-card">
        <div className="admin-header">
          <div>
            <p className="eyebrow">Instructor Results</p>
            <h2>Quiz Results</h2>
            <p className="muted">Review student attempts and class performance.</p>
          </div>

          <div className="admin-actions">
            {selectedQuizId && (
              <Link
                to={`/create-quiz-7392?quizId=${selectedQuizId}`}
                className="secondary-link-button"
              >
                Back to Quiz Link
              </Link>
            )}
            <button type="button" className="secondary-button" onClick={() => loadQuizzes()}>
              Refresh
            </button>
          </div>
        </div>

        {status && <p className="status">{status}</p>}

        {quizzes.length > 0 && (
          <>
            <div className="quiz-select-label">
              <span id="quizSelectLabel">Select Quiz</span>
              <div className="quiz-dropdown" ref={quizDropdownRef}>
                <button
                  type="button"
                  className="secondary-button quiz-dropdown-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={isQuizDropdownOpen}
                  aria-labelledby="quizSelectLabel"
                  onClick={() => setIsQuizDropdownOpen((isOpen) => !isOpen)}
                >
                  <span>{selectedQuizLabel}</span>
                  <span aria-hidden="true">v</span>
                </button>

                {isQuizDropdownOpen && (
                  <div className="quiz-dropdown-menu" role="listbox" aria-labelledby="quizSelectLabel">
                    <form className="quiz-dropdown-search" onSubmit={handleQuizSearch}>
                      <input
                        type="search"
                        value={quizSearchTerm}
                        onChange={(event) => setQuizSearchTerm(event.target.value)}
                        placeholder="Search quizzes"
                        aria-label="Search quizzes"
                      />
                      <button type="submit" className="secondary-button">
                        Search
                      </button>
                    </form>

                    <button
                      type="button"
                      className="secondary-button quiz-dropdown-option"
                      role="option"
                      aria-selected={!selectedQuizId}
                      onClick={() => selectQuiz('')}
                    >
                      Select Quiz
                    </button>

                    {filteredQuizzes.map((quiz) => (
                      <div
                        key={quiz.id}
                        className="quiz-dropdown-option-row"
                        role="option"
                        aria-selected={quiz.id === selectedQuizId}
                      >
                        <button
                          type="button"
                          className="secondary-button quiz-dropdown-option"
                          onClick={() => selectQuiz(quiz.id)}
                        >
                          {formatQuizLabel(quiz)}
                        </button>
                        <button
                          type="button"
                          className="quiz-delete-icon-button"
                          aria-label={`Delete ${formatQuizLabel(quiz)}`}
                          onClick={(event) => openDeleteQuizPopup(event, quiz)}
                        >
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M19 6l-1 14H6L5 6" />
                            <path d="M10 11v5" />
                            <path d="M14 11v5" />
                          </svg>
                        </button>
                      </div>
                    ))}

                    {filteredQuizzes.length === 0 && (
                      <p className="quiz-dropdown-empty">No quizzes found</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {selectedQuiz && (
              <>
                <dl className="quiz-result-details">
                  <div>
                    <dt>Course</dt>
                    <dd>{selectedQuiz.course_name}</dd>
                  </div>
                  <div>
                    <dt>Quiz</dt>
                    <dd>{selectedQuiz.quiz_title}</dd>
                  </div>
                  <div>
                    <dt>Class Date</dt>
                    <dd>{formatDate(selectedQuiz.class_date)}</dd>
                  </div>
                  <div>
                    <dt>Passing Score</dt>
                    <dd>{selectedQuiz.passing_score}%</dd>
                  </div>
                </dl>

                <div className="results-stat-grid">
                  <div>
                    <span>Total Attempts</span>
                    <strong>{attempts.length}</strong>
                  </div>
                  <div>
                    <span>Class Average</span>
                    <strong>{averagePercentage.toFixed(2)}%</strong>
                  </div>
                  <div>
                    <span>Passed</span>
                    <strong>{passCount}</strong>
                  </div>
                  <div>
                    <span>Failed</span>
                    <strong>{failCount}</strong>
                  </div>
                </div>

                <section className="results-section">
                  <div className="quiz-section-header">
                    <h3>Most Missed Questions</h3>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => downloadCsv(selectedQuiz, attempts)}
                      disabled={attempts.length === 0}
                    >
                      Download CSV
                    </button>
                  </div>

                  {mostMissedQuestions.length === 0 ? (
                    <p className="muted">No questions found for this quiz.</p>
                  ) : (
                    <div className="missed-question-list">
                      {mostMissedQuestions.map((question) => (
                        <div className="missed-question-row" key={question.id}>
                          <span>{question.questionText}</span>
                          <strong>
                            {question.missedCount} missed (
                            {question.missPercentage.toFixed(2)}%)
                          </strong>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="results-section">
                  <h3>Class Question Insights</h3>

                  {attempts.length === 0 ? (
                    <p className="muted">
                      Question insights will appear after students submit this quiz.
                    </p>
                  ) : mostMissedQuestions.length === 0 ? (
                    <p className="muted">No questions found for this quiz.</p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Question</th>
                            <th>Correct</th>
                            <th>Missed</th>
                            <th>Miss Percentage</th>
                            <th>Class Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mostMissedQuestions.map((question) => (
                            <tr key={question.id}>
                              <td>{question.questionText}</td>
                              <td>
                                {question.correctCount} of {attempts.length} (
                                {question.correctPercentage.toFixed(2)}%)
                              </td>
                              <td>{question.missedCount} of {attempts.length}</td>
                              <td>{question.missPercentage.toFixed(2)}%</td>
                              <td>
                                {question.missedCount === 0
                                  ? 'No misses'
                                  : 'Review this topic'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className="results-section">
                  <h3>Student Results</h3>

                  {isLoading ? (
                    <p className="status">Loading attempts...</p>
                  ) : attempts.length === 0 ? (
                    <p className="muted">No quiz attempts found yet.</p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Student Name</th>
                            <th>Email</th>
                            <th>Company</th>
                            <th>Score</th>
                            <th>Percentage</th>
                            <th>Passed/Failed</th>
                            <th>Submitted Date/Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {attempts.map((attempt) => (
                            <tr key={attempt.id}>
                              <td>{attempt.student_name}</td>
                              <td>{attempt.student_email}</td>
                              <td>{attempt.company || 'N/A'}</td>
                              <td>
                                {attempt.score} / {attempt.total_questions}
                              </td>
                              <td>{Number(attempt.percentage).toFixed(2)}%</td>
                              <td className={attempt.passed ? 'passed-text' : 'failed-text'}>
                                {attempt.passed ? 'Passed' : 'Failed'}
                              </td>
                              <td>{formatDateTime(attempt.submitted_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </>
            )}
          </>
        )}

        {quizToDelete && (
          <div className="quiz-confirm-overlay" role="presentation">
            <div
              className="quiz-confirm-popup"
              role="dialog"
              aria-modal="true"
              aria-labelledby="deleteQuizTitle"
            >
              <h3 id="deleteQuizTitle">Delete Quiz?</h3>
              <p>
                This will permanently delete {formatQuizLabel(quizToDelete)} and
                all student results for it.
              </p>
              <div className="quiz-confirm-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setQuizToDelete(null)}
                  disabled={isDeletingQuiz}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="quiz-danger-button"
                  onClick={deleteQuiz}
                  disabled={isDeletingQuiz}
                >
                  {isDeletingQuiz ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
