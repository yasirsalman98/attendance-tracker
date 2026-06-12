import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import {
  formatDateTime,
  getQuizResultSummary,
} from '../quizResultsUtils';
import {
  canDeleteSavedQuizResults,
  isSettingsAdminUser,
} from '../userFeatureAccess';
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

function isMissingArchiveColumn(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    (error?.code === '42703' || message.includes('column')) &&
    (message.includes('archived_at') ||
      message.includes('archived_by') ||
      message.includes('archive_delete_after') ||
      message.includes('archive_source'))
  );
}

function buildArchivePayload(user) {
  const archivedAt = new Date();
  const archiveDeleteAfter = new Date(archivedAt);
  archiveDeleteAfter.setDate(archiveDeleteAfter.getDate() + 30);

  return {
    archived_at: archivedAt.toISOString(),
    archived_by: user.id,
    archive_delete_after: archiveDeleteAfter.toISOString(),
    archive_source: 'saved_quiz_results',
  };
}

async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user?.id) {
    throw new Error('Please sign in again.');
  }

  return data.user;
}

export default function QuizResults() {
  const quizDropdownRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [quizzes, setQuizzes] = useState([]);
  const [selectedQuizId, setSelectedQuizId] = useState('');
  const [quizSearchTerm, setQuizSearchTerm] = useState('');
  const [appliedQuizSearchTerm, setAppliedQuizSearchTerm] = useState('');
  const [isQuizDropdownOpen, setIsQuizDropdownOpen] = useState(false);
  const [quizToArchive, setQuizToArchive] = useState(null);
  const [isArchivingQuiz, setIsArchivingQuiz] = useState(false);
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
  const cameFromFullResults = searchParams.get('from') === 'full-results';
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

    let user;

    try {
      user = await getCurrentUser();
      setCanDeleteSavedResults(canDeleteSavedQuizResults(user));
    } catch (error) {
      setQuizzes([]);
      setSelectedQuizId('');
      setAttempts([]);
      setStatus(error?.message || 'Please sign in again.');
      return;
    }

    const selectQuizzes = (includeSavedResults, includeArchiveFilter) => {
      let query = supabase
        .from('quiz_templates')
        .select(`
          *,
          quiz_questions (
            id,
            question_text,
            sort_order
          )
        `);

      if (!isSettingsAdminUser(user)) {
        query = query.eq('owner_user_id', user.id);
      }

      query = includeSavedResults
        ? query.or('is_active.eq.true,results_saved.eq.true')
        : query.eq('is_active', true);

      if (includeArchiveFilter) {
        query = query.is('archived_at', null);
      }

      return query.order('created_at', { ascending: false });
    };

    let { data, error } = await selectQuizzes(true, true);

    if (isMissingArchiveColumn(error)) {
      const fallbackResponse = await selectQuizzes(true, false);
      data = fallbackResponse.data;
      error = fallbackResponse.error;
    }

    if (error?.message?.includes('results_saved')) {
      const fallbackResponse = await selectQuizzes(
        false,
        !isMissingArchiveColumn(error)
      );
      data = fallbackResponse.data;
      error = fallbackResponse.error;

      if (isMissingArchiveColumn(error)) {
        const noArchiveFallbackResponse = await selectQuizzes(false, false);
        data = noArchiveFallbackResponse.data;
        error = noArchiveFallbackResponse.error;
      }
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

  function openArchiveQuizPopup(event, quiz) {
    event.stopPropagation();
    setQuizToArchive(quiz);
  }

  async function archiveQuiz() {
    if (!quizToArchive?.id) return;

    if (quizToArchive.results_saved !== true) {
      setStatus('Only saved quiz results can be archived from this page.');
      setQuizToArchive(null);
      return;
    }

    setIsArchivingQuiz(true);
    setStatus('');

    let user;

    try {
      user = await getCurrentUser();
    } catch (error) {
      setStatus(error?.message || 'Please sign in again.');
      setIsArchivingQuiz(false);
      return;
    }

    let archiveQuery = supabase
      .from('quiz_templates')
      .update(buildArchivePayload(user))
      .eq('id', quizToArchive.id)
      .eq('results_saved', true)
      .is('archived_at', null);

    if (!isSettingsAdminUser(user)) {
      archiveQuery = archiveQuery.eq('owner_user_id', user.id);
    }

    const { data, error } = await archiveQuery.select('id');

    if (error) {
      console.error('Archive saved result error:', error);
      setStatus(error.message || 'Unable to archive saved result.');
      setIsArchivingQuiz(false);
      return;
    }

    if (!Array.isArray(data) || data.length === 0) {
      setStatus('No saved result was archived. Refresh and try again.');
      setIsArchivingQuiz(false);
      return;
    }

    setQuizzes((currentQuizzes) =>
      currentQuizzes.filter((quiz) => quiz.id !== quizToArchive.id)
    );

    if (selectedQuizId === quizToArchive.id) {
      setSelectedQuizId('');
      setSearchParams({});
      setAttempts([]);
    }

    setQuizToArchive(null);
    setIsArchivingQuiz(false);
    setStatus('Saved result archived.');
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
            {!cameFromFullResults && (
              <Link to="/quizzes-7392" className="secondary-link-button">
                Back to Quizzes
              </Link>
            )}
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
                            aria-label={`Archive ${formatQuizLabel(quiz)}`}
                            onClick={(event) => openArchiveQuizPopup(event, quiz)}
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

        {quizToArchive && (
          <div className="quiz-confirm-overlay" role="presentation">
            <div
              className="quiz-confirm-popup"
              role="dialog"
              aria-modal="true"
              aria-labelledby="archiveQuizTitle"
            >
              <h3 id="archiveQuizTitle">Archive Saved Result?</h3>
              <p>
                This will move {formatQuizLabel(quizToArchive)} to Archived
                Quizzes for 30 days.
              </p>
              <div className="quiz-confirm-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setQuizToArchive(null)}
                  disabled={isArchivingQuiz}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="quiz-danger-button"
                  onClick={archiveQuiz}
                  disabled={isArchivingQuiz}
                >
                  {isArchivingQuiz ? 'Archiving...' : 'Archive'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
