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

export default function AttendanceForm() {
  const { sessionId } = useParams();
  const canvasRef = useRef(null);
  const signaturePadRef = useRef(null);

  const [studentName, setStudentName] = useState('');
  const [studentEmail, setStudentEmail] = useState('');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;

    function resizeCanvas() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const parentWidth = canvas.parentElement.offsetWidth;

      canvas.width = parentWidth * ratio;
      canvas.height = 220 * ratio;
      canvas.getContext('2d').scale(ratio, ratio);
    }

    resizeCanvas();

    signaturePadRef.current = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });

    window.addEventListener('resize', resizeCanvas);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      signaturePadRef.current?.off();
    };
  }, []);

  function clearSignature() {
    signaturePadRef.current.clear();
  }

  async function handleSubmit(event) {
    event.preventDefault();

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

    setIsSubmitting(true);

    try {
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

      const publicUrlResult = supabase.storage
        .from('signatures')
        .getPublicUrl(signaturePath);

      const signatureUrl = publicUrlResult.data.publicUrl;

      setStatus('Saving attendance record...');

      const insertResult = await supabase.from('attendance_records').insert({
        training_session_id: sessionId || null,
        student_name: cleanName,
        student_email: cleanEmail,
        company: company.trim() || null,
        signature_path: signaturePath,
        signature_url: signatureUrl,
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

      setStatus('Attendance submitted successfully.');
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="card">
      <h2>Student Attendance Form</h2>
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

        <p className="location-note">
          Location permission is required to submit attendance. Please choose Allow when your browser asks.
        </p>

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Submitting...' : 'Submit Attendance'}
        </button>

        {status && <p className="status">{status}</p>}
      </form>
    </section>
  );
}
