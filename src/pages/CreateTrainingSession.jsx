// src/pages/CreateTrainingSession.jsx

import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import SignaturePad from 'signature_pad';
import { supabase } from '../supabaseClient';
import './CreateTrainingSession.css';

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
  const trainerSignatureCanvasRef = useRef(null);
  const trainerSignaturePadRef = useRef(null);
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
  const [hasTrainerSignature, setHasTrainerSignature] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const studentSignInLink = useMemo(() => {
    if (!createdSession?.id) return '';

    return `${window.location.origin}/attendance/session/${createdSession.id}`;
  }, [createdSession]);

  useEffect(() => {
    if (createdSession) return undefined;

    const canvas = trainerSignatureCanvasRef.current;

    if (!canvas) return undefined;

    function resizeCanvas() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const parentWidth = canvas.parentElement.offsetWidth;

      canvas.width = parentWidth * ratio;
      canvas.height = 160 * ratio;
      canvas.getContext('2d').scale(ratio, ratio);
      setHasTrainerSignature(false);
    }

    resizeCanvas();

    const signaturePad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });
    const handleSignatureEnd = () =>
      setHasTrainerSignature(!signaturePad.isEmpty());

    trainerSignaturePadRef.current = signaturePad;
    signaturePad.addEventListener('endStroke', handleSignatureEnd);
    window.addEventListener('resize', resizeCanvas);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      signaturePad.removeEventListener('endStroke', handleSignatureEnd);
      signaturePad.off();
      trainerSignaturePadRef.current = null;
    };
  }, [createdSession]);

  function clearTrainerSignature() {
    trainerSignaturePadRef.current?.clear();
    setHasTrainerSignature(false);
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

    if (!trainerSignaturePadRef.current || trainerSignaturePadRef.current.isEmpty()) {
      setErrorMessage('Trainer signature is required.');
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
      let trainerSignaturePath = null;

      const trainerSignatureDataUrl =
        trainerSignaturePadRef.current.toDataURL('image/png');
      const trainerSignatureBlob = dataUrlToBlob(trainerSignatureDataUrl);
      const fileName = `${Date.now()}-${crypto.randomUUID()}.png`;

      trainerSignaturePath = `trainer-signatures/${fileName}`;

      const uploadResult = await supabase.storage
        .from('signatures')
        .upload(trainerSignaturePath, trainerSignatureBlob, {
          contentType: 'image/png',
          upsert: false,
        });

      if (uploadResult.error) {
        throw uploadResult.error;
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
        })
        .select()
        .single();

      if (error) {
        throw error;
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

  function handleDownloadQrCode() {
    const canvas = qrCodeRef.current?.querySelector('canvas');

    if (!canvas || !createdSession?.id) return;

    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `student-sign-in-${createdSession.id}.png`;
    link.click();
  }

  function handleCreateAnother() {
    setCourseName('');
    setCompanyName('');
    setTrainingLocation('');
    setTrainerName('');
    setCourseOutline('');
    setTrainingDate(getTodayDateValue());
    setTimeStarted(getCurrentTimeValue());
    setClassEndTime('');
    setExpiresAt(getDefaultExpirationValue());
    clearTrainerSignature();
    setCreatedSession(null);
    setCopied(false);
    setErrorMessage('');
  }

  return (
    <section className="create-session-page">
      <div className="create-session-card">
        <div className="create-session-header">
          <p className="eyebrow">Instructor Setup</p>
          <h1>Create Training Session</h1>
          <p>
            Enter the class details once. Students will use the generated link
            to sign the attendance record for this session.
          </p>
        </div>

        {errorMessage && (
          <div className="alert alert-error" role="alert">
            {errorMessage}
          </div>
        )}

        {!createdSession ? (
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

              <div className="trainer-signature-box">
                <canvas ref={trainerSignatureCanvasRef} />
              </div>

              <button
                type="button"
                className="secondary-button clear-signature-button"
                onClick={clearTrainerSignature}
                disabled={!hasTrainerSignature}
              >
                Clear Trainer Signature
              </button>
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
              Training session created successfully.
            </div>

            <div className="session-summary">
              <h2>Session Details</h2>

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

              <p>Send this link to students or open it on the sign-in device.</p>
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

            <div className="action-row">
              <a className="primary-button link-button" href={studentSignInLink}>
                Open Student Sign-In Form
              </a>

              <button
                className="secondary-button"
                type="button"
                onClick={handleCreateAnother}
              >
                Create Another Session
              </button>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
