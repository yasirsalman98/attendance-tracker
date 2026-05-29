import { useEffect, useState } from 'react';
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

export default function Quizzes() {
  const [savedResultQuizzes, setSavedResultQuizzes] = useState([]);
  const [isLoadingSavedResults, setIsLoadingSavedResults] = useState(false);
  const [deletingSavedResultQuizId, setDeletingSavedResultQuizId] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  async function loadSavedResultQuizzes() {
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
  }

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
      const { error } = await supabase
        .from('quiz_templates')
        .update({ results_saved: false })
        .eq('id', quiz.id);

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

  useEffect(() => {
    loadSavedResultQuizzes();
  }, []);

  return (
    <section className="quiz-page">
      <div className="quiz-card">
        <div className="quiz-header">
          <p className="eyebrow">Instructor Quizzes</p>
          <h1>Quizzes</h1>
          <p>Review saved quiz results or create a new quiz session.</p>
        </div>

        <div className="quiz-nav-row">
          <Link to="/create-quiz-7392" className="primary-button link-button">
            Create Quiz
          </Link>
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

        <section className="active-quiz-panel saved-results-panel">
          <div className="quiz-section-header">
            <div>
              <h2>Saved Quiz Results</h2>
              <p>Quizzes saved for results review.</p>
            </div>
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={loadSavedResultQuizzes}
              disabled={isLoadingSavedResults}
            >
              {isLoadingSavedResults ? 'Refreshing...' : 'Refresh'}
            </button>
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
                      <span>{quiz.is_active ? 'Active' : 'Canceled'}</span>
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
