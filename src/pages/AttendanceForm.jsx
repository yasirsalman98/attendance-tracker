import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import SignaturePad from 'signature_pad';
import { supabase } from '../supabaseClient';

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const contentType = parts[0].match(/:(.*?);/)?.[1] || 'image/png';
  const byteString = atob(parts[1]);
  const arrayBuffer = new ArrayBuffer(byteString.length);
  const uint8Array = new Uint8Array(arrayBuffer);

  for (let i = 0; i < byteString.length; i += 1) {
    uint8Array[i] = byteString.charCodeAt(i);
  }

  return new Blob([arrayBuffer], { type: contentType });
}

function dataUrlToJpegBlob(dataUrl) {
  return dataUrlToBlob(dataUrl);
}

function getSafeEmailPathPart(email) {
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'student';
}

function getOrCreateDeviceId() {
  const storageKey = 'attendance_tracker_device_id';

  try {
    const existingDeviceId = window.localStorage.getItem(storageKey);

    if (existingDeviceId) {
      return existingDeviceId;
    }

    const newDeviceId =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    window.localStorage.setItem(storageKey, newDeviceId);
    return newDeviceId;
  } catch (error) {
    console.error('Device ID storage error:', error);
    return (
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  }
}

function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported by this browser.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => {
        reject(new Error('Location permission is required to submit attendance. Please allow location access and try again.'));
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      }
    );
  });
}

function isAttendanceLinkExpired(expiresAt) {
  if (!expiresAt) return false;

  const expirationTime = new Date(expiresAt).getTime();
  if (Number.isNaN(expirationTime)) return false;

  return Date.now() > expirationTime;
}

function formatDateTime(value) {
  if (!value) return 'N/A';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';

  return date.toLocaleString();
}

function formatTime(value) {
  if (!value) return 'Not provided';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not provided';

  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function AttendanceForm() {
  const { sessionId } = useParams();
  const canvasRef = useRef(null);
  const signaturePadRef = useRef(null);
  const videoRef = useRef(null);
  const photoCanvasRef = useRef(null);
  const mediaStreamRef = useRef(null);

  const [sessionDetails, setSessionDetails] = useState(null);
  const [isLoadingSession, setIsLoadingSession] = useState(Boolean(sessionId));
  const [sessionError, setSessionError] = useState('');
  const [studentName, setStudentName] = useState('');
  const [studentEmail, setStudentEmail] = useState('');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState('');
  const [photoBlob, setPhotoBlob] = useState(null);
  const isSessionExpired = isAttendanceLinkExpired(sessionDetails?.expires_at);
  const canSubmit =
    studentName.trim() &&
    studentEmail.trim() &&
    hasSignature &&
    photoBlob &&
    sessionId &&
    sessionDetails &&
    !isSessionExpired &&
    !isSubmitting;

  useEffect(() => {
    if (!sessionId || !sessionDetails || isSessionExpired) {
      return undefined;
    }

    const canvas = canvasRef.current;

    if (!canvas) {
      return undefined;
    }

    function getCanvasSize() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const parentWidth = canvas.parentElement?.offsetWidth || canvas.offsetWidth;

      return {
        height: Math.max(Math.floor(220 * ratio), 1),
        ratio,
        width: Math.max(Math.floor(parentWidth * ratio), 1),
      };
    }

    function resizeCanvas({ preserveSignature = false } = {}) {
      const { height, ratio, width } = getCanvasSize();

      if (canvas.width === width && canvas.height === height) {
        return;
      }

      const signaturePad = signaturePadRef.current;
      let savedSignature = null;

      if (
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
          setHasSignature(!signaturePad.isEmpty());
        } catch (error) {
          console.error('Signature resize restore error:', error);
          setHasSignature(false);
        }
      }
    }

    resizeCanvas();

    const signaturePad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });
    const handleSignatureEnd = () => setHasSignature(!signaturePad.isEmpty());

    signaturePadRef.current = signaturePad;
    signaturePad.addEventListener('endStroke', handleSignatureEnd);

    const handleResize = () => resizeCanvas({ preserveSignature: true });

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      signaturePad.removeEventListener('endStroke', handleSignatureEnd);
      signaturePad.off();
      signaturePadRef.current = null;
    };
  }, [sessionId, sessionDetails, isSessionExpired]);

  useEffect(() => {
    if (isCameraOpen && videoRef.current && mediaStreamRef.current) {
      videoRef.current.srcObject = mediaStreamRef.current;
      videoRef.current.play().catch(() => {
        setCameraError('Camera permission is required to submit attendance.');
      });
    }
  }, [isCameraOpen]);

  useEffect(() => {
    return () => {
      stopCamera(false);
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    async function loadSessionDetails() {
      if (!sessionId) {
        setSessionDetails(null);
        setIsLoadingSession(false);
        setSessionError('Invalid attendance link. Please use the link provided by your instructor.');
        return;
      }

      setIsLoadingSession(true);
      setSessionError('');

      const { data, error } = await supabase
        .from('training_sessions')
        .select('*')
        .eq('id', sessionId)
        .maybeSingle();

      if (!isActive) return;

      if (error) {
        console.error('Load training session error:', error);
        setSessionDetails(null);
        setSessionError('Invalid attendance link. Please use the link provided by your instructor.');
      } else if (!data) {
        setSessionDetails(null);
        setSessionError('Invalid attendance link. Please use the link provided by your instructor.');
      } else {
        setSessionDetails(data);
        setSessionError('');
      }

      setIsLoadingSession(false);
    }

    loadSessionDetails();

    return () => {
      isActive = false;
    };
  }, [sessionId]);

  function clearSignature() {
    signaturePadRef.current?.clear();
    setHasSignature(false);
  }

  function stopCamera(updateState = true) {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    if (updateState) {
      setIsCameraOpen(false);
    }
  }

  async function openCamera() {
    if (isSessionExpired) {
      setCameraError('This attendance link has expired. Please contact your instructor.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera permission is required to submit attendance.');
      return;
    }

    setCameraError('');

    try {
      stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });

      mediaStreamRef.current = stream;
      setPhotoDataUrl('');
      setPhotoBlob(null);
      setIsCameraOpen(true);
    } catch (error) {
      console.error('Camera permission error:', error);
      setCameraError('Camera permission is required to submit attendance.');
    }
  }

  async function capturePhoto() {
    if (isSessionExpired) {
      setCameraError('This attendance link has expired. Please contact your instructor.');
      return;
    }

    const video = videoRef.current;
    const canvas = photoCanvasRef.current;

    if (!video || !canvas) {
      setCameraError('Camera permission is required to submit attendance.');
      return;
    }

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
    const context = canvas.getContext('2d');

    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    setPhotoDataUrl(dataUrl);
    setPhotoBlob(dataUrlToJpegBlob(dataUrl));
    setCameraError('');
    stopCamera();
  }

  function retakePhoto() {
    setPhotoDataUrl('');
    setPhotoBlob(null);
    openCamera();
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (!sessionId || !sessionDetails) {
      setStatus('Invalid attendance link. Please use the link provided by your instructor.');
      return;
    }

    if (isAttendanceLinkExpired(sessionDetails.expires_at)) {
      setStatus('This attendance link has expired. Please contact your instructor.');
      return;
    }

    const cleanName = studentName.trim();
    const cleanEmail = studentEmail.trim().toLowerCase();

    if (!cleanName) {
      setStatus('Please enter your name.');
      return;
    }

    if (!cleanEmail) {
      setStatus('Please enter your email.');
      return;
    }

    if (!signaturePadRef.current || signaturePadRef.current.isEmpty()) {
      setStatus('Please sign before submitting.');
      return;
    }

    if (!photoBlob) {
      setStatus('Please take a photo before submitting.');
      return;
    }

    setIsSubmitting(true);

    try {
      const sessionCheck = await supabase
        .from('training_sessions')
        .select('expires_at')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionCheck.error) {
        throw sessionCheck.error;
      }

      if (!sessionCheck.data || isAttendanceLinkExpired(sessionCheck.data.expires_at)) {
        setSessionDetails((currentSessionDetails) => ({
          ...currentSessionDetails,
          expires_at: sessionCheck.data?.expires_at || currentSessionDetails?.expires_at,
        }));
        setStatus('This attendance link has expired. Please contact your instructor.');
        return;
      }

      setStatus('Requesting location permission...');

      const location = await getCurrentLocation();

      setStatus('Uploading signature...');

      const signatureDataUrl = signaturePadRef.current.toDataURL('image/png');
      const signatureBlob = dataUrlToBlob(signatureDataUrl);

      const fileName = `${Date.now()}-${crypto.randomUUID()}.png`;
      const signaturePath = `attendance/${fileName}`;

      const uploadResult = await supabase.storage
        .from('signatures')
        .upload(signaturePath, signatureBlob, {
          contentType: 'image/png',
          upsert: false,
        });

      if (uploadResult.error) {
        throw uploadResult.error;
      }

      setStatus('Uploading photo...');

      const photoPath = `${sessionId}/${getSafeEmailPathPart(cleanEmail)}_${Date.now()}.jpg`;
      const photoUploadResult = await supabase.storage
        .from('attendance-photos')
        .upload(photoPath, photoBlob, {
          contentType: 'image/jpeg',
          upsert: false,
        });

      if (photoUploadResult.error) {
        throw photoUploadResult.error;
      }

      setStatus('Saving attendance record...');

      const insertResult = await supabase.from('attendance_records').insert({
        training_session_id: sessionId,
        student_name: cleanName,
        student_email: cleanEmail,
        company: company.trim() || null,
        signature_path: signaturePath,
        photo_path: photoPath,
        device_id: getOrCreateDeviceId(),
        user_agent: navigator.userAgent || null,
        latitude: location.latitude,
        longitude: location.longitude,
        location_accuracy: location.accuracy,
        signed_at: new Date().toISOString(),
      });

      if (insertResult.error) {
        throw insertResult.error;
      }

      setStudentName('');
      setStudentEmail('');
      setCompany('');
      clearSignature();
      setPhotoDataUrl('');
      setPhotoBlob(null);
      stopCamera();

      setStatus('Attendance submitted successfully. 🎉 ✅');
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!sessionId || sessionError) {
    return (
      <section className="card invalid-attendance-link">
        <h2>Invalid Attendance Link</h2>
        <p>
          Invalid attendance link. Please use the link provided by your instructor.
        </p>
      </section>
    );
  }

  if (isLoadingSession) {
    return (
      <section className="card">
        <h2>Student Attendance Form</h2>
        <p className="status">Loading training session...</p>
      </section>
    );
  }

  if (isSessionExpired) {
    return (
      <section className="card expired-attendance-link" role="alert">
        <h2>Attendance Link Expired</h2>
        <p>This attendance link has expired. Please contact your instructor.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Student Attendance Form</h2>

      <dl className="attendance-session-details">
        <div>
          <dt>Course</dt>
          <dd>{sessionDetails.course_name}</dd>
        </div>

        <div>
          <dt>Training Date</dt>
          <dd>{sessionDetails.training_date}</dd>
        </div>

        <div>
          <dt>Trainer</dt>
          <dd>{sessionDetails.trainer_name}</dd>
        </div>

        <div>
          <dt>Company</dt>
          <dd>{sessionDetails.company_name || 'Not provided'}</dd>
        </div>

        <div>
          <dt>Location</dt>
          <dd>{sessionDetails.training_location || 'Not provided'}</dd>
        </div>

        <div>
          <dt>Start Time</dt>
          <dd>{formatTime(sessionDetails.time_started)}</dd>
        </div>

        <div>
          <dt>Class End Time</dt>
          <dd>{formatTime(sessionDetails.time_stopped)}</dd>
        </div>
      </dl>

      <p className="muted">
        Enter your name, email, sign, and submit. Your browser will ask for location permission.
      </p>

      <form onSubmit={handleSubmit} className="form">
        <label>
          Student Name
          <input
            type="text"
            value={studentName}
            onChange={(event) => setStudentName(event.target.value)}
            placeholder="Enter your full name"
          />
        </label>

        <label>
          Student Email
          <input
            type="email"
            value={studentEmail}
            onChange={(event) => setStudentEmail(event.target.value)}
            placeholder="Enter your email"
          />
        </label>

        <label>
        <span>
          Company <span className="optional-text">(optional)</span>
        </span>
        <input
          type="text"
          value={company}
          onChange={(event) => setCompany(event.target.value)}
          placeholder="Enter your company name"
        />
      </label>

        <div>
          <label>Signature</label>
          <div className="signature-box">
            <canvas ref={canvasRef} />
          </div>

          <button type="button" className="secondary-button" onClick={clearSignature}>
            Clear Signature
          </button>
        </div>

        <div>
          <label>Live Photo</label>

          <div className="camera-preview-box">
            {isCameraOpen && (
              <video
                ref={videoRef}
                className="camera-video"
                autoPlay
                playsInline
                muted
              />
            )}

            {!isCameraOpen && photoDataUrl && (
              <img
                src={photoDataUrl}
                alt="Captured attendance"
                className="captured-photo-preview"
              />
            )}

            {!isCameraOpen && !photoDataUrl && (
              <p className="camera-placeholder">Photo capture is required.</p>
            )}
          </div>

          <canvas ref={photoCanvasRef} className="photo-canvas" />

          <div className="camera-button-row">
            {!isCameraOpen && !photoDataUrl && (
              <button type="button" className="secondary-button" onClick={openCamera}>
                Open Camera
              </button>
            )}

            {isCameraOpen && (
              <>
                <button type="button" onClick={capturePhoto}>
                  Take Photo
                </button>

                <button type="button" className="secondary-button" onClick={stopCamera}>
                  Cancel
                </button>
              </>
            )}

            {!isCameraOpen && photoDataUrl && (
              <button type="button" className="secondary-button" onClick={retakePhoto}>
                Retake Photo
              </button>
            )}
          </div>

          {cameraError && <p className="photo-error">{cameraError}</p>}
        </div>

        <p className="location-note">
          Location permission is required to submit attendance. Please choose Allow when your browser asks.
        </p>

        <button type="submit" disabled={!canSubmit}>
          {isSubmitting ? 'Submitting...' : 'Submit Attendance'}
        </button>

        {status && <p className="status">{status}</p>}
      </form>
    </section>
  );
}
