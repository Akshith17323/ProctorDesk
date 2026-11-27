// App.jsx
import { useCallback, useEffect, useRef, useState } from 'react';
import Quiz from './components/Quiz/Quiz';
import { apiFetch } from './api';
import { captureCameraFrame, createSnapshotCaptureRunner } from './snapshots';
import './App.css';

function stopMediaStream(stream) {
  if (!stream) return;
  try {
    stream.getTracks().forEach(track => {
      try { track.stop(); } catch {}
    });
  } catch {}
}

function App() {
  // Candidate & Proctoring State
  const [studentName, setStudentName] = useState(() => localStorage.getItem('athena_studentName') || '');
  const [studentId, setStudentId] = useState(() => localStorage.getItem('athena_studentId') || '');
  const [isLoggedIn, setIsLoggedIn] = useState(() => !!localStorage.getItem('athena_studentName'));
  const [violationCount, setViolationCount] = useState(0);

  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [screenShared, setScreenShared] = useState(false);
  const [folderSelected, setFolderSelected] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);

  const [timer, setTimer] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [isStartingExam, setIsStartingExam] = useState(false);
  const candidateGenerationRef = useRef(0);
  const sessionIdRef = useRef(null);
  const isStartingExamRef = useRef(false);
  const quizStartedRef = useRef(false);
  const [runSnapshotCapture] = useState(() => createSnapshotCaptureRunner());
  const [snapshotErrors, setSnapshotErrors] = useState({});

  const [quizStarted, setQuizStarted] = useState(false);
  const [restoredAnswers, setRestoredAnswers] = useState({});
  const [examResults, setExamResults] = useState(null);

  // Modals & UI states
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const screenStreamRef = useRef(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    quizStartedRef.current = quizStarted;
  }, [sessionId, quizStarted]);

  // Clean up media tracks on unmount
  useEffect(() => {
    return () => {
      stopMediaStream(streamRef.current);
      stopMediaStream(screenStreamRef.current);
    };
  }, []);

  // Keep video stream alive across re-renders
  useEffect(() => {
    if (videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [quizStarted, showPermissionsModal]);

  // Restore session on load
  useEffect(() => {
    const candidateGeneration = candidateGenerationRef.current;
    const storedSessionId = localStorage.getItem('athena_sessionId');
    if (storedSessionId) {
      apiFetch(`/exam/session/${storedSessionId}`)
        .then(res => {
          if (!res.ok) throw new Error("Session not found");
          return res.json();
        })
        .then(data => {
          if (candidateGenerationRef.current !== candidateGeneration) return;

          if (data.name && data.userId) {
            setStudentName(data.name);
            setStudentId(data.userId);
            setIsLoggedIn(true);
            localStorage.setItem('athena_studentName', data.name);
            localStorage.setItem('athena_studentId', data.userId);
          }

          if (data.status === "in-progress") {
            setSessionId(storedSessionId);
            const newAnswers = {};
            data.answers.forEach(ans => {
              newAnswers[ans.questionId] = ans.selectedAnswer;
            });
            setRestoredAnswers(newAnswers);
          } else if (data.status === "submitted") {
            setExamResults({
              attempted: data.attempted,
              correct: data.correct,
              wrong: data.wrong
            });
          }
        })
        .catch(err => {
          if (candidateGenerationRef.current !== candidateGeneration) return;
          console.error("Failed to restore session:", err);
          localStorage.removeItem('athena_sessionId');
        });
    }
  }, []);

  // Anti-cheat: prevent right click
  useEffect(() => {
    const handleContextMenu = (e) => e.preventDefault();
    window.addEventListener('contextmenu', handleContextMenu);
    return () => window.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  // Automatically check if application is already full screen
  useEffect(() => {
    async function checkFullscreenStatus() {
      if (window.athena?.isFullScreen) {
        try {
          const isFs = await window.athena.isFullScreen();
          if (isFs) {
            setFullScreen(true);
          }
        } catch (err) {
          console.error("Error checking fullscreen:", err);
        }
      } else if (document.fullscreenElement || window.innerHeight >= screen.availHeight) {
        setFullScreen(true);
      }
    }
    checkFullscreenStatus();

    const removeElectronFsListener = window.athena?.registerListenerForFullscreenChange?.((isFs) => {
      setFullScreen(isFs);
      if (!isFs && quizStarted) {
        setViolationCount((c) => {
          const next = c + 1;
          alert(`Anti-Cheat Warning: Fullscreen mode was exited! (Violation #${next})`);
          return next;
        });
      }
    });

    const handleDomFsChange = () => {
      if (!document.fullscreenElement) {
        if (window.athena?.isFullScreen) {
          window.athena.isFullScreen().then(isFs => {
            setFullScreen(isFs);
            if (!isFs && quizStarted) {
              setViolationCount(c => c + 1);
            }
          });
        } else {
          setFullScreen(false);
        }
      } else {
        setFullScreen(true);
      }
    };

    document.addEventListener('fullscreenchange', handleDomFsChange);

    return () => {
      if (removeElectronFsListener) removeElectronFsListener();
      document.removeEventListener('fullscreenchange', handleDomFsChange);
    };
  }, [quizStarted]);

  const saveVideoScreenShots = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    const isActive = () => quizStartedRef.current && sessionIdRef.current === activeSessionId;
    if (!activeSessionId || !isActive()) return;

    const onSlowCapture = (kind) => () => {
      if (isActive()) {
        setSnapshotErrors(previous => ({ ...previous, [kind]: 'Capture is delayed. Check the capture folder or contact your proctor.' }));
      }
    };

    const screenCapture = runSnapshotCapture('screen', () => (
      window.athena?.captureScreen?.(activeSessionId)
    ), onSlowCapture('screen'));
    const cameraCapture = runSnapshotCapture('camera', async () => {
      const arrayBuffer = await captureCameraFrame(videoRef.current);
      if (!arrayBuffer || !isActive()) return null;
      return await window.athena?.storeCameraSnapImageOnDisk?.(arrayBuffer, activeSessionId);
    }, onSlowCapture('camera'));

    const [screenResult, cameraResult] = await Promise.allSettled([
      screenCapture,
      cameraCapture,
    ]);

    if (!isActive()) return;
    for (const [kind, result] of [['screen', screenResult], ['camera', cameraResult]]) {
      if (result.status === 'rejected') {
        console.error(`Failed to capture ${kind} image:`, result.reason);
        setSnapshotErrors(previous => ({ ...previous, [kind]: result.reason?.message || 'Capture failed. Contact your proctor.' }));
      } else if (result.value) {
        setSnapshotErrors(previous => {
          const next = { ...previous };
          delete next[kind];
          return next;
        });
      }
    }
  }, [runSnapshotCapture]);

  // Main IPC listeners
  useEffect(() => {
    const removeTimerTickListener = window.athena?.registerListenerForTimerTickFromMain?.((value) => {
      if (quizStartedRef.current) setTimer(value);
    }) || (() => {});
    const removeCameraSnapListener = window.athena?.registerListenerForCameraSnapFromMain?.(saveVideoScreenShots) || (() => {});
    const removeKeyboardListener = window.athena?.registerListenerForKeyboardInputFromMain?.((input) => {
      console.log("Keyboard input intercepted from main:", input);
    }) || (() => {});

    const removeWindowBlurListener = window.athena?.registerListenerForWindowBlur?.(() => {
      if (quizStarted) {
        setViolationCount((c) => {
          const next = c + 1;
          alert(`Anti-Cheat Warning: Window focus lost or external app selected! (Violation #${next})`);
          return next;
        });
      }
    }) || (() => {});

    return () => {
      removeTimerTickListener();
      removeCameraSnapListener();
      removeKeyboardListener();
      removeWindowBlurListener();
    };
  }, [quizStarted, saveVideoScreenShots]);

  async function getCameraAccess() {
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
      stopMediaStream(streamRef.current);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraEnabled(true);

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          setCameraEnabled(false);
          if (quizStartedRef.current) {
            setViolationCount((c) => {
              const next = c + 1;
              alert(`Anti-Cheat Warning: Camera disconnected! (Violation #${next})`);
              return next;
            });
          }
        };
      }
    } catch (error) {
      console.error("Camera access failed:", error);
      alert('Unable to access camera or microphone. Please verify hardware permissions and connections.');
    }
  }

  async function getScreenAccess() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      stopMediaStream(screenStreamRef.current);
      screenStreamRef.current = stream;
      setScreenShared(true);

      const screenTrack = stream.getVideoTracks()[0];
      if (screenTrack) {
        screenTrack.onended = () => {
          setScreenShared(false);
          screenStreamRef.current = null;
          if (quizStartedRef.current) {
            setViolationCount((c) => {
              const next = c + 1;
              alert(`Anti-Cheat Warning: Screen share was terminated! (Violation #${next})`);
              return next;
            });
          }
        };
      }
    } catch (error) {
      console.error("Screen share access failed:", error);
      alert('Unable to access screen share. Please select your screen to continue.');
    }
  }

  async function handleSelectFolder() {
    try {
      const path = await window.athena?.selectFolder?.();
      if (path) {
        setFolderSelected(true);
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function enableFullScreen() {
    try {
      if (window.athena?.isFullScreen) {
        const isFs = await window.athena.isFullScreen();
        if (isFs) {
          setFullScreen(true);
          return;
        }
      }
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      setFullScreen(true);
    } catch (error) {
      console.error(error);
      setFullScreen(true);
    }
  }

  async function hasValidDisplaySetup() {
    if (!window.athena?.checkMultipleDisplays) return true;

    const hasMultiple = await window.athena.checkMultipleDisplays();
    if (hasMultiple) {
      alert("Anti-Cheat Alert: Multiple displays detected. Please disconnect external monitors before starting the exam.");
      return false;
    }

    return true;
  }

  async function startExamOnBackend() {
    if (!studentName.trim() || !studentId.trim()) {
      alert("Please enter both your Full Name and Student ID.");
      return;
    }

    if (isStartingExamRef.current) return;
    const candidateGeneration = candidateGenerationRef.current;
    isStartingExamRef.current = true;
    setIsStartingExam(true);

    try {
      if (!await hasValidDisplaySetup() || candidateGenerationRef.current !== candidateGeneration) return;

      localStorage.setItem('athena_studentName', studentName.trim());
      localStorage.setItem('athena_studentId', studentId.trim());

      const response = await apiFetch('/exam/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: studentId.trim(),
          name: studentName.trim()
        })
      });
      const data = await response.json();
      if (candidateGenerationRef.current !== candidateGeneration) return;

      if (response.ok) {
        setSessionId(data.sessionId);
        setSnapshotErrors({});
        setQuizStarted(true);
        setShowPermissionsModal(false);
        localStorage.setItem('athena_sessionId', data.sessionId);
        await window.athena?.startTimerOnMain?.();
      } else {
        alert("Failed to start exam: " + data.message);
      }
    } catch (error) {
      if (candidateGenerationRef.current !== candidateGeneration) return;
      console.error("Network error:", error);
      alert(`Exam service unavailable: ${error.message}. Check your network connection or contact the exam administrator.`);
    } finally {
      if (candidateGenerationRef.current === candidateGeneration) {
        isStartingExamRef.current = false;
        setIsStartingExam(false);
      }
    }
  }

  const isPermissionsReady = cameraEnabled && screenShared && folderSelected && fullScreen && studentName.trim() && studentId.trim();

  async function resumeExamSession() {
    if (!isPermissionsReady) {
      setShowPermissionsModal(true);
      return;
    }

    const candidateGeneration = candidateGenerationRef.current;
    if (!await hasValidDisplaySetup() || candidateGenerationRef.current !== candidateGeneration) return;

    setSnapshotErrors({});
    setQuizStarted(true);
    setShowPermissionsModal(false);
    await window.athena?.startTimerOnMain?.();
  }

  function handleStartTestClick() {
    if (!isPermissionsReady) {
      setShowPermissionsModal(true);
      return;
    }

    if (sessionId) {
      resumeExamSession();
      return;
    }

    startExamOnBackend();
  }

  async function handleSwitchUser(event) {
    event.stopPropagation();
    candidateGenerationRef.current += 1;
    sessionIdRef.current = null;
    quizStartedRef.current = false;
    isStartingExamRef.current = false;
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    stopMediaStream(screenStreamRef.current);
    screenStreamRef.current = null;
    setCameraEnabled(false);
    setScreenShared(false);
    localStorage.removeItem('athena_studentName');
    localStorage.removeItem('athena_studentId');
    localStorage.removeItem('athena_sessionId');
    setStudentName('');
    setStudentId('');
    setIsLoggedIn(false);
    setSessionId(null);
    setRestoredAnswers({});
    setExamResults(null);
    setQuizStarted(false);
    setViolationCount(0);
    setTimer('');
    setSnapshotErrors({});
    setIsStartingExam(false);
    setShowPermissionsModal(false);
    setShowRulesModal(false);
    setShowProfileMenu(false);
    try {
      await window.athena?.stopTimerOnMain?.();
    } catch (error) {
      console.error("Failed to stop exam timer:", error);
    }
  }

  const initials = studentName
    .split(' ')
    .filter(Boolean)
    .map(p => p[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'CA';

  if (examResults) {
    return (
      <div className="app-wrapper">
        <header className="navbar">
          <div className="navbar-left">
            <div className="cohort-badge">
              <svg className="cohort-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              </svg>
              <span>Cohort NST'24 CS+AI</span>
            </div>
          </div>
          <div className="navbar-right">
            <div className="avatar-circle">{initials}</div>
          </div>
        </header>

        <main className="main-container">
          <div className="results-card">
            <h2 className="results-title">Assessment Summary</h2>
            <p className="results-candidate">
              Candidate: <strong>{studentName}</strong> ({studentId})
            </p>

            <div className="results-grid">
              <div className="result-stat-box">
                <div className="stat-label">Attempted</div>
                <div className="stat-val">{examResults.attempted}</div>
              </div>
              <div className="result-stat-box stat-correct">
                <div className="stat-label">Correct</div>
                <div className="stat-val">{examResults.correct}</div>
              </div>
              <div className="result-stat-box stat-wrong">
                <div className="stat-label">Incorrect</div>
                <div className="stat-val">{examResults.wrong}</div>
              </div>
            </div>

            {violationCount > 0 && (
              <div className="results-warning-note">
                Proctoring warnings recorded: <strong>{violationCount}</strong>
              </div>
            )}

            <div className="results-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setExamResults(null);
                  setSessionId(null);
                  setRestoredAnswers({});
                  localStorage.removeItem('athena_sessionId');
                }}
              >
                Start New Exam
              </button>
              <button
                className="btn btn-outline"
                onClick={() => window.athena?.exitExam?.(false)}
              >
                Exit App
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (quizStarted) {
    return (
      <div style={{ position: 'relative', width: '100%', minHeight: '100vh', backgroundColor: '#ffffff' }}>
        {Object.keys(snapshotErrors).length > 0 && (
          <div className="snapshot-warning" role="status">
            <strong>Proctoring snapshots need attention</strong>
            {Object.entries(snapshotErrors).map(([kind, message]) => (
              <div key={kind}>{kind === 'screen' ? 'Desktop' : 'Webcam'}: {message}</div>
            ))}
          </div>
        )}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          style={{
            position: 'fixed',
            bottom: '72px',
            right: '24px',
            width: '180px',
            height: '108px',
            objectFit: 'cover',
            borderRadius: '6px',
            zIndex: 1000,
            border: '1px solid #334155',
            backgroundColor: '#000000'
          }}
        />
        <Quiz
          key={sessionId}
          sessionId={sessionId}
          studentName={studentName}
          studentId={studentId}
          timer={timer}
          violationCount={violationCount}
          restoredAnswers={restoredAnswers}
          onFinish={(results) => {
            quizStartedRef.current = false;
            stopMediaStream(streamRef.current);
            streamRef.current = null;
            stopMediaStream(screenStreamRef.current);
            screenStreamRef.current = null;
            setCameraEnabled(false);
            setScreenShared(false);
            window.athena?.stopTimerOnMain?.();
            setExamResults(results);
            setQuizStarted(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app-wrapper">
      <header className="navbar">
        <div className="navbar-left">
          <div className="cohort-badge">
            <svg className="cohort-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            </svg>
            <span>Cohort NST'24 CS+AI</span>
          </div>
        </div>

        <div className="navbar-right">
          {isLoggedIn ? (
            <div className="profile-pill" onClick={() => setShowProfileMenu(p => !p)}>
              <span className="profile-name">{studentName}</span>
              <div className="avatar-circle">{initials}</div>
              <svg className="chevron-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>

              {showProfileMenu && (
                <div className="profile-dropdown">
                  <div className="profile-dropdown-header">
                    <div className="name">{studentName}</div>
                    <div className="id">{studentId}</div>
                  </div>
                  <button className="profile-dropdown-item" onClick={() => setShowRulesModal(true)}>
                    Exam Rules
                  </button>
                  <button className="profile-dropdown-item" onClick={handleSwitchUser}>
                    Switch User
                  </button>
                  <button className="profile-dropdown-item danger" onClick={() => window.athena?.exitExam?.(true)}>
                    Exit Exam
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              className="btn btn-outline btn-sm"
              onClick={() => window.athena?.exitExam?.(true)}
            >
              Exit
            </button>
          )}
        </div>
      </header>

      <main className="main-container">
        {!isLoggedIn ? (
          <div className="login-container">
            <h2 className="login-title">Candidate Sign In</h2>
            <p className="login-subtitle">Enter your name and student ID to access the examination portal.</p>

            <div className="login-field">
              <label className="login-label">Full Name</label>
              <input
                type="text"
                className="login-input"
                placeholder="e.g. Akshith Kumar"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
              />
            </div>

            <div className="login-field">
              <label className="login-label">Student ID / Roll Number</label>
              <input
                type="text"
                className="login-input"
                placeholder="e.g. NST-2024-AI"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
              />
            </div>

            <button
              className="login-btn"
              disabled={!studentName.trim() || !studentId.trim()}
              onClick={() => {
                if (studentName.trim() && studentId.trim()) {
                  localStorage.setItem('athena_studentName', studentName.trim());
                  localStorage.setItem('athena_studentId', studentId.trim());
                  setIsLoggedIn(true);
                }
              }}
            >
              Sign In & Continue
            </button>
          </div>
        ) : (
          <>
            <button className="back-link" onClick={() => window.athena?.exitExam?.(true)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"></polyline>
              </svg>
              <span>Back</span>
            </button>

            <div className="test-card">
              <div className="card-header-banner">
                <div className="card-header-info">
                  <div className="exam-badge-row">
                    <span className="exam-status-pill">Scheduled</span>
                    <span className="exam-code">DL-REC-401</span>
                  </div>
                  <h1 className="exam-title">Gated Architectures, LSTM, GRU</h1>
                  <p className="exam-subtitle">Deep Learning • Revision Assessment</p>
                </div>
              </div>

              <div className="card-content">
                <div className="meta-section-label">Syllabus</div>
                <div className="syllabus-text">
                  Gated Recurrent Units (GRU), Long Short-Term Memory (LSTM), vanishing gradients, gate mechanisms and sequence modeling.
                </div>

                <div className="meta-info-grid">
                  <div className="meta-item">
                    <div className="meta-icon-box">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="16" y1="2" x2="16" y2="6"></line>
                        <line x1="8" y1="2" x2="8" y2="6"></line>
                        <line x1="3" y1="10" x2="21" y2="10"></line>
                      </svg>
                    </div>
                    <div>
                      <div className="meta-info-title">Scheduled time</div>
                      <div className="meta-info-value">Oct 29, 2026 • 3:35 PM</div>
                    </div>
                  </div>

                  <div className="meta-item">
                    <div className="meta-icon-box">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                        <line x1="16" y1="13" x2="8" y2="13"></line>
                        <line x1="16" y1="17" x2="8" y2="17"></line>
                      </svg>
                    </div>
                    <div>
                      <div className="meta-info-title">Total questions</div>
                      <div className="meta-info-value">4 Questions</div>
                    </div>
                  </div>

                  <div className="meta-item">
                    <div className="meta-icon-box">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                      </svg>
                    </div>
                    <div>
                      <div className="meta-info-title">Duration</div>
                      <div className="meta-info-value">30 Minutes</div>
                    </div>
                  </div>

                  <div className="meta-item">
                    <div className="meta-icon-box">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                      </svg>
                    </div>
                    <div>
                      <div className="meta-info-title">Total marks</div>
                      <div className="meta-info-value">22 Points</div>
                    </div>
                  </div>
                </div>

                <button className="start-test-btn" disabled={isStartingExam} onClick={handleStartTestClick}>
                  {isStartingExam ? "Starting session..." : sessionId ? "Resume Examination" : "Start Examination"}
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Permissions Modal */}
      {showPermissionsModal && (
        <div className="modal-overlay">
          <div className="modal-box">
            <div className="modal-header">
              <div>
                <h3>Required Permissions</h3>
                <p>The proctoring system verifies your environment before starting.</p>
              </div>
              <button className="modal-close-btn" onClick={() => setShowPermissionsModal(false)}>×</button>
            </div>

            {/* Candidate Details Step */}
            <div className="permission-step">
              <div className="permission-step-header">
                <span className="permission-step-title">Candidate Details</span>
                <span className={`permission-step-status ${studentName.trim() && studentId.trim() ? 'status-granted' : 'status-pending'}`}>
                  {studentName.trim() && studentId.trim() ? 'Ready' : 'Required'}
                </span>
              </div>
              <p className="permission-step-desc">Enter your official identification information.</p>
              <div className="input-row">
                <input
                  type="text"
                  placeholder="Full Name"
                  className="text-input"
                  value={studentName}
                  onChange={e => setStudentName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Student ID / Roll No."
                  className="text-input"
                  value={studentId}
                  onChange={e => setStudentId(e.target.value)}
                />
              </div>
            </div>

            {/* Camera Permission Step */}
            <div className="permission-step">
              <div className="permission-step-header">
                <span className="permission-step-title">1. Hardware Camera & Audio</span>
                <span className={`permission-step-status ${cameraEnabled ? 'status-granted' : 'status-pending'}`}>
                  {cameraEnabled ? 'Connected' : 'Pending'}
                </span>
              </div>
              <p className="permission-step-desc">
                Continuous camera feed and microphone verification are required for automated proctoring.
              </p>
              <button className="btn btn-outline btn-sm" disabled={cameraEnabled} onClick={getCameraAccess}>
                {cameraEnabled ? 'Hardware active' : 'Connect camera & mic'}
              </button>
              {cameraEnabled && (
                <video ref={videoRef} autoPlay playsInline className="video-thumb" />
              )}
            </div>

            {/* Screen Share Step */}
            <div className="permission-step">
              <div className="permission-step-header">
                <span className="permission-step-title">2. Display Screen Capture</span>
                <span className={`permission-step-status ${screenShared ? 'status-granted' : 'status-pending'}`}>
                  {screenShared ? 'Connected' : 'Pending'}
                </span>
              </div>
              <p className="permission-step-desc">
                Screen sharing enables periodic audit captures during the exam.
              </p>
              <button className="btn btn-outline btn-sm" disabled={screenShared} onClick={getScreenAccess}>
                {screenShared ? 'Display stream active' : 'Enable screen share'}
              </button>
            </div>

            {/* Storage Directory Step */}
            <div className="permission-step">
              <div className="permission-step-header">
                <span className="permission-step-title">3. Local Snapshot Storage</span>
                <span className={`permission-step-status ${folderSelected ? 'status-granted' : 'status-pending'}`}>
                  {folderSelected ? 'Configured' : 'Pending'}
                </span>
              </div>
              <p className="permission-step-desc">
                Select a local directory where audit frames will be securely retained.
              </p>
              <button className="btn btn-outline btn-sm" disabled={folderSelected} onClick={handleSelectFolder}>
                {folderSelected ? 'Storage configured' : 'Select directory'}
              </button>
            </div>

            {/* Fullscreen Mode Step */}
            <div className="permission-step">
              <div className="permission-step-header">
                <span className="permission-step-title">4. Full-Screen Lock</span>
                <span className={`permission-step-status ${fullScreen ? 'status-granted' : 'status-pending'}`}>
                  {fullScreen ? 'Active' : 'Pending'}
                </span>
              </div>
              <p className="permission-step-desc">
                The assessment must run in full-screen mode to prevent background activity.
              </p>
              <button className="btn btn-outline btn-sm" disabled={fullScreen} onClick={enableFullScreen}>
                {fullScreen ? 'Full-screen active' : 'Enter full-screen'}
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
              <button className="btn btn-outline btn-sm" onClick={() => setShowPermissionsModal(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={!isPermissionsReady || isStartingExam}
                onClick={sessionId ? resumeExamSession : startExamOnBackend}
              >
                {isStartingExam ? 'Launching...' : sessionId ? 'Resume Examination' : 'Start Examination'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rules Modal */}
      {showRulesModal && (
        <div className="modal-overlay">
          <div className="modal-box">
            <div className="modal-header">
              <div>
                <h3>Examination Rules & Integrity Policy</h3>
                <p>Review the protocol before taking this assessment.</p>
              </div>
              <button className="modal-close-btn" onClick={() => setShowRulesModal(false)}>×</button>
            </div>
            <div style={{ fontSize: '13px', color: '#475569', lineHeight: '1.7', marginBottom: '20px' }}>
              <p>1. <strong>Full-screen confinement:</strong> Exiting full-screen generates an integrity warning flag.</p>
              <p>2. <strong>Continuous proctoring:</strong> Webcam and desktop screenshots are captured periodically.</p>
              <p>3. <strong>Restricted peripherals:</strong> Dual monitors, virtual displays, and screen-sharing tools are prohibited.</p>
              <p>4. <strong>Session restoration:</strong> Answers are stored automatically after each selection.</p>
              <p>5. <strong>Final submission:</strong> Once submitted, test responses cannot be modified.</p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary btn-sm" onClick={() => setShowRulesModal(false)}>
                Acknowledge
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
