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
      reject(new Error('Geolocation is not supported by this browser. / Este navegador no permite compartir la ubicacion.'));
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
        reject(new Error('Location permission is required to submit attendance. Please allow location access and try again. / Se requiere permiso de ubicacion para enviar la asistencia. Permita el acceso a la ubicacion e intentelo de nuevo.'));
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

function formatTime(value) {
  if (!value) return 'Not provided / No proporcionado';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not provided / No proporcionado';

  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function AttendanceForm() {
  const { sessionId } = useParams();
  const canvasRef = useRef(null);
  const signaturePadRef = useRef(null);
  const acceptedSignatureDataRef = useRef(null);
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
  const [isSignatureAccepted, setIsSignatureAccepted] = useState(false);
  const [acceptedSignatureDataUrl, setAcceptedSignatureDataUrl] = useState('');
  const [signatureMessage, setSignatureMessage] = useState('');
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState('');
  const [photoBlob, setPhotoBlob] = useState(null);
  const isSessionExpired = isAttendanceLinkExpired(sessionDetails?.expires_at);
  const canSubmit =
    studentName.trim() &&
    studentEmail.trim() &&
    isSignatureAccepted &&
    acceptedSignatureDataUrl &&
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

      if (acceptedSignatureDataRef.current?.length) {
        savedSignature = acceptedSignatureDataRef.current;
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
    const handleSignatureEnd = () => {
      setHasSignature(!signaturePad.isEmpty());
      setIsSignatureAccepted(false);
      setAcceptedSignatureDataUrl('');
      acceptedSignatureDataRef.current = null;
      setSignatureMessage('');
    };

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
        setCameraError('Camera permission is required to submit attendance. / Se requiere permiso de camara para enviar la asistencia.');
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
        setSessionError('Invalid attendance link. Please use the link provided by your instructor. / Enlace de asistencia no valido. Use el enlace proporcionado por su instructor.');
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
        setSessionError('Invalid attendance link. Please use the link provided by your instructor. / Enlace de asistencia no valido. Use el enlace proporcionado por su instructor.');
      } else if (!data) {
        setSessionDetails(null);
        setSessionError('Invalid attendance link. Please use the link provided by your instructor. / Enlace de asistencia no valido. Use el enlace proporcionado por su instructor.');
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
    signaturePadRef.current?.on();
    acceptedSignatureDataRef.current = null;
    setHasSignature(false);
    setIsSignatureAccepted(false);
    setAcceptedSignatureDataUrl('');
    setSignatureMessage('');
  }

  function acceptSignature() {
    const signaturePad = signaturePadRef.current;

    if (!signaturePad || signaturePad.isEmpty()) {
      setSignatureMessage('Please sign before accepting. / Firme antes de aceptar.');
      setIsSignatureAccepted(false);
      return;
    }

    acceptedSignatureDataRef.current = signaturePad.toData();
    setAcceptedSignatureDataUrl(signaturePad.toDataURL('image/png'));
    setHasSignature(true);
    setIsSignatureAccepted(true);
    setSignatureMessage('Signature accepted. / Firma aceptada.');
    signaturePad.off();
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
      setCameraError('This attendance link has expired. Please contact your instructor. / Este enlace de asistencia ha vencido. Comuniquese con su instructor.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera permission is required to submit attendance. / Se requiere permiso de camara para enviar la asistencia.');
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
      setCameraError('Camera permission is required to submit attendance. / Se requiere permiso de camara para enviar la asistencia.');
    }
  }

  async function capturePhoto() {
    if (isSessionExpired) {
      setCameraError('This attendance link has expired. Please contact your instructor. / Este enlace de asistencia ha vencido. Comuniquese con su instructor.');
      return;
    }

    const video = videoRef.current;
    const canvas = photoCanvasRef.current;

    if (!video || !canvas) {
      setCameraError('Camera permission is required to submit attendance. / Se requiere permiso de camara para enviar la asistencia.');
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
      setStatus('Invalid attendance link. Please use the link provided by your instructor. / Enlace de asistencia no valido. Use el enlace proporcionado por su instructor.');
      return;
    }

    if (isAttendanceLinkExpired(sessionDetails.expires_at)) {
      setStatus('This attendance link has expired. Please contact your instructor. / Este enlace de asistencia ha vencido. Comuniquese con su instructor.');
      return;
    }

    const cleanName = studentName.trim();
    const cleanEmail = studentEmail.trim().toLowerCase();

    if (!cleanName) {
      setStatus('Please enter your name. / Ingrese su nombre.');
      return;
    }

    if (!cleanEmail) {
      setStatus('Please enter your email. / Ingrese su correo electronico.');
      return;
    }

    if (!isSignatureAccepted || !acceptedSignatureDataUrl) {
      setStatus('Please accept your signature before submitting. / Acepte su firma antes de enviar.');
      return;
    }

    if (!photoBlob) {
      setStatus('Please take a photo before submitting. / Tome una foto antes de enviar.');
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
        setStatus('This attendance link has expired. Please contact your instructor. / Este enlace de asistencia ha vencido. Comuniquese con su instructor.');
        return;
      }

      setStatus('Requesting location permission... / Solicitando permiso de ubicacion...');

      const location = await getCurrentLocation();

      setStatus('Uploading signature... / Subiendo firma...');

      const signatureBlob = dataUrlToBlob(acceptedSignatureDataUrl);

      const fileName = `${Date.now()}-${crypto.randomUUID()}.png`;
      const signaturePath = `attendance/${fileName}`;

      const uploadResult = await supabase.storage
        .from('signatures')
        .upload(signaturePath, signatureBlob, {
          contentType: 'image/png',
          upsert: false,
        });

      if (uploadResult.error) {
        throw new Error(
          `Unable to upload attendance signature: ${uploadResult.error.message}`
        );
      }

      setStatus('Uploading photo... / Subiendo foto...');

      const photoPath = `${sessionId}/${getSafeEmailPathPart(cleanEmail)}_${Date.now()}.jpg`;
      const photoUploadResult = await supabase.storage
        .from('attendance-photos')
        .upload(photoPath, photoBlob, {
          contentType: 'image/jpeg',
          upsert: false,
        });

      if (photoUploadResult.error) {
        throw new Error(
          `Unable to upload attendance photo: ${photoUploadResult.error.message}`
        );
      }

      setStatus('Saving attendance record... / Guardando registro de asistencia...');

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
        throw new Error(
          `Unable to save attendance record: ${insertResult.error.message}`
        );
      }

      setStudentName('');
      setStudentEmail('');
      setCompany('');
      clearSignature();
      setPhotoDataUrl('');
      setPhotoBlob(null);
      stopCamera();

      setStatus('Attendance submitted successfully. / Asistencia enviada correctamente.');
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Something went wrong. Please try again. / Algo salio mal. Intentelo de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!sessionId || sessionError) {
    return (
      <section className="card invalid-attendance-link">
        <h2>Invalid Attendance Link / Enlace de asistencia no valido</h2>
        <p>
          Invalid attendance link. Please use the link provided by your instructor. / Enlace de asistencia no valido. Use el enlace proporcionado por su instructor.
        </p>
      </section>
    );
  }

  if (isLoadingSession) {
    return (
      <section className="card">
        <h2>Student Attendance Form / Formulario de asistencia del estudiante</h2>
        <p className="status">Loading training session... / Cargando sesion de capacitacion...</p>
      </section>
    );
  }

  if (isSessionExpired) {
    return (
      <section className="card expired-attendance-link" role="alert">
        <h2>Attendance Link Expired / El enlace de asistencia ha vencido</h2>
        <p>This attendance link has expired. Please contact your instructor. / Este enlace de asistencia ha vencido. Comuniquese con su instructor.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Student Attendance Form / Formulario de asistencia del estudiante</h2>

      <dl className="attendance-session-details">
        <div>
          <dt>Course / Curso</dt>
          <dd>{sessionDetails.course_name}</dd>
        </div>

        <div>
          <dt>Training Date / Fecha de capacitacion</dt>
          <dd>{sessionDetails.training_date}</dd>
        </div>

        <div>
          <dt>Trainer / Instructor</dt>
          <dd>{sessionDetails.trainer_name}</dd>
        </div>

        <div>
          <dt>Company / Compania</dt>
          <dd>{sessionDetails.company_name || 'Not provided / No proporcionado'}</dd>
        </div>

        <div>
          <dt>Location / Ubicacion</dt>
          <dd>{sessionDetails.training_location || 'Not provided / No proporcionado'}</dd>
        </div>

        <div>
          <dt>Start Time / Hora de inicio</dt>
          <dd>{formatTime(sessionDetails.time_started)}</dd>
        </div>

        <div>
          <dt>Class End Time / Hora de finalizacion</dt>
          <dd>{formatTime(sessionDetails.time_stopped)}</dd>
        </div>
      </dl>

      <p className="muted">
        Enter your name, email, sign, and submit. Your browser will ask for location permission. / Ingrese su nombre y correo electronico, firme y envie. Su navegador le pedira permiso de ubicacion.
      </p>

      <form onSubmit={handleSubmit} className="form">
        <label>
          Student Name / Nombre del estudiante
          <input
            type="text"
            value={studentName}
            onChange={(event) => setStudentName(event.target.value)}
            placeholder="Enter your full name / Ingrese su nombre completo"
          />
        </label>

        <label>
          Student Email / Correo electronico del estudiante
          <input
            type="email"
            value={studentEmail}
            onChange={(event) => setStudentEmail(event.target.value)}
            placeholder="Enter your email / Ingrese su correo electronico"
          />
        </label>

        <label>
        <span>
          Company / Compania <span className="optional-text">(optional / opcional)</span>
        </span>
        <input
          type="text"
          value={company}
          onChange={(event) => setCompany(event.target.value)}
          placeholder="Enter your company name / Ingrese el nombre de su compania"
        />
      </label>

        <div>
          <label>Signature / Firma</label>
          <div className={`signature-box${isSignatureAccepted ? ' signature-box-accepted' : ''}`}>
            <canvas ref={canvasRef} />
          </div>

          <div className="signature-action-row">
            <button type="button" onClick={acceptSignature}>
              Accept Signature / Aceptar firma
            </button>

            <button
              type="button"
              className="secondary-button danger-secondary-button"
              onClick={clearSignature}
              disabled={!hasSignature && !isSignatureAccepted}
            >
              Remove Signature / Eliminar firma
            </button>
          </div>

          {signatureMessage && (
            <p className={isSignatureAccepted ? 'signature-status' : 'signature-error'}>
              {signatureMessage}
            </p>
          )}
        </div>

        <div>
          <label>Live Photo / Foto en vivo</label>

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
                alt="Captured attendance / Foto de asistencia capturada"
                className="captured-photo-preview"
              />
            )}

            {!isCameraOpen && !photoDataUrl && (
              <p className="camera-placeholder">Photo capture is required. / Se requiere tomar una foto.</p>
            )}
          </div>

          <canvas ref={photoCanvasRef} className="photo-canvas" />

          <div className="camera-button-row">
            {!isCameraOpen && !photoDataUrl && (
              <button type="button" className="secondary-button" onClick={openCamera}>
                Open Camera / Abrir camara
              </button>
            )}

            {isCameraOpen && (
              <>
                <button type="button" onClick={capturePhoto}>
                  Take Photo / Tomar foto
                </button>

                <button type="button" className="secondary-button" onClick={stopCamera}>
                  Cancel / Cancelar
                </button>
              </>
            )}

            {!isCameraOpen && photoDataUrl && (
              <button type="button" className="secondary-button" onClick={retakePhoto}>
                Retake Photo / Tomar otra foto
              </button>
            )}
          </div>

          {cameraError && <p className="photo-error">{cameraError}</p>}
        </div>

        <p className="location-note">
          Location permission is required to submit attendance. Please choose Allow when your browser asks. / Se requiere permiso de ubicacion para enviar la asistencia. Elija Permitir cuando su navegador lo solicite.
        </p>

        <button type="submit" disabled={!canSubmit}>
          {isSubmitting ? 'Submitting... / Enviando...' : 'Submit Attendance / Enviar asistencia'}
        </button>

        {status && <p className="status">{status}</p>}
      </form>
    </section>
  );
}
