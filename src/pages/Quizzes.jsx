import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import './Quiz.css';

function formatDate(value) {
  if (!value) return 'Not provided';

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString();
}

function formatDuration(minutes) {
  const duration = Number(minutes || 0);

  if (duration === 1) return '1 minute';
  if (duration < 60) return `${duration} minutes`;

  const hours = Math.floor(duration / 60);
  const remainingMinutes = duration % 60;
  const hourLabel = hours === 1 ? '1 hour' : `${hours} hours`;

  return remainingMinutes
    ? `${hourLabel} ${remainingMinutes} min`
    : hourLabel;
}

async function getCurrentUserId() {
  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user?.id) {
    throw new Error('Please sign in again.');
  }

  return data.user.id;
}

async function getCurrentAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  const accessToken = data?.session?.access_token;

  if (error || !accessToken) {
    throw new Error('Please sign in again.');
  }

  return accessToken;
}

function isLocalHost() {
  return (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );
}

function getSavedQuizLibraryUrl() {
  if (isLocalHost()) {
    return 'http://localhost:3001/.netlify/functions/saved-quiz-library';
  }

  return '/.netlify/functions/saved-quiz-library';
}

async function readFunctionJson(response, fallbackMessage) {
  const responseText = await response.text();
  let responseData = null;

  if (responseText.trim()) {
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      responseData?.error ||
        (responseText && !responseText.trim().startsWith('<') ? responseText : '') ||
        `${fallbackMessage} (${response.status} ${response.statusText})`
    );
  }

  return responseData || {};
}

async function syncSavedQuizLibrary() {
  const accessToken = await getCurrentAccessToken();

  const response = await fetch(getSavedQuizLibraryUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const responseData = await readFunctionJson(
    response,
    'Unable to sync saved quiz library.'
  );

  return responseData?.importedQuizCount || 0;
}

async function fetchSavedQuizLibrary() {
  const accessToken = await getCurrentAccessToken();
  const response = await fetch(getSavedQuizLibraryUrl(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return readFunctionJson(response, 'Unable to load saved quiz library.');
}

function getSavedQuizOptionLabel(quiz) {
  return `${quiz.course_name || 'Untitled Course'} - ${
    quiz.quiz_title || 'Untitled Quiz'
  }${quiz.is_active ? '' : ' (Draft)'}`;
}

function isOriginalSavedQuizTemplate(quiz) {
  const quizTitle = (quiz.quiz_title || '').trim();
  const isSavedTemplate =
    'is_saved_template' in quiz
      ? quiz.is_saved_template !== false
      : quiz.is_active === false && !quiz.results_saved;

  return isSavedTemplate && !/\bcopy$/i.test(quizTitle);
}

function isMissingSavedTemplateColumn(error) {
  return String(error?.message || '').toLowerCase().includes('is_saved_template');
}

export default function Quizzes() {
  const [allSavedQuizzes, setAllSavedQuizzes] = useState([]);
  const [savedQuizzes, setSavedQuizzes] = useState([]);
  const [selectedSavedQuizId, setSelectedSavedQuizId] = useState('');
  const [selectedCopiedQuizId, setSelectedCopiedQuizId] = useState('');
  const [isLoadingSavedQuizzes, setIsLoadingSavedQuizzes] = useState(false);
  const [deletingCopiedQuizId, setDeletingCopiedQuizId] = useState('');
  const [savedResultQuizzes, setSavedResultQuizzes] = useState([]);
  const [isLoadingSavedResults, setIsLoadingSavedResults] = useState(false);
  const [deletingSavedResultQuizId, setDeletingSavedResultQuizId] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const loadSavedQuizzes = useCallback(async function loadSavedQuizzes() {
    setIsLoadingSavedQuizzes(true);
    setErrorMessage('');

    try {
      await syncSavedQuizLibrary();
      const libraryData = await fetchSavedQuizLibrary();
      const allQuizzes = libraryData.savedQuizzes || [];
      const quizzes = allQuizzes.filter(isOriginalSavedQuizTemplate);

      setAllSavedQuizzes(allQuizzes);
      setSavedQuizzes(quizzes);
      setSelectedSavedQuizId((currentId) =>
        quizzes.some((quiz) => quiz.id === currentId)
          ? currentId
          : quizzes[0]?.id || ''
      );
      setSelectedCopiedQuizId((currentId) =>
        allQuizzes.some((quiz) => quiz.id === currentId) ? currentId : ''
      );
    } catch (error) {
      console.error('Load saved quizzes error:', error);
      setAllSavedQuizzes([]);
      setSavedQuizzes([]);
      setSelectedSavedQuizId('');
      setSelectedCopiedQuizId('');
      setErrorMessage(error?.message || 'Unable to load saved quizzes.');
    } finally {
      setIsLoadingSavedQuizzes(false);
    }
  }, []);

  const loadSavedResultQuizzes = useCallback(async function loadSavedResultQuizzes() {
    setIsLoadingSavedResults(true);
    setErrorMessage('');

    try {
      const userId = await getCurrentUserId();
      const { data, error } = await supabase
        .from('quiz_templates')
        .select('id, course_name, quiz_title, class_date, passing_score, quiz_duration_minutes, is_active, results_saved, created_at')
        .eq('owner_user_id', userId)
        .eq('results_saved', true)
        .order('created_at', { ascending: false });

      if (error) throw error;

      setSavedResultQuizzes(data || []);
    } catch (error) {
      console.error('Load saved quiz results error:', error);
      setErrorMessage(error?.message || 'Unable to load saved quiz results.');
    } finally {
      setIsLoadingSavedResults(false);
    }
  }, []);

  async function deleteSavedQuizResult(quiz) {
    const quizLabel = `${quiz.course_name || 'Untitled Course'} - ${
      quiz.quiz_title || 'Untitled Quiz'
    }`;
    const confirmed = window.confirm(
      `Remove ${quizLabel} from Saved Quiz Results? This will not delete student answers.`
    );

    if (!confirmed) return;

    setDeletingSavedResultQuizId(quiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      const userId = await getCurrentUserId();
      const { error } = await supabase
        .from('quiz_templates')
        .update({ results_saved: false })
        .eq('id', quiz.id)
        .eq('owner_user_id', userId)
        .eq('results_saved', true);

      if (error) throw error;

      setSavedResultQuizzes((currentQuizzes) =>
        currentQuizzes.filter((savedQuiz) => savedQuiz.id !== quiz.id)
      );
      setStatusMessage('Saved quiz result removed.');
    } catch (error) {
      console.error('Delete saved quiz result error:', error);
      setErrorMessage(error?.message || 'Unable to delete saved quiz result.');
    } finally {
      setDeletingSavedResultQuizId('');
    }
  }

  async function deleteSelectedCopiedQuiz() {
    const selectedQuiz = allSavedQuizzes.find(
      (quiz) => quiz.id === selectedCopiedQuizId
    );

    if (!selectedQuiz) {
      setErrorMessage('Choose a saved quiz to delete.');
      return;
    }

    const quizLabel = getSavedQuizOptionLabel(selectedQuiz);
    const confirmed = window.confirm(
      `Delete ${quizLabel}? This will permanently delete this saved quiz.`
    );

    if (!confirmed) return;

    setDeletingCopiedQuizId(selectedQuiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      const userId = await getCurrentUserId();
      let { error } = await supabase
        .from('quiz_templates')
        .delete()
        .eq('id', selectedQuiz.id)
        .eq('owner_user_id', userId)
        .eq('is_saved_template', true);

      if (isMissingSavedTemplateColumn(error)) {
        const fallbackResponse = await supabase
          .from('quiz_templates')
          .delete()
          .eq('id', selectedQuiz.id)
          .eq('owner_user_id', userId)
          .eq('is_active', false)
          .eq('results_saved', false);

        error = fallbackResponse.error;
      }

      if (error) throw error;

      const nextAllSavedQuizzes = allSavedQuizzes.filter(
        (quiz) => quiz.id !== selectedQuiz.id
      );
      const nextSavedQuizzes = nextAllSavedQuizzes.filter(
        isOriginalSavedQuizTemplate
      );

      setAllSavedQuizzes(nextAllSavedQuizzes);
      setSavedQuizzes(nextSavedQuizzes);
      setSelectedSavedQuizId((currentId) =>
        nextSavedQuizzes.some((quiz) => quiz.id === currentId)
          ? currentId
          : nextSavedQuizzes[0]?.id || ''
      );
      setSelectedCopiedQuizId('');
      setStatusMessage('Saved quiz deleted.');
    } catch (error) {
      console.error('Delete copied quiz error:', error);
      setErrorMessage(error?.message || 'Unable to delete saved quiz.');
    } finally {
      setDeletingCopiedQuizId('');
    }
  }

  const refreshQuizPage = useCallback(function refreshQuizPage() {
    loadSavedQuizzes();
    loadSavedResultQuizzes();
  }, [loadSavedQuizzes, loadSavedResultQuizzes]);

  useEffect(() => {
    Promise.resolve().then(() => {
      refreshQuizPage();
    });
  }, [refreshQuizPage]);

  return (
    <section className="quiz-page">
      <div className="quiz-card">
        <div className="quiz-header">
          <p className="eyebrow">Instructor Quizzes</p>
          <h1>Quizzes</h1>
          <p>Review saved quiz results or create a new quiz session.</p>
        </div>

        <div className="quiz-nav-row quizzes-nav-row">
          <Link to="/create-quiz-7392" className="primary-button link-button">
            Create Quiz
          </Link>
          <button
            type="button"
            className="secondary-button"
            onClick={refreshQuizPage}
            disabled={isLoadingSavedQuizzes || isLoadingSavedResults}
          >
            {isLoadingSavedQuizzes || isLoadingSavedResults
              ? 'Refreshing...'
              : 'Refresh'}
          </button>
        </div>

        {errorMessage && (
          <div className="alert alert-error" role="alert">
            {errorMessage}
          </div>
        )}

        {statusMessage && (
          <div className="alert alert-success" role="status">
            {statusMessage}
          </div>
        )}

        <section className="active-quiz-panel saved-quizzes-panel">
          <div className="quiz-section-header">
            <div>
              <h2>Saved Quizzes</h2>
              <p>Edit saved quiz questions and answers.</p>
            </div>
          </div>

          {isLoadingSavedQuizzes ? (
            <p className="muted">Loading saved quizzes...</p>
          ) : savedQuizzes.length === 0 ? (
            <p className="muted">No saved quizzes found.</p>
          ) : (
            <>
              <div className="saved-quiz-edit-row">
                <select
                  value={selectedSavedQuizId}
                  onChange={(event) => setSelectedSavedQuizId(event.target.value)}
                  aria-label="Saved quizzes"
                >
                  {savedQuizzes.map((quiz) => (
                    <option key={quiz.id} value={quiz.id}>
                      {getSavedQuizOptionLabel(quiz)}
                    </option>
                  ))}
                </select>

                <Link
                  className="primary-button link-button saved-quiz-edit-button"
                  to={`/create-quiz-7392?editQuizId=${selectedSavedQuizId}`}
                >
                  Edit Quiz
                </Link>
              </div>
            </>
          )}

          {!isLoadingSavedQuizzes && allSavedQuizzes.length > 0 && (
            <div className="saved-quiz-delete-row">
              <select
                value={selectedCopiedQuizId}
                onChange={(event) => setSelectedCopiedQuizId(event.target.value)}
                aria-label="Saved quizzes to delete"
              >
                <option value="">Select quiz</option>
                {allSavedQuizzes.map((quiz) => (
                  <option key={quiz.id} value={quiz.id}>
                    {getSavedQuizOptionLabel(quiz)}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="quiz-danger-button saved-quiz-delete-action"
                onClick={deleteSelectedCopiedQuiz}
                disabled={
                  !selectedCopiedQuizId ||
                  deletingCopiedQuizId === selectedCopiedQuizId
                }
              >
                {selectedCopiedQuizId &&
                deletingCopiedQuizId === selectedCopiedQuizId
                  ? 'Deleting...'
                  : 'Delete Quiz'}
              </button>
            </div>
          )}
        </section>

        <section className="active-quiz-panel saved-results-panel">
          <div className="quiz-section-header">
            <div>
              <h2>Saved Quiz Results</h2>
              <p>Quizzes saved for results review.</p>
            </div>
          </div>

          {isLoadingSavedResults ? (
            <p className="muted">Loading saved quiz results...</p>
          ) : savedResultQuizzes.length === 0 ? (
            <p className="muted">No saved quiz results.</p>
          ) : (
            <div className="active-quiz-list">
              {savedResultQuizzes.map((quiz) => (
                <div className="active-quiz-row saved-result-row" key={quiz.id}>
                  <div>
                    <strong>
                      {quiz.course_name || 'Untitled Course'} -{' '}
                      {quiz.quiz_title || 'Untitled Quiz'}
                    </strong>
                    <div className="active-quiz-meta">
                      <span>{formatDate(quiz.class_date)}</span>
                      <span>Passing: {quiz.passing_score}%</span>
                      <span>Time: {formatDuration(quiz.quiz_duration_minutes || 30)}</span>
                    </div>
                  </div>
                  <div className="active-quiz-actions">
                    <Link
                      className="secondary-link-button compact-link-button"
                      to={`/quiz-results-7392?quizId=${quiz.id}`}
                    >
                      View Results
                    </Link>
                    <button
                      type="button"
                      className="quiz-delete-icon-button"
                      aria-label={`Delete saved result for ${
                        quiz.course_name || 'Untitled Course'
                      } - ${quiz.quiz_title || 'Untitled Quiz'}`}
                      title="Delete saved result"
                      onClick={() => deleteSavedQuizResult(quiz)}
                      disabled={deletingSavedResultQuizId === quiz.id}
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
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
