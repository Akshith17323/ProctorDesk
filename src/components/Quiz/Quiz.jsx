// Quiz.jsx
import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '../../api';
import './Quiz.css';

const QUESTION_LOAD_TIMEOUT_MS = 15000;

function formatTime(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds === '') return '00:00';
  const sec = typeof totalSeconds === 'number' ? totalSeconds : parseInt(totalSeconds, 10);
  if (isNaN(sec)) return '00:00';
  const mins = Math.floor(sec / 60);
  const remainingSecs = sec % 60;
  return `${String(mins).padStart(2, '0')}:${String(remainingSecs).padStart(2, '0')}`;
}

export default function Quiz({ sessionId, timer, violationCount = 0, restoredAnswers, onFinish }) {
  const [questions, setQuestions] = useState([]);
  const [questionLoadState, setQuestionLoadState] = useState({ status: 'loading', message: '' });
  const [questionLoadAttempt, setQuestionLoadAttempt] = useState(0);
  const [answers, setAnswers] = useState(restoredAnswers || {});
  const [reviewed, setReviewed] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingQuestionIds, setPendingQuestionIds] = useState(() => new Set());
  const [showPalette, setShowPalette] = useState(false);
  const [showConfirmSubmit, setShowConfirmSubmit] = useState(false);
  const pendingQuestionIdsRef = useRef(new Set());
  const isSubmittingRef = useRef(false);

  // Fetch questions
  useEffect(() => {
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      cancelled = true;
      setQuestionLoadState({
        status: 'error',
        message: 'Loading questions timed out. Please check your connection and try again, or contact your proctor.'
      });
    }, QUESTION_LOAD_TIMEOUT_MS);

    async function loadQuestions() {
      try {
        const res = await apiFetch('/exam/mcq');
        if (!res.ok) throw new Error(`Question request failed with status ${res.status}`);

        const data = await res.json();
        if (!Array.isArray(data) || data.some(question => (
          !question
          || !Number.isInteger(question.id)
          || typeof question.question !== 'string'
          || !Array.isArray(question.options)
          || question.options.length === 0
          || question.options.some(option => typeof option !== 'string')
        ))) {
          throw new Error('Invalid question response');
        }

        if (cancelled) return;
        if (data.length === 0) {
          setQuestionLoadState({
            status: 'error',
            message: 'No questions are available for this quiz. Please try again or contact your proctor.'
          });
          return;
        }

        setQuestions(data);
        setQuestionLoadState({ status: 'ready', message: '' });
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to fetch questions:", err);
        setQuestionLoadState({
          status: 'error',
          message: 'Please check your connection and try again. If the problem continues, contact your proctor.'
        });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    loadQuestions();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [questionLoadAttempt]);

  function retryQuestions() {
    setQuestionLoadState({ status: 'loading', message: '' });
    setQuestionLoadAttempt(attempt => attempt + 1);
  }

  function markQuestionPending(questionId, isPending) {
    if (isPending) {
      pendingQuestionIdsRef.current.add(questionId);
    } else {
      pendingQuestionIdsRef.current.delete(questionId);
    }
    setPendingQuestionIds(new Set(pendingQuestionIdsRef.current));
  }

  function restoreAnswer(questionId, previousAnswer) {
    setAnswers(prev => {
      const nextAnswers = { ...prev };
      if (previousAnswer === undefined) {
        delete nextAnswers[questionId];
      } else {
        nextAnswers[questionId] = previousAnswer;
      }
      return nextAnswers;
    });
  }

  async function responseData(response) {
    try {
      return await response.json();
    } catch {
      return { message: `Request failed with status ${response.status}` };
    }
  }

  async function handleAnswerSelect(questionId, selectedAnswerIndex) {
    if (isSubmittingRef.current || pendingQuestionIdsRef.current.has(questionId)) return;

    const previousAnswer = answers[questionId];
    markQuestionPending(questionId, true);
    setAnswers(prev => ({ ...prev, [questionId]: selectedAnswerIndex }));

    try {
      const res = await apiFetch('/exam/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          questionId: questionId,
          selectedAnswer: selectedAnswerIndex
        })
      });
      const data = await responseData(res);
      if (!res.ok) {
        console.error("Failed to submit answer:", data.message);
        alert(data.message);
        restoreAnswer(questionId, previousAnswer);
      }
    } catch (err) {
      console.error("Network error submitting answer:", err);
      alert("Could not save the answer. Please check the backend connection and try again.");
      restoreAnswer(questionId, previousAnswer);
    } finally {
      markQuestionPending(questionId, false);
    }
  }

  async function handleClearSelection(questionId) {
    if (isSubmittingRef.current || pendingQuestionIdsRef.current.has(questionId)) return;

    const previousAnswer = answers[questionId];
    if (previousAnswer === undefined) return;

    markQuestionPending(questionId, true);
    restoreAnswer(questionId, undefined);

    try {
      const res = await apiFetch('/exam/answer/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId })
      });
      const data = await responseData(res);
      if (!res.ok) {
        console.error("Failed to clear answer:", data.message);
        alert(data.message);
        restoreAnswer(questionId, previousAnswer);
      }
    } catch (err) {
      console.error("Network error clearing answer:", err);
      alert("Could not clear the answer. Please check the backend connection and try again.");
      restoreAnswer(questionId, previousAnswer);
    } finally {
      markQuestionPending(questionId, false);
    }
  }

  function toggleMarkForReview(questionId) {
    setReviewed(prev => ({
      ...prev,
      [questionId]: !prev[questionId]
    }));
  }

  async function submitExamOnBackend() {
    if (isSubmittingRef.current) return;
    if (pendingQuestionIdsRef.current.size > 0) {
      alert("Please wait for the current answer to finish saving.");
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/exam/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      const data = await responseData(res);
      if (res.ok) {
        onFinish(data.result);
      } else {
        alert("Failed to submit exam: " + data.message);
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    } catch (err) {
      console.error("Failed to submit exam:", err);
      alert("Could not submit the exam. Please check the backend connection and try again.");
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (questionLoadState.status !== 'ready') {
    const isLoading = questionLoadState.status === 'loading';

    return (
      <main className="quiz-load-state" aria-busy={isLoading}>
        <div className="quiz-load-card">
          {isLoading ? (
            <p className="quiz-load-message" role="status">Loading assessment questions...</p>
          ) : (
            <>
              <div role="alert">
                <h2 className="quiz-load-title">Unable to load questions</h2>
                <p className="quiz-load-message">{questionLoadState.message}</p>
              </div>
              <button type="button" className="submit-quiz-btn quiz-retry-btn" onClick={retryQuestions}>
                Retry
              </button>
            </>
          )}
        </div>
      </main>
    );
  }

  const currentQuestion = questions[currentIndex];
  const selectedOptIndex = answers[currentQuestion.id];
  const isMarkedForReview = !!reviewed[currentQuestion.id];
  const currentQuestionPending = pendingQuestionIds.has(currentQuestion.id);
  const hasPendingAnswers = pendingQuestionIds.size > 0;

  const totalAnswered = Object.keys(answers).length;
  const totalReviewed = Object.values(reviewed).filter(Boolean).length;
  const totalQuestions = questions.length;

  return (
    <div className="quiz-page">
      {/* Top Header */}
      <header className="quiz-header">
        <div className="quiz-title">
          Gated Architectures, LSTM, GRU
        </div>

        <div className="quiz-header-right">
          {violationCount > 0 && (
            <div className="quiz-warning-badge">
              Warnings: {violationCount}
            </div>
          )}

          <div className="quiz-timer-badge">
            <svg className="quiz-timer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            <span>{formatTime(timer)}</span>
          </div>

          <button
            className="submit-quiz-btn"
            onClick={() => setShowConfirmSubmit(true)}
            disabled={isSubmitting || hasPendingAnswers}
          >
            {hasPendingAnswers ? 'Saving...' : 'Finish Exam'}
          </button>
        </div>
      </header>

      {/* Main Question Area */}
      <main className="quiz-body">
        <div className="question-subbar">
          <div className="question-counter">
            Question {currentIndex + 1} of {totalQuestions}
          </div>

          <div className="question-actions">
            <button
              className={`btn-review ${isMarkedForReview ? 'active' : ''}`}
              onClick={() => toggleMarkForReview(currentQuestion.id)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill={isMarkedForReview ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
                <line x1="4" y1="22" x2="4" y2="15"></line>
              </svg>
              <span>{isMarkedForReview ? 'Flagged for review' : 'Flag for review'}</span>
            </button>

            <button
              className="btn-clear"
              disabled={selectedOptIndex === undefined || currentQuestionPending || isSubmitting}
              onClick={() => handleClearSelection(currentQuestion.id)}
            >
              {currentQuestionPending ? 'Saving...' : 'Clear choice'}
            </button>

            <button className="btn-feedback" title="Report issue" onClick={() => alert("Feedback logged for this question.")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </button>
          </div>
        </div>

        <h2 className="question-title">
          {currentQuestion.question}
        </h2>

        {/* Options List */}
        <div className="options-stack">
          {currentQuestion.options.map((optionText, optIdx) => {
            const isSelected = selectedOptIndex === optIdx;
            const letter = String.fromCharCode(65 + optIdx);

            return (
              <div
                key={optIdx}
                className={`option-card ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  if (!currentQuestionPending && !isSubmitting) {
                    handleAnswerSelect(currentQuestion.id, optIdx);
                  }
                }}
                role="radio"
                aria-checked={isSelected}
                aria-disabled={currentQuestionPending || isSubmitting}
              >
                <span className="option-letter">{letter}</span>
                <span className="option-text">{optionText}</span>
              </div>
            );
          })}
        </div>
      </main>

      {/* Questions Palette Popover */}
      {showPalette && (
        <div className="palette-popover">
          <div className="palette-header">
            <span className="palette-title">Question Navigator</span>
            <button className="palette-close-btn" onClick={() => setShowPalette(false)}>×</button>
          </div>
          <div className="palette-legend">
            <span className="palette-legend-item">
              <span className="palette-legend-dot answered"></span> Answered
            </span>
            <span className="palette-legend-item">
              <span className="palette-legend-dot reviewed"></span> Flagged
            </span>
            <span className="palette-legend-item">
              <span className="palette-legend-dot unvisited"></span> Unvisited
            </span>
          </div>
          <div className="palette-grid">
            {questions.map((q, idx) => {
              const isAnswered = answers[q.id] !== undefined;
              const isRev = !!reviewed[q.id];
              const isCurr = idx === currentIndex;

              let itemClass = 'palette-item';
              if (isAnswered) itemClass += ' answered';
              if (isRev) itemClass += ' reviewed';
              if (isCurr) itemClass += ' current';

              return (
                <div
                  key={q.id}
                  className={itemClass}
                  onClick={() => {
                    setCurrentIndex(idx);
                    setShowPalette(false);
                  }}
                >
                  {idx + 1}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom Navigation Bar */}
      <footer className="quiz-bottom-bar">
        <button
          className="btn-nav-prev"
          disabled={currentIndex === 0}
          onClick={() => setCurrentIndex(c => Math.max(0, c - 1))}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <span>Previous</span>
        </button>

        <button
          className="btn-grid-palette"
          title="Toggle question navigator"
          onClick={() => setShowPalette(p => !p)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
        </button>

        {currentIndex < totalQuestions - 1 ? (
          <button
            className="btn-nav-next"
            onClick={() => setCurrentIndex(c => Math.min(totalQuestions - 1, c + 1))}
          >
            <span>Next</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        ) : (
          <button
            className="btn-nav-next"
            onClick={() => setShowConfirmSubmit(true)}
            disabled={isSubmitting || hasPendingAnswers}
          >
            <span>{hasPendingAnswers ? 'Saving...' : 'Finish Exam'}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
        )}
      </footer>

      {/* Submit Confirmation Modal */}
      {showConfirmSubmit && (
        <div className="modal-overlay">
          <div className="confirm-modal-box">
            <h3 className="confirm-modal-title">Submit Examination?</h3>
            <p className="confirm-modal-desc">
              Are you sure you want to finalize and submit your test? Once submitted, your answers cannot be modified.
            </p>

            <div className="confirm-stat-grid">
              <div className="confirm-stat-card">
                <div className="confirm-stat-val">{totalAnswered}</div>
                <div className="confirm-stat-label">Answered</div>
              </div>
              <div className="confirm-stat-card">
                <div className="confirm-stat-val">{totalReviewed}</div>
                <div className="confirm-stat-label">Flagged</div>
              </div>
              <div className="confirm-stat-card">
                <div className="confirm-stat-val">{totalQuestions - totalAnswered}</div>
                <div className="confirm-stat-label">Remaining</div>
              </div>
            </div>

            <div className="confirm-modal-actions">
              <button
                className="btn btn-outline"
                onClick={() => setShowConfirmSubmit(false)}
                disabled={isSubmitting}
              >
                Continue test
              </button>
              <button
                className="btn btn-primary"
                onClick={submitExamOnBackend}
                disabled={isSubmitting || hasPendingAnswers}
              >
                {isSubmitting ? 'Submitting...' : hasPendingAnswers ? 'Saving...' : 'Submit exam'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
