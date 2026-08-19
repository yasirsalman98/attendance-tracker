// src/pages/CreateTrainingSession.jsx

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import SignaturePad from 'signature_pad';
import { supabase } from '../supabaseClient';
import { isSettingsAdminUser } from '../userFeatureAccess';
import './CreateTrainingSession.css';

function isMissingArchiveColumn(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    (error?.code === '42703' || message.includes('column')) &&
    message.includes('archived_at')
  );
}

function getTodayDateValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const localDate = new Date(now.getTime() - offset * 60 * 1000);
  return localDate.toISOString().split('T')[0];
}

function getCurrentTimeValue() {
  const now = new Date();
  return now.toTimeString().slice(0, 5);
}

function getDateTimeLocalValue(date = new Date()) {
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60 * 1000);
  return localDate.toISOString().slice(0, 16);
}

function getDefaultExpirationValue() {
  return getDateTimeLocalValue(new Date(Date.now() + 2 * 60 * 60 * 1000));
}

function combineDateAndTimeToIso(dateValue, timeValue) {
  if (!dateValue || !timeValue) return null;

  const localDateTime = new Date(`${dateValue}T${timeValue}:00`);
  return localDateTime.toISOString();
}

function getLocalDateTimeIso(dateTimeValue) {
  if (!dateTimeValue) return null;

  const localDateTime = new Date(dateTimeValue);
  if (Number.isNaN(localDateTime.getTime())) return null;

  return localDateTime.toISOString();
}

function formatDateTime(value) {
  if (!value) return 'N/A';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';

  return date.toLocaleString();
}

function formatDate(value) {
  if (!value) return 'N/A';

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString();
}

function isLocalHost() {
  return ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

function getAttendanceRecordsUrl() {
  if (isLocalHost()) {
    return 'http://localhost:3001/.netlify/functions/attendance-records';
  }

  return '/.netlify/functions/attendance-records';
}

function dataUrlToBlob(dataUrl) {
  const [metadata, base64Data] = dataUrl.split(',');
  const mimeMatch = metadata.match(/data:(.*);base64/);
  const mimeType = mimeMatch?.[1] || 'image/png';
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

export default function CreateTrainingSession() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const trainerSignatureCanvasRef = useRef(null);
  const trainerSignaturePadRef = useRef(null);
  const acceptedTrainerSignatureDataRef = useRef(null);
  const qrCodeRef = useRef(null);
  const [courseName, setCourseName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [trainingLocation, setTrainingLocation] = useState('');
  const [trainerName, setTrainerName] = useState('');
  const [courseOutline, setCourseOutline] = useState('');

  const [trainingDate, setTrainingDate] = useState(getTodayDateValue());
  const [timeStarted, setTimeStarted] = useState(getCurrentTimeValue());
  const [classEndTime, setClassEndTime] = useState('');
  const [expiresAt, setExpiresAt] = useState(getDefaultExpirationValue());

  const [createdSession, setCreatedSession] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copiedKioskLink, setCopiedKioskLink] = useState(false);
  const [hasTrainerSignature, setHasTrainerSignature] = useState(false);
  const [isTrainerSignatureAccepted, setIsTrainerSignatureAccepted] = useState(false);
  const [acceptedTrainerSignatureDataUrl, setAcceptedTrainerSignatureDataUrl] =
    useState('');
  const [trainerSignatureMessage, setTrainerSignatureMessage] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [liveSessions, setLiveSessions] = useState([]);
  const [isCheckingLiveSessions, setIsCheckingLiveSessions] = useState(false);
  const [liveSessionsError, setLiveSessionsError] = useState('');
  const [liveSessionsMessage, setLiveSessionsMessage] = useState('');
  const [deletingSessionId, setDeletingSessionId] = useState(null);
  const [isLoadingExistingSession, setIsLoadingExistingSession] =
    useState(Boolean(sessionId));

  const studentSignInLink = useMemo(() => {
    if (!createdSession?.id) return '';

    return `${window.location.origin}/attendance/session/${createdSession.id}`;
  }, [createdSession]);
  const kioskSignInLink = useMemo(() => {
    if (!studentSignInLink) return '';

    return `${studentSignInLink}?kiosk=1`;
  }, [studentSignInLink]);

  useEffect(() => {
    let isActive = true;

    async function loadExistingSession() {
      if (!sessionId) {
        setIsLoadingExistingSession(false);
        return;
      }

      setIsLoadingExistingSession(true);
      setErrorMessage('');

      try {
        const { data: userData, error: userError } = await supabase.auth.getUser();

        if (userError || !userData?.user?.id) {
          throw new Error('Please sign in again to view this session.');
        }

        const { data, error } = await supabase
          .from('training_sessions')
          .select('*')
          .eq('id', sessionId)
          .single();

        if (error) {
          throw new Error(`Unable to load training session: ${error.message}`);
        }

        if (data?.attendance_archived_at) {
          throw new Error('This training session was deleted.');
        }

        const canViewSession =
          isSettingsAdminUser(userData.user) ||
          data?.owner_user_id === userData.user.id;

        if (!canViewSession) {
          throw new Error('You do not have access to this training session.');
        }

        if (isActive) {
          setCreatedSession(data);
        }
      } catch (error) {
        console.error('Load training session detail error:', error);

        if (isActive) {
          setCreatedSession(null);
          setErrorMessage(error?.message || 'Unable to load this training session.');
        }
      } finally {
        if (isActive) {
          setIsLoadingExistingSession(false);
        }
      }
    }

    loadExistingSession();

    return () => {
      isActive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    let isActive = true;

    async function loadLiveSessions() {
      if (sessionId) {
        setLiveSessions([]);
        setLiveSessionsError('');
        setIsCheckingLiveSessions(false);
        return;
      }

      setIsCheckingLiveSessions(true);
      setLiveSessionsError('');
      setLiveSessionsMessage('');

      try {
        const { data: userData, error: userError } = await supabase.auth.getUser();

        if (userError || !userData?.user?.id) {
          throw new Error('Please sign in again to check for live sessions.');
        }

        const activeSessionSelect =
          'id, course_name, training_date, company_name, expires_at, owner_user_id, created_at, attendance_archived_at';
        const fallbackSessionSelect =
          'id, course_name, training_date, company_name, expires_at, owner_user_id, created_at';

        const createSessionQuery = (selectColumns, includeArchiveFilter) => {
          let query = supabase
            .from('training_sessions')
            .select(selectColumns)
            .gt('expires_at', new Date().toISOString())
            .order('training_date', { ascending: false })
            .order('created_at', { ascending: false });

          if (!isSettingsAdminUser(userData.user)) {
            query = query.eq('owner_user_id', userData.user.id);
          }

          if (includeArchiveFilter) {
            query = query.is('attendance_archived_at', null);
          }

          return query;
        };

        let sessionsResult = await createSessionQuery(activeSessionSelect, true);

        if (isMissingArchiveColumn(sessionsResult.error)) {
          sessionsResult = await createSessionQuery(fallbackSessionSelect, false);
        }

        if (sessionsResult.error) {
          throw sessionsResult.error;
        }

        const sessions = sessionsResult.data || [];
        const sessionIds = sessions.map((session) => session.id).filter(Boolean);
        const countsBySessionId = new Map();

        if (sessionIds.length > 0) {
          const createRecordsQuery = (includeArchiveFilter) => {
            let query = supabase
              .from('attendance_records')
              .select('training_session_id')
              .in('training_session_id', sessionIds);

            if (includeArchiveFilter) {
              query = query.is('archived_at', null);
            }

            return query;
          };

          let recordsResult = await createRecordsQuery(true);

          if (isMissingArchiveColumn(recordsResult.error)) {
            recordsResult = await createRecordsQuery(false);
          }

          if (recordsResult.error) {
            console.error('Load live session attendance counts error:', recordsResult.error);
          } else {
            (recordsResult.data || []).forEach((record) => {
              const recordSessionId = record.training_session_id;
              countsBySessionId.set(
                recordSessionId,
                (countsBySessionId.get(recordSessionId) || 0) + 1
              );
            });
          }
        }

        if (isActive) {
          setLiveSessions(
            sessions.map((session) => ({
              ...session,
              signedInCount: countsBySessionId.get(session.id) || 0,
            }))
          );
        }
      } catch (error) {
        console.error('Load live sessions error:', error);

        if (isActive) {
          setLiveSessions([]);
          setLiveSessionsError(
            'Unable to check live sessions right now. You can still create a new session.'
          );
        }
      } finally {
        if (isActive) {
          setIsCheckingLiveSessions(false);
        }
      }
    }

    loadLiveSessions();

    return () => {
      isActive = false;
    };
  }, [sessionId]);

  async function closeTrainingSession(session) {
    const { data, error: sessionError } = await supabase.auth.getSession();
    const accessToken = data?.session?.access_token;

    if (sessionError || !accessToken) {
      throw new Error('Please sign in again before deleting this session.');
    }

    const response = await fetch(getAttendanceRecordsUrl(), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'close_session',
        sessionId: session.id,
      }),
    });
    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        responseBody?.error || 'Unable to delete this session. Please try again.'
      );
    }
  }

  async function handleDeleteLiveSession(session) {
    if (!session?.id || session.isTemporaryPreview) return;

    const confirmed = window.confirm(
      `Delete this live session?\n\n${session.course_name || 'Untitled Training Session'}\n\nThis session will be removed from all session lists and students will no longer be able to use its attendance link.`
    );

    if (!confirmed) return;

    setDeletingSessionId(session.id);
    setLiveSessionsError('');
    setLiveSessionsMessage('');

    try {
      await closeTrainingSession(session);
      setLiveSessions((currentSessions) =>
        currentSessions.filter((liveSession) => liveSession.id !== session.id)
      );
      setLiveSessionsMessage('Live session deleted. Existing attendance records were kept.');
    } catch (error) {
      console.error('Delete live session error:', error);
      setLiveSessionsError(
        error?.message || 'Unable to delete this live session. Please try again.'
      );
    } finally {
      setDeletingSessionId(null);
    }
  }

  async function handleDeleteCurrentSession() {
    if (!createdSession?.id) return;

    const confirmed = window.confirm(
      `Delete this session?\n\n${createdSession.course_name || 'Untitled Training Session'}\n\nThis session will be removed from all session lists and students will no longer be able to use its attendance link.`
    );

    if (!confirmed) return;

    setDeletingSessionId(createdSession.id);
    setErrorMessage('');

    try {
      await closeTrainingSession(createdSession);
      setCreatedSession(null);
      navigate('/create-session-7392', { replace: true });
    } catch (error) {
      console.error('Delete current session error:', error);
      setErrorMessage(
        error?.message || 'Unable to delete this session. Please try again.'
      );
    } finally {
      setDeletingSessionId(null);
    }
  }

  useEffect(() => {
    if (createdSession) return undefined;

    const canvas = trainerSignatureCanvasRef.current;

    if (!canvas) return undefined;

    function getCanvasSize() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const parentWidth = canvas.parentElement?.offsetWidth || canvas.offsetWidth;

      return {
        height: Math.max(Math.floor(160 * ratio), 1),
        ratio,
        width: Math.max(Math.floor(parentWidth * ratio), 1),
      };
    }

    function resizeCanvas({ preserveSignature = false } = {}) {
      const { height, ratio, width } = getCanvasSize();

      if (canvas.width === width && canvas.height === height) {
        return;
      }

      const signaturePad = trainerSignaturePadRef.current;
      let savedSignature = null;

      if (acceptedTrainerSignatureDataRef.current?.length) {
        savedSignature = acceptedTrainerSignatureDataRef.current;
      } else if (
        preserveSignature &&
        signaturePad &&
        typeof signaturePad.toData === 'function' &&
        !signaturePad.isEmpty()
      ) {
        savedSignature = signaturePad.toData();
      }

      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);

      if (
        signaturePad &&
        savedSignature?.length &&
        typeof signaturePad.fromData === 'function'
      ) {
        try {
          signaturePad.fromData(savedSignature);
          setHasTrainerSignature(!signaturePad.isEmpty());
        } catch (error) {
          console.error('Trainer signature resize restore error:', error);
          setHasTrainerSignature(false);
        }
      }
    }

    resizeCanvas();

    const signaturePad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });
    const handleSignatureEnd = () => {
      setHasTrainerSignature(!signaturePad.isEmpty());
      setIsTrainerSignatureAccepted(false);
      setAcceptedTrainerSignatureDataUrl('');
      acceptedTrainerSignatureDataRef.current = null;
      setTrainerSignatureMessage('');
    };

    trainerSignaturePadRef.current = signaturePad;
    signaturePad.addEventListener('endStroke', handleSignatureEnd);
    const handleResize = () => resizeCanvas({ preserveSignature: true });

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      signaturePad.removeEventListener('endStroke', handleSignatureEnd);
      signaturePad.off();
      trainerSignaturePadRef.current = null;
    };
  }, [createdSession]);

  function clearTrainerSignature() {
    trainerSignaturePadRef.current?.clear();
    trainerSignaturePadRef.current?.on();
    acceptedTrainerSignatureDataRef.current = null;
    setHasTrainerSignature(false);
    setIsTrainerSignatureAccepted(false);
    setAcceptedTrainerSignatureDataUrl('');
    setTrainerSignatureMessage('');
  }

  function acceptTrainerSignature() {
    const signaturePad = trainerSignaturePadRef.current;

    if (!signaturePad || signaturePad.isEmpty()) {
      setTrainerSignatureMessage('Please sign before accepting.');
      setIsTrainerSignatureAccepted(false);
      return;
    }

    acceptedTrainerSignatureDataRef.current = signaturePad.toData();
    setAcceptedTrainerSignatureDataUrl(signaturePad.toDataURL('image/png'));
    setHasTrainerSignature(true);
    setIsTrainerSignatureAccepted(true);
    setTrainerSignatureMessage('Signature accepted.');
    signaturePad.off();
  }

  async function handleSubmit(event) {
    event.preventDefault();

    setErrorMessage('');
    setCreatedSession(null);
    setCopied(false);

    const cleanCourseName = courseName.trim();
    const cleanCompanyName = companyName.trim();
    const cleanTrainingLocation = trainingLocation.trim();
    const cleanTrainerName = trainerName.trim();
    const cleanCourseOutline = courseOutline.trim();

    if (!cleanCourseName) {
      setErrorMessage('Course name is required.');
      return;
    }

    if (!cleanTrainerName) {
      setErrorMessage('Trainer name is required.');
      return;
    }

    if (!acceptedTrainerSignatureDataUrl) {
      setErrorMessage('Please accept the trainer signature before creating the session.');
      return;
    }

    if (!trainingDate) {
      setErrorMessage('Training date is required.');
      return;
    }

    if (!timeStarted) {
      setErrorMessage('Time started is required.');
      return;
    }

    if (!expiresAt) {
      setErrorMessage('Attendance link expiration time is required.');
      return;
    }

    const startIso = combineDateAndTimeToIso(trainingDate, timeStarted);
    const classEndIso = classEndTime
      ? combineDateAndTimeToIso(trainingDate, classEndTime)
      : null;
    const expirationIso = getLocalDateTimeIso(expiresAt);

    if (
      classEndIso &&
      new Date(classEndIso).getTime() <= new Date(startIso).getTime()
    ) {
      setErrorMessage('Class end time must be after the start time.');
      return;
    }

    if (!expirationIso) {
      setErrorMessage('Attendance link expiration time is invalid.');
      return;
    }

    if (new Date(expirationIso).getTime() <= new Date(startIso).getTime()) {
      setErrorMessage('Attendance link expiration time must be after the session start time.');
      return;
    }

    setSubmitting(true);

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();

      if (userError || !userData?.user?.id) {
        throw new Error('Please sign in again before creating a session.');
      }

      let trainerSignaturePath = null;

      const trainerSignatureBlob = dataUrlToBlob(acceptedTrainerSignatureDataUrl);
      const fileName = `${Date.now()}-${crypto.randomUUID()}.png`;

      trainerSignaturePath = `${userData.user.id}/trainer-signatures/${fileName}`;

      const uploadResult = await supabase.storage
        .from('signatures')
        .upload(trainerSignaturePath, trainerSignatureBlob, {
          contentType: 'image/png',
          upsert: false,
        });

      if (uploadResult.error) {
        throw new Error(
          `Unable to upload trainer signature: ${uploadResult.error.message}`
        );
      }

      const { data, error } = await supabase
        .from('training_sessions')
        .insert({
          course_name: cleanCourseName,
          training_date: trainingDate,
          time_started: startIso,
          time_stopped: classEndIso,
          expires_at: expirationIso,
          company_name: cleanCompanyName || null,
          training_location: cleanTrainingLocation || null,
          trainer_name: cleanTrainerName,
          trainer_signature_path: trainerSignaturePath,
          course_outline: cleanCourseOutline || null,
          owner_user_id: userData.user.id,
        })
        .select()
        .single();

      if (error) {
        throw new Error(`Unable to save training session: ${error.message}`);
      }

      setCreatedSession(data);
    } catch (error) {
      console.error('Create training session error:', error);
      setErrorMessage(error?.message || 'Unable to create the training session.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopyLink() {
    if (!studentSignInLink) return;

    try {
      await navigator.clipboard.writeText(studentSignInLink);
      setCopied(true);
    } catch (error) {
      console.error('Copy link error:', error);
      setErrorMessage('The session was created, but the link could not be copied.');
    }
  }

  async function handleCopyKioskLink() {
    if (!kioskSignInLink) return;

    try {
      await navigator.clipboard.writeText(kioskSignInLink);
      setCopiedKioskLink(true);
    } catch (error) {
      console.error('Copy shared-device sign-in link error:', error);
      setErrorMessage(
        'The session was created, but the shared-device link could not be copied.'
      );
    }
  }

  function handleDownloadQrCode() {
    const canvas = qrCodeRef.current?.querySelector('canvas');

    if (!canvas || !createdSession?.id) return;

    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `student-sign-in-${createdSession.id}.png`;
    link.click();
  }

  return (
    <section className="create-session-page">
      <div className="create-session-card">
        <div className="create-session-header">
          <h1>Create Training Session</h1>
          <p>
            Enter the class details once. Students will use the generated link
            to sign the attendance record for this session.
          </p>
        </div>

        {!createdSession && (
          <>
            {isCheckingLiveSessions && (
              <p className="live-sessions-loading">Checking for live sessions...</p>
            )}

            {!isCheckingLiveSessions && liveSessions.length > 0 && (
              <section className="live-sessions-panel" aria-labelledby="live-sessions-title">
                <div className="live-sessions-heading">
                  <h2 id="live-sessions-title">Live Sessions</h2>
                  <p>
                    You have active sessions available. Select one to continue sharing
                    the QR code or attendance link.
                  </p>
                </div>

                <div className="live-sessions-list">
                  {liveSessions.map((session) => (
                    <article className="live-session-item" key={session.id}>
                      <div className="live-session-card-top">
                        <div className="live-session-title">
                          <span>Training</span>
                          <h3>{session.course_name || 'Untitled Training Session'}</h3>
                        </div>

                        <div className="live-session-actions">
                          <Link
                            className="secondary-button link-button live-session-link"
                            to={`/create-session-7392/${session.id}`}
                          >
                            Continue Session
                          </Link>

                          <button
                            className="secondary-button danger-secondary-button live-session-delete-button"
                            type="button"
                            onClick={() => handleDeleteLiveSession(session)}
                            disabled={deletingSessionId === session.id}
                          >
                            {deletingSessionId === session.id
                              ? 'Deleting...'
                              : 'Delete Session'}
                          </button>
                        </div>
                      </div>

                      <dl>
                        <div>
                          <dt>Date</dt>
                          <dd>{formatDate(session.training_date)}</dd>
                        </div>

                        <div>
                          <dt>Company</dt>
                          <dd>{session.company_name || 'Not provided'}</dd>
                        </div>

                        <div>
                          <dt>Students</dt>
                          <dd>{session.signedInCount}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {!isCheckingLiveSessions && liveSessionsError && (
              <p className="live-sessions-error">{liveSessionsError}</p>
            )}

            {!isCheckingLiveSessions && liveSessionsMessage && (
              <p className="live-sessions-message">{liveSessionsMessage}</p>
            )}
          </>
        )}

        {errorMessage && (
          <div className="alert alert-error" role="alert">
            {errorMessage}
          </div>
        )}

        {isLoadingExistingSession ? (
          <p className="live-sessions-loading">Loading training session...</p>
        ) : !createdSession ? (
          <form className="create-session-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="courseName">Course Name *</label>
              <input
                id="courseName"
                type="text"
                value={courseName}
                onChange={(event) => setCourseName(event.target.value)}
                autoComplete="off"
                required
              />
            </div>

            <div className="form-row session-time-row">
              <div className="form-group">
                <label htmlFor="trainingDate">Training Date *</label>
                <input
                  id="trainingDate"
                  type="date"
                  value={trainingDate}
                  onChange={(event) => setTrainingDate(event.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="timeStarted">Time Started *</label>
                <input
                  id="timeStarted"
                  type="time"
                  value={timeStarted}
                  onChange={(event) => setTimeStarted(event.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="classEndTime">Class End Time</label>
                <input
                  id="classEndTime"
                  type="time"
                  value={classEndTime}
                  onChange={(event) => setClassEndTime(event.target.value)}
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="expiresAt">Attendance Link Expires At *</label>
              <input
                id="expiresAt"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="companyName">Company Name</label>
              <input
                id="companyName"
                type="text"
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                autoComplete="organization"
              />
            </div>

            <div className="form-group">
              <label htmlFor="trainingLocation">Training Location</label>
              <input
                id="trainingLocation"
                type="text"
                value={trainingLocation}
                onChange={(event) => setTrainingLocation(event.target.value)}
                autoComplete="street-address"
              />
            </div>

            <div className="form-group">
              <label htmlFor="trainerName">Trainer Name *</label>
              <input
                id="trainerName"
                type="text"
                value={trainerName}
                onChange={(event) => setTrainerName(event.target.value)}
                autoComplete="name"
                required
              />
            </div>

            <div className="form-group">
              <label>Trainer Signature *</label>
              <p className="helper-text">
                Required. This signature appears on generated certificates and wallet cards.
              </p>

              <div
                className={`trainer-signature-box${
                  isTrainerSignatureAccepted ? ' signature-box-accepted' : ''
                }`}
              >
                <canvas ref={trainerSignatureCanvasRef} />
              </div>

              <div className="signature-action-row">
                <button type="button" onClick={acceptTrainerSignature}>
                  Accept Signature
                </button>

                <button
                  type="button"
                  className="secondary-button danger-secondary-button"
                  onClick={clearTrainerSignature}
                  disabled={!hasTrainerSignature && !isTrainerSignatureAccepted}
                >
                  Remove Signature
                </button>
              </div>

              {trainerSignatureMessage && (
                <p
                  className={
                    isTrainerSignatureAccepted
                      ? 'signature-status'
                      : 'signature-error'
                  }
                >
                  {trainerSignatureMessage}
                </p>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="courseOutline">Course Outline</label>
              <textarea
                id="courseOutline"
                value={courseOutline}
                onChange={(event) => setCourseOutline(event.target.value)}
                placeholder="Enter the outline of course content..."
                rows={6}
              />
            </div>

            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? 'Creating Session...' : 'Create Session'}
            </button>
          </form>
        ) : (
          <section className="session-created">
            <div className="alert alert-success">
              {sessionId
                ? 'Training session loaded.'
                : 'Training session created successfully.'}
            </div>

            <div className="session-summary">
              <div className="session-summary-header">
                <h2>Session Details</h2>

                <button
                  className="secondary-button live-session-delete-button"
                  type="button"
                  onClick={handleDeleteCurrentSession}
                  disabled={deletingSessionId === createdSession.id}
                >
                  {deletingSessionId === createdSession.id
                    ? 'Deleting...'
                    : 'Delete Session'}
                </button>
              </div>

              <dl>
                <div>
                  <dt>Course</dt>
                  <dd>{createdSession.course_name}</dd>
                </div>

                <div>
                  <dt>Date</dt>
                  <dd>{createdSession.training_date}</dd>
                </div>

                <div>
                  <dt>Time Started</dt>
                  <dd>{formatDateTime(createdSession.time_started)}</dd>
                </div>

                <div>
                  <dt>Class End Time</dt>
                  <dd>{formatDateTime(createdSession.time_stopped)}</dd>
                </div>

                <div>
                  <dt>Expires At</dt>
                  <dd>{formatDateTime(createdSession.expires_at)}</dd>
                </div>

                <div>
                  <dt>Company</dt>
                  <dd>{createdSession.company_name || 'Not provided'}</dd>
                </div>

                <div>
                  <dt>Location</dt>
                  <dd>{createdSession.training_location || 'Not provided'}</dd>
                </div>

                <div>
                  <dt>Trainer</dt>
                  <dd>{createdSession.trainer_name}</dd>
                </div>

                <div>
                  <dt>Trainer Signature</dt>
                  <dd>
                    {createdSession.trainer_signature_path
                      ? 'Provided'
                      : 'Not provided'}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="student-link-box">
              <label htmlFor="studentSignInLink">Student Sign-In Link</label>

              <div className="copy-row">
                <input
                  id="studentSignInLink"
                  type="text"
                  value={studentSignInLink}
                  readOnly
                />

                <button type="button" onClick={handleCopyLink}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>

              <p>Send this link to students or use it for the QR code.</p>
            </div>

            <div className="student-link-box kiosk-link-box">
              <label htmlFor="kioskSignInLink">Shared Device Sign-In Link</label>

              <div className="copy-row">
                <input
                  id="kioskSignInLink"
                  type="text"
                  value={kioskSignInLink}
                  readOnly
                />

                <button type="button" onClick={handleCopyKioskLink}>
                  {copiedKioskLink ? 'Copied' : 'Copy'}
                </button>
              </div>

              <p>
                Open this link on a shared computer, tablet, or phone. After each
                successful sign-in, it clears the student information and returns to
                a fresh form.
              </p>
            </div>

            <div className="qr-code-box">
              <div className="qr-code-image" ref={qrCodeRef}>
                <QRCodeCanvas
                  value={studentSignInLink}
                  size={220}
                  level="M"
                  marginSize={4}
                />
              </div>

              <div className="qr-code-copy">
                <h2>Student QR Code</h2>
                <p>
                  Students can scan this QR code to open the same sign-in form.
                </p>

                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleDownloadQrCode}
                >
                  Download QR Code
                </button>
              </div>
            </div>

          </section>
        )}
      </div>
    </section>
  );
}
