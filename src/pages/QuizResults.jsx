import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import {
  formatDateTime,
  getQuizResultSummary,
} from '../quizResultsUtils';
import { canDeleteSavedQuizResults } from '../userFeatureAccess';
import './Quiz.css';

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

function formatQuestionCount(quiz) {
  const questionCount = quiz?.quiz_questions?.length || 0;
  return `${questionCount} ${questionCount === 1 ? 'question' : 'questions'}`;
}

function formatQuizStatus(quiz) {
  if (quiz.results_saved) return 'Saved Results';
  if (quiz.finalizing) return 'Finalizing';
  if (quiz.force_submit) return 'Ending';
  if (quiz.is_active) return 'Active';
  if (quiz.is_saved_template) return 'Saved Template';

  return 'Inactive';
}

function formatQuizLabel(quiz) {
  const statusLabel =
    !quiz.is_active && quiz.results_saved ? ' (Saved Results)' : '';

  return `${quiz.course_name || 'Untitled Course'} - ${quiz.quiz_title || 'Untitled Quiz'}${statusLabel}`;
}

async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user?.id) {
    throw new Error('Please sign in again.');
  }

  return data.user;
}

async function getCurrentUserId() {
  const user = await getCurrentUser();

  return user.id;
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
  const [canDeleteSavedResults, setCanDeleteSavedResults] = useState(true);

  const selectedQuiz = useMemo(
    () => quizzes.find((quiz) => quiz.id === selectedQuizId) || null,
    [quizzes, selectedQuizId]
  );
  const selectedQuizLabel = selectedQuiz ? formatQuizLabel(selectedQuiz) : 'Select Quiz';
  const resultSummary = getQuizResultSummary(selectedQuiz, attempts);
  const mostMissedQuestions = resultSummary.mostMissedQuestions;
  const quizIdFromUrl = searchParams.get('quizId') || '';
  const showBackToQuizLink =
    selectedQuiz?.is_active &&
    !selectedQuiz.results_saved &&
    !selectedQuiz.force_submit &&
    !selectedQuiz.finalizing;
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
      const user = await getCurrentUser();
      userId = user.id;
      setCanDeleteSavedResults(canDeleteSavedQuizResults(user));
    } catch (error) {
      setQuizzes([]);
      setSelectedQuizId('');
      setAttempts([]);
      setStatus(error?.message || 'Please sign in again.');
      return;
    }

    const selectQuizzes = (includeSavedResults) => {
      let query = supabase
        .from('quiz_templates')
        .select(`
          *,
          quiz_questions (
            id,
            question_text,
            sort_order
          )
        `)
        .eq('owner_user_id', userId);

      query = includeSavedResults
        ? query.or('is_active.eq.true,results_saved.eq.true')
        : query.eq('is_active', true);

      return query.order('created_at', { ascending: false });
    };

    let { data, error } = await selectQuizzes(true);

    if (error?.message?.includes('results_saved')) {
      const fallbackResponse = await selectQuizzes(false);
      data = fallbackResponse.data;
      error = fallbackResponse.error;
    }

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
    // DATA SAFETY: hard-deletes a saved quiz/results template. Prefer archive
    // behavior for production data and keep this scoped to the owning user.
    if (!quizToDelete?.id) return;

    setIsDeletingQuiz(true);
    setStatus('');

    let userId;

    try {
      userId = await getCurrentUserId();
    } catch (error) {
      setStatus(error?.message || 'Please sign in again.');
      setIsDeletingQuiz(false);
      return;
    }

    const { error } = await supabase
      .from('quiz_templates')
      .delete()
      .eq('id', quizToDelete.id)
      .eq('owner_user_id', userId);

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
        <div className="quiz-results-header">
          <div className="quiz-results-left-actions">
            <Link to="/quizzes-7392" className="secondary-link-button">
              Back to Quizzes
            </Link>
          </div>

          <div className="quiz-results-title">
            <h2>Quiz Results</h2>
            <p className="muted">Review student attempts and class performance.</p>
          </div>

          <div className="admin-actions quiz-results-right-actions">
            {showBackToQuizLink && (
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
                        {canDeleteSavedResults && (
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
                        )}
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
                    <dt>Instructor</dt>
                    <dd>{selectedQuiz.instructor_name || 'Not provided'}</dd>
                  </div>
                  <div>
                    <dt>Class Date</dt>
                    <dd>{formatDate(selectedQuiz.class_date)}</dd>
                  </div>
                  <div>
                    <dt>Passing Score</dt>
                    <dd>{selectedQuiz.passing_score}%</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(selectedQuiz.quiz_duration_minutes)}</dd>
                  </div>
                  <div>
                    <dt>Questions</dt>
                    <dd>{formatQuestionCount(selectedQuiz)}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{formatQuizStatus(selectedQuiz)}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatDateTime(selectedQuiz.created_at)}</dd>
                  </div>
                  <div>
                    <dt>Last Updated</dt>
                    <dd>{formatDateTime(selectedQuiz.updated_at)}</dd>
                  </div>
                  <div className="quiz-detail-wide">
                    <dt>Description</dt>
                    <dd>{selectedQuiz.quiz_description || 'Not provided'}</dd>
                  </div>
                </dl>

                <div className="results-stat-grid">
                  <div>
                    <span>Total Attempts</span>
                    <strong>{attempts.length}</strong>
                  </div>
                  <div>
                    <span>Class Average</span>
                    <strong>{resultSummary.averagePercentage.toFixed(2)}%</strong>
                  </div>
                  <div>
                    <span>Passed</span>
                    <strong>{resultSummary.passCount}</strong>
                  </div>
                  <div>
                    <span>Failed</span>
                    <strong>{resultSummary.failCount}</strong>
                  </div>
                </div>

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
