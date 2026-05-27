import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import { supabase } from '../supabaseClient';
import './Quiz.css';

function getTodayDateValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const localDate = new Date(now.getTime() - offset * 60 * 1000);
  return localDate.toISOString().split('T')[0];
}

function createChoice(text = '') {
  return {
    id: crypto.randomUUID(),
    choiceText: text,
    isCorrect: false,
  };
}

function createQuestion() {
  return {
    id: crypto.randomUUID(),
    questionText: '',
    questionType: 'single_choice',
    choices: [createChoice(), createChoice()],
  };
}

function normalizeQuestionType(questionType) {
  return questionType === 'multiple_choice' ? 'multiple_choice' : 'single_choice';
}

function mapSavedQuizQuestions(savedQuiz) {
  return [...(savedQuiz.quiz_questions || [])]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((question) => ({
      id: crypto.randomUUID(),
      questionText: question.question_text || '',
      questionType: normalizeQuestionType(question.question_type),
      choices: [...(question.quiz_answer_choices || [])]
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((choice) => ({
          id: crypto.randomUUID(),
          choiceText: choice.choice_text || '',
          isCorrect: Boolean(choice.is_correct),
        })),
    }));
}

export default function CreateQuiz() {
  const qrCodeRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [courseName, setCourseName] = useState('');
  const [quizTitle, setQuizTitle] = useState('');
  const [quizDescription, setQuizDescription] = useState('');
  const [instructorName, setInstructorName] = useState('');
  const [classDate, setClassDate] = useState(getTodayDateValue());
  const [passingScore, setPassingScore] = useState(80);
  const [questions, setQuestions] = useState([createQuestion()]);
  const [createdQuiz, setCreatedQuiz] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedQuizzes, setSavedQuizzes] = useState([]);
  const [selectedSavedQuizId, setSelectedSavedQuizId] = useState('');
  const [showLoadQuizPanel, setShowLoadQuizPanel] = useState(false);
  const [isLoadingSavedQuizzes, setIsLoadingSavedQuizzes] = useState(false);
  const [isLoadingQuizQuestions, setIsLoadingQuizQuestions] = useState(false);
  const quizIdFromUrl = searchParams.get('quizId') || '';

  const studentQuizLink = useMemo(() => {
    if (!createdQuiz?.id) return '';

    return `${window.location.origin}/quiz/${createdQuiz.id}`;
  }, [createdQuiz]);

  useEffect(() => {
    let isActive = true;

    async function loadCreatedQuiz() {
      if (!quizIdFromUrl) return;

      setErrorMessage('');
      setStatusMessage('Loading saved quiz...');

      const { data, error } = await supabase
        .from('quiz_templates')
        .select('*')
        .eq('id', quizIdFromUrl)
        .maybeSingle();

      if (!isActive) return;

      if (error || !data) {
        console.error('Load created quiz error:', error);
        setCreatedQuiz(null);
        setStatusMessage('');
        setErrorMessage('Unable to load that saved quiz.');
      } else {
        setCreatedQuiz(data);
        setCopied(false);
        setStatusMessage('Quiz loaded.');
      }
    }

    loadCreatedQuiz();

    return () => {
      isActive = false;
    };
  }, [quizIdFromUrl]);

  useEffect(() => {
    if (!createdQuiz) return;

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [createdQuiz]);

  function updateQuestion(questionId, updates) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) =>
        question.id === questionId ? { ...question, ...updates } : question
      )
    );
  }

  function updateQuestionType(questionId, questionType) {
    const nextType = normalizeQuestionType(questionType);

    setQuestions((currentQuestions) =>
      currentQuestions.map((question) => {
        if (question.id !== questionId) return question;

        if (nextType === 'multiple_choice') {
          return { ...question, questionType: nextType };
        }

        let hasCorrectChoice = false;
        const choices = question.choices.map((choice) => {
          if (choice.isCorrect && !hasCorrectChoice) {
            hasCorrectChoice = true;
            return choice;
          }

          return { ...choice, isCorrect: false };
        });

        return { ...question, questionType: nextType, choices };
      })
    );
  }

  function updateChoice(questionId, choiceId, updates) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) => {
        if (question.id !== questionId) return question;

        const choices = question.choices.map((choice) =>
          choice.id === choiceId ? { ...choice, ...updates } : choice
        );

        return { ...question, choices };
      })
    );
  }

  function toggleCorrectChoice(questionId, choiceId) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) => {
        if (question.id !== questionId) return question;

        const choices = question.choices.map((choice) => {
          if (question.questionType === 'single_choice') {
            return { ...choice, isCorrect: choice.id === choiceId };
          }

          if (choice.id === choiceId) {
            return { ...choice, isCorrect: !choice.isCorrect };
          }

          return choice;
        });

        return { ...question, choices };
      })
    );
  }

  function addQuestion() {
    setQuestions((currentQuestions) => [...currentQuestions, createQuestion()]);
  }

  function removeQuestion(questionId) {
    setQuestions((currentQuestions) =>
      currentQuestions.length === 1
        ? currentQuestions
        : currentQuestions.filter((question) => question.id !== questionId)
    );
  }

  function addChoice(questionId) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) =>
        question.id === questionId
          ? { ...question, choices: [...question.choices, createChoice()] }
          : question
      )
    );
  }

  function removeChoice(questionId, choiceId) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) => {
        if (question.id !== questionId || question.choices.length <= 2) {
          return question;
        }

        return {
          ...question,
          choices: question.choices.filter((choice) => choice.id !== choiceId),
        };
      })
    );
  }

  function validateQuiz() {
    if (!courseName.trim()) return 'Course name is required.';
    if (!quizTitle.trim()) return 'Quiz title is required.';
    if (!Number.isFinite(Number(passingScore))) return 'Passing score is required.';
    if (Number(passingScore) < 0 || Number(passingScore) > 100) {
      return 'Passing score must be between 0 and 100.';
    }

    for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
      const question = questions[questionIndex];
      const questionNumber = questionIndex + 1;

      if (!question.questionText.trim()) {
        return `Question ${questionNumber} needs question text.`;
      }

      if (question.choices.length < 2) {
        return `Question ${questionNumber} needs at least 2 answer choices.`;
      }

      for (let choiceIndex = 0; choiceIndex < question.choices.length; choiceIndex += 1) {
        if (!question.choices[choiceIndex].choiceText.trim()) {
          return `Question ${questionNumber} has an empty answer choice.`;
        }
      }

      const correctCount = question.choices.filter((choice) => choice.isCorrect).length;

      if (correctCount === 0) {
        return `Question ${questionNumber} needs at least one correct answer.`;
      }

      if (question.questionType === 'single_choice' && correctCount !== 1) {
        return `Question ${questionNumber} can only have one correct answer.`;
      }
    }

    return '';
  }

  async function loadSavedQuizzes() {
    setShowLoadQuizPanel(true);
    setErrorMessage('');
    setStatusMessage('Loading saved quizzes...');
    setIsLoadingSavedQuizzes(true);

    const { data, error } = await supabase
      .from('quiz_templates')
      .select('id, course_name, quiz_title, class_date, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Load saved quizzes error:', error);
      setSavedQuizzes([]);
      setSelectedSavedQuizId('');
      setStatusMessage('');
      setErrorMessage(error.message || 'Unable to load saved quizzes.');
    } else {
      const quizzes = data || [];
      setSavedQuizzes(quizzes);
      setSelectedSavedQuizId((currentId) =>
        quizzes.some((quiz) => quiz.id === currentId)
          ? currentId
          : quizzes[0]?.id || ''
      );
      setStatusMessage(quizzes.length ? '' : 'No saved quizzes found yet.');
    }

    setIsLoadingSavedQuizzes(false);
  }

  async function loadSelectedQuizQuestions() {
    if (!selectedSavedQuizId) {
      setErrorMessage('Choose a saved quiz to load.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('Loading quiz questions...');
    setIsLoadingQuizQuestions(true);

    const { data, error } = await supabase
      .from('quiz_templates')
      .select(`
        *,
        quiz_questions (
          id,
          question_text,
          question_type,
          sort_order,
          quiz_answer_choices (
            id,
            choice_text,
            is_correct,
            sort_order
          )
        )
      `)
      .eq('id', selectedSavedQuizId)
      .maybeSingle();

    if (error || !data) {
      console.error('Load selected quiz questions error:', error);
      setStatusMessage('');
      setErrorMessage('Unable to load that saved quiz.');
    } else {
      const loadedQuestions = mapSavedQuizQuestions(data);

      setCourseName(data.course_name || '');
      setQuizTitle(data.quiz_title ? `${data.quiz_title} Copy` : '');
      setQuizDescription(data.quiz_description || '');
      setInstructorName(data.instructor_name || '');
      setClassDate(data.class_date || getTodayDateValue());
      setPassingScore(data.passing_score ?? 80);
      setQuestions(loadedQuestions.length ? loadedQuestions : [createQuestion()]);
      setCreatedQuiz(null);
      setCopied(false);
      setSearchParams({});
      setStatusMessage('Saved quiz questions loaded. Review them, then save to create a new quiz link.');
    }

    setIsLoadingQuizQuestions(false);
  }

  function clearLoadedQuizQuestions() {
    const confirmed = window.confirm(
      'Clear the loaded quiz questions and start a blank quiz draft? This will not delete any saved quizzes.'
    );

    if (!confirmed) return;

    setCourseName('');
    setQuizTitle('');
    setQuizDescription('');
    setInstructorName('');
    setClassDate(getTodayDateValue());
    setPassingScore(80);
    setQuestions([createQuestion()]);
    setCreatedQuiz(null);
    setCopied(false);
    setSearchParams({});
    setErrorMessage('');
    setStatusMessage('Loaded questions cleared. You can start a new quiz draft.');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setCreatedQuiz(null);
    setCopied(false);
    setStatusMessage('');

    const validationMessage = validateQuiz();

    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    setErrorMessage('');
    setIsSaving(true);

    try {
      const { data: quizTemplate, error: quizError } = await supabase
        .from('quiz_templates')
        .insert({
          course_name: courseName.trim(),
          quiz_title: quizTitle.trim(),
          quiz_description: quizDescription.trim() || null,
          instructor_name: instructorName.trim() || null,
          class_date: classDate || null,
          passing_score: Number(passingScore),
        })
        .select()
        .single();

      if (quizError) throw quizError;

      for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
        const question = questions[questionIndex];
        const { data: savedQuestion, error: questionError } = await supabase
          .from('quiz_questions')
          .insert({
            quiz_template_id: quizTemplate.id,
            question_text: question.questionText.trim(),
            question_type: normalizeQuestionType(question.questionType),
            sort_order: questionIndex,
          })
          .select()
          .single();

        if (questionError) throw questionError;

        const choicesToInsert = question.choices.map((choice, choiceIndex) => ({
          question_id: savedQuestion.id,
          choice_text: choice.choiceText.trim(),
          is_correct: choice.isCorrect,
          sort_order: choiceIndex,
        }));

        const { error: choicesError } = await supabase
          .from('quiz_answer_choices')
          .insert(choicesToInsert);

        if (choicesError) throw choicesError;
      }

      setCreatedQuiz(quizTemplate);
      setSearchParams({ quizId: quizTemplate.id });
      setStatusMessage('Quiz created successfully.');
    } catch (error) {
      console.error('Create quiz error:', error);
      setErrorMessage(error?.message || 'Unable to create the quiz.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCopyLink() {
    if (!studentQuizLink) return;

    try {
      await navigator.clipboard.writeText(studentQuizLink);
      setCopied(true);
    } catch (error) {
      console.error('Copy quiz link error:', error);
      setErrorMessage('The quiz was created, but the link could not be copied.');
    }
  }

  function handleDownloadQrCode() {
    const canvas = qrCodeRef.current?.querySelector('canvas');

    if (!canvas || !createdQuiz?.id) return;

    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `student-quiz-${createdQuiz.id}.png`;
    link.click();
  }

  return (
    <section className="quiz-page">
      <div className="quiz-card">
        <div className="quiz-header">
          <p className="eyebrow">Instructor Setup</p>
          <h1>Create Quiz</h1>
          <p>
            Build a simple quiz, mark the correct answers, and generate a
            student link with a QR code.
          </p>
        </div>

        <div className="quiz-nav-row">
          <Link to="/instructor-7392" className="secondary-link-button">
            Instructor Dashboard
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

        {!createdQuiz ? (
          <form className="quiz-form" onSubmit={handleSubmit}>
            <section className="load-quiz-panel">
              <div>
                <h2>Load Saved Quiz Questions</h2>
                <p>
                  Reuse questions from a saved quiz, then edit and save them as
                  a new quiz.
                </p>
              </div>

              {!showLoadQuizPanel ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={loadSavedQuizzes}
                  disabled={isLoadingSavedQuizzes}
                >
                  {isLoadingSavedQuizzes ? 'Loading...' : 'Load Saved Quiz Questions'}
                </button>
              ) : (
                <div className="load-quiz-row">
                  <select
                    value={selectedSavedQuizId}
                    onChange={(event) => setSelectedSavedQuizId(event.target.value)}
                    disabled={savedQuizzes.length === 0}
                    aria-label="Saved quizzes"
                  >
                    {savedQuizzes.length === 0 ? (
                      <option value="">No saved quizzes found</option>
                    ) : (
                      savedQuizzes.map((quiz) => (
                        <option key={quiz.id} value={quiz.id}>
                          {quiz.course_name} - {quiz.quiz_title}
                        </option>
                      ))
                    )}
                  </select>

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={loadSelectedQuizQuestions}
                    disabled={!selectedSavedQuizId || isLoadingQuizQuestions}
                  >
                    {isLoadingQuizQuestions ? 'Loading Questions...' : 'Load Questions'}
                  </button>

                  <button
                    type="button"
                    className="secondary-button clear-loaded-quiz-button"
                    onClick={clearLoadedQuizQuestions}
                  >
                    Clear Loaded Questions
                  </button>
                </div>
              )}
            </section>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="courseName">Course Name *</label>
                <input
                  id="courseName"
                  type="text"
                  value={courseName}
                  onChange={(event) => setCourseName(event.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="quizTitle">Quiz Title *</label>
                <input
                  id="quizTitle"
                  type="text"
                  value={quizTitle}
                  onChange={(event) => setQuizTitle(event.target.value)}
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="quizDescription">Quiz Description</label>
              <textarea
                id="quizDescription"
                value={quizDescription}
                onChange={(event) => setQuizDescription(event.target.value)}
                rows={4}
              />
            </div>

            <div className="form-row three-column-row">
              <div className="form-group">
                <label htmlFor="instructorName">Instructor Name</label>
                <input
                  id="instructorName"
                  type="text"
                  value={instructorName}
                  onChange={(event) => setInstructorName(event.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="classDate">Class Date</label>
                <input
                  id="classDate"
                  type="date"
                  value={classDate}
                  onChange={(event) => setClassDate(event.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="passingScore">Passing Score *</label>
                <input
                  id="passingScore"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={passingScore}
                  onChange={(event) => setPassingScore(event.target.value)}
                />
              </div>
            </div>

            <div className="quiz-builder-section">
              <div className="quiz-section-header">
                <h2>Questions</h2>
                <button type="button" className="secondary-button" onClick={addQuestion}>
                  Add Question
                </button>
              </div>

              <div className="question-list">
                {questions.map((question, questionIndex) => (
                  <section className="question-card" key={question.id}>
                    <div className="question-card-header">
                      <h3>Question {questionIndex + 1}</h3>
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        onClick={() => removeQuestion(question.id)}
                        disabled={questions.length === 1}
                      >
                        Remove
                      </button>
                    </div>

                    <div className="form-group">
                      <label htmlFor={`question-${question.id}`}>Question Text *</label>
                      <textarea
                        id={`question-${question.id}`}
                        value={question.questionText}
                        onChange={(event) =>
                          updateQuestion(question.id, {
                            questionText: event.target.value,
                          })
                        }
                        rows={3}
                      />
                    </div>

                    <fieldset className="choice-fieldset">
                      <legend>Question Type</legend>
                      <label className="inline-choice">
                        <input
                          type="radio"
                          name={`question-type-${question.id}`}
                          value="single_choice"
                          checked={question.questionType === 'single_choice'}
                          onChange={(event) =>
                            updateQuestionType(question.id, event.target.value)
                          }
                        />
                        Single answer
                      </label>
                      <label className="inline-choice">
                        <input
                          type="radio"
                          name={`question-type-${question.id}`}
                          value="multiple_choice"
                          checked={question.questionType === 'multiple_choice'}
                          onChange={(event) =>
                            updateQuestionType(question.id, event.target.value)
                          }
                        />
                        Multiple answers
                      </label>
                    </fieldset>

                    <div className="answer-choice-list">
                      {question.choices.map((choice, choiceIndex) => (
                        <div className="answer-choice-row" key={choice.id}>
                          <label className="correct-choice-control">
                            <input
                              type={
                                question.questionType === 'single_choice'
                                  ? 'radio'
                                  : 'checkbox'
                              }
                              name={`correct-choice-${question.id}`}
                              checked={choice.isCorrect}
                              onChange={() => toggleCorrectChoice(question.id, choice.id)}
                            />
                            Correct
                          </label>

                          <input
                            type="text"
                            value={choice.choiceText}
                            onChange={(event) =>
                              updateChoice(question.id, choice.id, {
                                choiceText: event.target.value,
                              })
                            }
                            placeholder={`Answer choice ${choiceIndex + 1}`}
                          />

                          <button
                            type="button"
                            className="secondary-button compact-button"
                            onClick={() => removeChoice(question.id, choice.id)}
                            disabled={question.choices.length <= 2}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      className="secondary-button compact-button"
                      onClick={() => addChoice(question.id)}
                    >
                      Add Answer Choice
                    </button>
                  </section>
                ))}
              </div>
            </div>

            <button className="primary-button" type="submit" disabled={isSaving}>
              {isSaving ? 'Saving Quiz...' : 'Save Quiz'}
            </button>
          </form>
        ) : (
          <section className="quiz-created">
            <div className="quiz-summary">
              <h2>Quiz Details</h2>
              <dl>
                <div>
                  <dt>Course</dt>
                  <dd>{createdQuiz.course_name}</dd>
                </div>
                <div>
                  <dt>Quiz</dt>
                  <dd>{createdQuiz.quiz_title}</dd>
                </div>
                <div>
                  <dt>Passing Score</dt>
                  <dd>{createdQuiz.passing_score}%</dd>
                </div>
              </dl>
            </div>

            <div className="student-link-box">
              <label htmlFor="studentQuizLink">Student Quiz Link</label>
              <div className="copy-row">
                <input id="studentQuizLink" type="text" value={studentQuizLink} readOnly />
                <button type="button" onClick={handleCopyLink}>
                  {copied ? 'Copied' : 'Copy Quiz Link'}
                </button>
              </div>
            </div>

            <div className="qr-code-box">
              <div className="qr-code-image" ref={qrCodeRef}>
                <QRCodeCanvas value={studentQuizLink} size={220} level="M" marginSize={4} />
              </div>
              <div className="qr-code-copy">
                <h2>Student QR Code</h2>
                <p>Students can scan this QR code to open the quiz.</p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleDownloadQrCode}
                >
                  Download QR Code
                </button>
              </div>
            </div>

            <div className="action-row">
              <a className="primary-button link-button" href={studentQuizLink}>
                Open Student Quiz
              </a>
              <Link
                className="secondary-link-button"
                to={`/quiz-results-7392?quizId=${createdQuiz.id}`}
              >
                View Quiz Results
              </Link>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
