import { useCallback, useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { supabase } from '../supabaseClient';

function formatDateTime(value) {
  if (!value) return 'N/A';

  return new Date(value).toLocaleString();
}

function formatTime(value) {
  if (!value) return 'N/A';

  return new Date(value).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatAccuracy(value) {
  return value ? `${Math.round(value)} meters` : 'N/A';
}

function getSessionValue(session, key) {
  return session?.[key] || 'N/A';
}

function getDownloadFileName(contentDisposition, fallbackName) {
  const match = contentDisposition?.match(/filename="?([^"]+)"?/i);
  return match?.[1] || fallbackName;
}

function isMissingStorageObjectError(error) {
  const message = String(error?.message || '').toLowerCase();
  const statusCode = String(error?.statusCode || error?.status || '');

  return (
    statusCode === '404' ||
    message.includes('not found') ||
    message.includes('does not exist')
  );
}

function cleanFileName(value, fallback = 'student-photo') {
  const cleaned = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || fallback;
}

function getClassArchivePdfFileName(session) {
  const courseName = cleanFileName(session?.course_name, 'training-session');
  const trainingDate = session?.training_date || new Date().toISOString().split('T')[0];

  return `${courseName}-class-archive-${trainingDate}.pdf`;
}

function isLocalHost() {
  return (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );
}

function getCertificatesUrl(sessionId) {
  if (isLocalHost()) {
    return `http://localhost:3001/api/certificates/session/${sessionId}`;
  }

  return `/.netlify/functions/certificates-session?sessionId=${sessionId}`;
}

function getWalletCardsUrl(sessionId) {
  if (isLocalHost()) {
    return `http://localhost:3001/api/wallet-cards/session/${sessionId}`;
  }

  return `/.netlify/functions/wallet-cards-session?sessionId=${sessionId}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function uploadPdfToSharePoint(doc, fileName) {
  const pdfBlob = doc.output('blob');
  const pdfBase64 = await blobToBase64(pdfBlob);
  const response = await fetch('/.netlify/functions/upload-class-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, pdfBase64 }),
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.success) {
    throw new Error(data?.error || 'SharePoint upload failed.');
  }

  return data;
}

function groupRecordsBySession(records) {
  const groupsById = new Map();
  const unassignedRecords = [];

  records.forEach((record) => {
    const session = record.training_sessions;

    if (!record.training_session_id || !session) {
      unassignedRecords.push(record);
      return;
    }

    if (!groupsById.has(record.training_session_id)) {
      groupsById.set(record.training_session_id, {
        id: record.training_session_id,
        session,
        records: [],
      });
    }

    groupsById.get(record.training_session_id).records.push(record);
  });

  const sessionGroups = Array.from(groupsById.values()).sort((a, b) => {
    const dateA = a.session?.training_date || '';
    const dateB = b.session?.training_date || '';
    return dateB.localeCompare(dateA);
  });

  if (unassignedRecords.length > 0) {
    sessionGroups.push({
      id: 'unassigned',
      session: null,
      records: unassignedRecords,
      title: 'Unassigned Attendance Records',
    });
  }

  return sessionGroups;
}

function SignaturePreview({ record, onError }) {
  const [signatureUrl, setSignatureUrl] = useState(record.signature_url || '');
  const [isLoading, setIsLoading] = useState(Boolean(record.signature_path));

  useEffect(() => {
    let isActive = true;

    async function loadSignatureUrl() {
      if (!record.signature_path) {
        setSignatureUrl(record.signature_url || '');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);

      const { data, error } = await supabase.storage
        .from('signatures')
        .createSignedUrl(record.signature_path, 300);

      if (!isActive) return;

      if (error || !data?.signedUrl) {
        console.error('Signature signed URL error:', error);
        setSignatureUrl(record.signature_url || '');
        setIsLoading(false);

        if (!record.signature_url) {
          onError('Unable to load student signature.');
        }

        return;
      }

      setSignatureUrl(data.signedUrl);
      setIsLoading(false);
    }

    loadSignatureUrl();

    return () => {
      isActive = false;
    };
  }, [record.signature_path, record.signature_url, onError]);

  if (isLoading) {
    return <span className="muted">Loading...</span>;
  }

  if (!signatureUrl) {
    return 'N/A';
  }

  return (
    <img
      src={signatureUrl}
      alt={`Signature for ${record.student_name}`}
      className="signature-preview"
    />
  );
}

function StudentPhotoThumbnail({ record, onOpen, onError }) {
  const [photoUrl, setPhotoUrl] = useState('');
  const [isLoading, setIsLoading] = useState(Boolean(record.photo_path));

  useEffect(() => {
    let isActive = true;

    async function loadPhotoUrl() {
      if (!record.photo_path) {
        setPhotoUrl('');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);

      const { data, error } = await supabase.storage
        .from('attendance-photos')
        .createSignedUrl(record.photo_path, 300);

      if (!isActive) return;

      if (error || !data?.signedUrl) {
        console.error('Photo signed URL error:', error);
        setPhotoUrl('');
        setIsLoading(false);
        onError('Unable to load student photo.');
        return;
      }

      setPhotoUrl(data.signedUrl);
      setIsLoading(false);
    }

    loadPhotoUrl();

    return () => {
      isActive = false;
    };
  }, [record.photo_path, onError]);

  if (!record.photo_path) {
    return 'N/A';
  }

  if (isLoading) {
    return <span className="muted">Loading...</span>;
  }

  if (!photoUrl) {
    return 'N/A';
  }

  const altText = `Photo for ${record.student_name}`;

  return (
    <button
      type="button"
      className="student-photo-button"
      onClick={() => onOpen(photoUrl, altText, record.student_name)}
      aria-label={`Open ${altText}`}
    >
      <img src={photoUrl} alt={altText} className="student-photo-thumbnail" />
    </button>
  );
}

export default function AdminRecords() {
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState('Loading records...');
  const [deletingId, setDeletingId] = useState(null);
  const [generatingCertificatesId, setGeneratingCertificatesId] = useState(null);
  const [generatingWalletCardsId, setGeneratingWalletCardsId] = useState(null);
  const [archivingClassId, setArchivingClassId] = useState(null);
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('');
  const [selectedPhotoAlt, setSelectedPhotoAlt] = useState('');
  const [selectedPhotoFileName, setSelectedPhotoFileName] = useState('');
  const [photoModalError, setPhotoModalError] = useState('');

  const groupedRecords = useMemo(() => groupRecordsBySession(records), [records]);
  const handleMediaLoadError = useCallback((message) => {
    setPhotoModalError(message);
    setStatus(message);
  }, []);

  function openPhotoModal(photoUrl, altText, studentName) {
    setPhotoModalError('');
    setSelectedPhotoUrl(photoUrl);
    setSelectedPhotoAlt(altText);
    setSelectedPhotoFileName(`${cleanFileName(studentName)}-photo.jpg`);
  }

  function closePhotoModal() {
    setSelectedPhotoUrl('');
    setSelectedPhotoAlt('');
    setSelectedPhotoFileName('');
    setPhotoModalError('');
  }

  async function downloadSelectedPhoto() {
    if (!selectedPhotoUrl) return;

    try {
      const response = await fetch(selectedPhotoUrl);

      if (!response.ok) {
        throw new Error('Photo download failed.');
      }

      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = objectUrl;
      link.download = selectedPhotoFileName || 'student-photo.jpg';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (error) {
      console.error('Photo download error:', error);
      setPhotoModalError('Unable to download student photo.');
      setStatus('Unable to download student photo.');
    }
  }

  async function loadRecords() {
    setStatus('Loading records...');
    setPhotoModalError('');

    const result = await supabase
      .from('attendance_records')
      .select(`
        *,
        training_sessions (*)
      `)
      .order('signed_at', { ascending: false });

    if (result.error) {
      console.error(result.error);
      setStatus(result.error.message);
      return;
    }

    setRecords(result.data || []);
    setStatus('');
  }

  async function deleteStorageFile(bucketName, filePath) {
    if (!filePath) return;

    const { error } = await supabase.storage
      .from(bucketName)
      .remove([filePath]);

    if (error && !isMissingStorageObjectError(error)) {
      throw error;
    }
  }

  async function deleteRecord(record) {
    const confirmed = window.confirm(
      `Delete attendance record for ${record.student_name}? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    setDeletingId(record.id);
    setStatus('');

    try {
      await deleteStorageFile('signatures', record.signature_path);
      await deleteStorageFile('attendance-photos', record.photo_path);

      const deleteResult = await supabase
        .from('attendance_records')
        .delete()
        .eq('id', record.id);

      if (deleteResult.error) {
        throw deleteResult.error;
      }

      setRecords((currentRecords) =>
        currentRecords.filter((currentRecord) => currentRecord.id !== record.id)
      );

      setStatus('Record and uploaded files deleted successfully.');
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Failed to delete record and uploaded files.');
    } finally {
      setDeletingId(null);
    }
  }

  async function downloadSessionCertificates(group) {
    if (group.id === 'unassigned') return;

    if (group.records.length === 0) {
      setStatus('No students found for this session.');
      return;
    }

    setStatus('');
    setGeneratingCertificatesId(group.id);

    try {
      const response = await fetch(getCertificatesUrl(group.id), {
        method: 'POST',
      });

      if (!response.ok) {
        const contentType = response.headers.get('Content-Type') || '';
        const errorData = contentType.includes('application/json')
          ? await response.json().catch(() => null)
          : null;

        throw new Error(
          errorData?.error ||
            'Certificate download failed. Please check Netlify function logs.'
        );
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const contentDisposition = response.headers.get('Content-Disposition');
      const fallbackFileName = 'certificates.zip';
      const link = document.createElement('a');

      link.href = url;
      link.download = getDownloadFileName(contentDisposition, fallbackFileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      const message =
        error instanceof TypeError
          ? 'Certificate download failed. Please check Netlify function logs.'
          : error.message || 'Failed to generate certificates.';

      setStatus(message);
    } finally {
      setGeneratingCertificatesId(null);
    }
  }

  async function downloadSessionWalletCards(group) {
    if (group.id === 'unassigned') return;

    if (group.records.length === 0) {
      setStatus('No students found for this session.');
      return;
    }

    setStatus('');
    setGeneratingWalletCardsId(group.id);

    try {
      const response = await fetch(getWalletCardsUrl(group.id), {
        method: 'POST',
      });

      if (!response.ok) {
        const contentType = response.headers.get('Content-Type') || '';
        const errorData = contentType.includes('application/json')
          ? await response.json().catch(() => null)
          : null;

        throw new Error(
          errorData?.error ||
            'Wallet card download failed. Please check Netlify function logs.'
        );
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const contentDisposition = response.headers.get('Content-Disposition');
      const fallbackFileName = 'wallet-cards.zip';
      const link = document.createElement('a');

      link.href = url;
      link.download = getDownloadFileName(contentDisposition, fallbackFileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      const message =
        error instanceof TypeError
          ? 'Wallet card download failed. Please check Netlify function logs.'
          : error.message || 'Failed to generate wallet cards.';

      setStatus(message);
    } finally {
      setGeneratingWalletCardsId(null);
    }
  }

  async function downloadArchiveImage(bucketName, filePath, fallbackUrl) {
    try {
      if (filePath) {
        const { data, error } = await supabase.storage
          .from(bucketName)
          .download(filePath);

        if (!error && data) {
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(data);
          });
        }
      }

      if (fallbackUrl) {
        const response = await fetch(fallbackUrl);

        if (response.ok) {
          const blob = await response.blob();

          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
      }
    } catch (error) {
      console.error(`${bucketName} archive image load error:`, error);
    }

    return null;
  }

  async function downloadClassArchivePdf(group) {
    if (group.id === 'unassigned' || !group.session) return;

    if (group.records.length === 0) {
      setStatus('No attendance records to archive.');
      return;
    }

    setStatus('');
    setArchivingClassId(group.id);

    try {
      const { session } = group;
      const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'pt',
        format: 'letter',
      });
      const generatedAt = new Date().toLocaleString();
      const tableRows = [];
      const tableImages = [];

      for (const record of group.records) {
        const photoImage = await downloadArchiveImage(
          'attendance-photos',
          record.photo_path
        );
        const signatureImage = await downloadArchiveImage(
          'signatures',
          record.signature_path,
          record.signature_url
        );

        tableImages.push({ photoImage, signatureImage });
        tableRows.push([
          record.student_name || '',
          record.student_email || '',
          record.company || 'N/A',
          formatDateTime(record.signed_at),
          record.latitude ?? 'N/A',
          record.longitude ?? 'N/A',
          formatAccuracy(record.location_accuracy),
          photoImage ? '' : 'N/A',
          signatureImage ? '' : 'N/A',
          record.is_suspicious ? 'Yes' : 'No',
          record.suspicious_reason || '',
          record.device_id || '',
          record.user_agent || '',
        ]);
      }
      const classInfoRows = [
        ['Course Name', session.course_name || 'N/A'],
        ['Training Date', session.training_date || 'N/A'],
        ['Time Started', formatDateTime(session.time_started)],
        ['Class End Time', formatDateTime(session.time_stopped)],
        ['Attendance Link Expires At', formatDateTime(session.expires_at)],
        ['Trainer Name', session.trainer_name || 'N/A'],
        ['Company Name', session.company_name || 'N/A'],
        ['Training Location', session.training_location || 'N/A'],
        ['Course Outline', session.course_outline || 'N/A'],
        ['Total Students Attended', String(group.records.length)],
        ['Generated At', generatedAt],
      ];

      doc.setTextColor('#036f5e');
      doc.setFontSize(20);
      doc.setFont(undefined, 'bold');
      doc.text('Attendance Class Archive', 40, 42);

      doc.setTextColor('#111827');
      doc.setFontSize(10);
      doc.setFont(undefined, 'normal');
      doc.text(`Generated date/time: ${generatedAt}`, 40, 64);
      doc.text(`Total number of records: ${group.records.length}`, 40, 80);

      autoTable(doc, {
        startY: 100,
        head: [['Class Information', '']],
        body: classInfoRows,
        theme: 'grid',
        headStyles: {
          fillColor: '#036f5e',
          textColor: '#ffffff',
          fontStyle: 'bold',
        },
        styles: {
          fontSize: 8,
          cellPadding: 4,
          overflow: 'linebreak',
          valign: 'middle',
        },
        columnStyles: {
          0: { cellWidth: 170, fontStyle: 'bold' },
          1: { cellWidth: 555 },
        },
        margin: { left: 40, right: 40 },
      });

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 18,
        head: [[
          'Student Name',
          'Student Email',
          'Company',
          'Signed Date/Time',
          'Latitude',
          'Longitude',
          'Location Accuracy',
          'Student Photo',
          'Signature',
          'Possible Duplicate Device',
          'Suspicious Reason',
          'Device ID',
          'User Agent',
        ]],
        body: tableRows,
        theme: 'grid',
        headStyles: {
          fillColor: '#036f5e',
          textColor: '#ffffff',
          fontStyle: 'bold',
        },
        styles: {
          fontSize: 5.6,
          cellPadding: 3,
          overflow: 'linebreak',
          valign: 'middle',
          minCellHeight: 44,
        },
        columnStyles: {
          0: { cellWidth: 55 },
          1: { cellWidth: 75 },
          2: { cellWidth: 45 },
          3: { cellWidth: 65 },
          4: { cellWidth: 47 },
          5: { cellWidth: 47 },
          6: { cellWidth: 45 },
          7: { cellWidth: 45 },
          8: { cellWidth: 55 },
          9: { cellWidth: 45 },
          10: { cellWidth: 55 },
          11: { cellWidth: 45 },
          12: { cellWidth: 88 },
        },
        didDrawCell: (data) => {
          if (data.section !== 'body') return;

          const media = tableImages[data.row.index];

          if (data.column.index === 7 && media?.photoImage) {
            doc.addImage(
              media.photoImage,
              data.cell.x + 6,
              data.cell.y + 5,
              34,
              34
            );
          }

          if (data.column.index === 8 && media?.signatureImage) {
            doc.addImage(
              media.signatureImage,
              data.cell.x + 4,
              data.cell.y + 10,
              48,
              24
            );
          }
        },
        margin: { left: 40, right: 40 },
      });

      const fileName = getClassArchivePdfFileName(session);

      try {
        await uploadPdfToSharePoint(doc, fileName);
        alert('Class PDF archived to SharePoint.');
      } catch (error) {
        console.error(error);
        alert('SharePoint upload failed. The PDF will download instead.');
        doc.save(fileName);
      }
    } catch (error) {
      console.error('Class archive PDF generation error:', error);
      setStatus(error.message || 'Failed to generate class archive.');
    } finally {
      setArchivingClassId(null);
    }
  }

  useEffect(() => {
    loadRecords();
  }, []);

  return (
    <section className="card">
      <div className="admin-header">
        <div>
          <h2>Admin Attendance Records</h2>
          <p className="muted">View submitted student attendance records.</p>
        </div>

        <div className="admin-actions">
          <button type="button" className="secondary-button" onClick={loadRecords}>
            Refresh
          </button>
        </div>
      </div>

      {(status || photoModalError) && (
        <p className="status">{status || photoModalError}</p>
      )}

      {!status && records.length === 0 && (
        <p className="muted">No attendance records found yet.</p>
      )}

      {groupedRecords.length > 0 && (
        <div className="session-records-list">
          {groupedRecords.map((group) => (
            <section className="session-record-card" key={group.id}>
              <div className="session-record-top-row">
                <h3>{group.title || getSessionValue(group.session, 'course_name')}</h3>

                <div className="session-card-actions">
                  {group.id !== 'unassigned' && (
                    <>
                      <button
                        type="button"
                        className="secondary-button session-action-button"
                        onClick={() => downloadSessionCertificates(group)}
                        disabled={
                          group.records.length === 0 ||
                          generatingCertificatesId === group.id
                        }
                      >
                        {generatingCertificatesId === group.id
                          ? 'Generating certificates...'
                          : 'Download Certificates'}
                      </button>

                      <button
                        type="button"
                        className="secondary-button session-action-button"
                        onClick={() => downloadSessionWalletCards(group)}
                        disabled={
                          group.records.length === 0 ||
                          generatingWalletCardsId === group.id
                        }
                      >
                        {generatingWalletCardsId === group.id
                          ? 'Generating wallet cards...'
                          : 'Download Wallet Cards'}
                      </button>

                      <button
                        type="button"
                        className="secondary-button session-action-button archive-class-button"
                        onClick={() => downloadClassArchivePdf(group)}
                        disabled={archivingClassId === group.id}
                      >
                        {archivingClassId === group.id
                          ? 'Archiving...'
                          : 'Archive Class PDF'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <dl className="session-meta">
                <div>
                  <dt>Training Date</dt>
                  <dd>{getSessionValue(group.session, 'training_date')}</dd>
                </div>

                <div>
                  <dt>Trainer</dt>
                  <dd>{getSessionValue(group.session, 'trainer_name')}</dd>
                </div>

                <div>
                  <dt>Company</dt>
                  <dd>{getSessionValue(group.session, 'company_name')}</dd>
                </div>

                <div>
                  <dt>Location</dt>
                  <dd>{getSessionValue(group.session, 'training_location')}</dd>
                </div>

                <div>
                  <dt>Time Started</dt>
                  <dd>{formatTime(group.session?.time_started)}</dd>
                </div>

                <div>
                  <dt>Class End Time</dt>
                  <dd>{formatTime(group.session?.time_stopped)}</dd>
                </div>

                <div>
                  <dt>Expires At</dt>
                  <dd>{formatDateTime(group.session?.expires_at)}</dd>
                </div>

                <div>
                  <dt>Total Students</dt>
                  <dd>{group.records.length}</dd>
                </div>
              </dl>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Student Name</th>
                      <th>Email</th>
                      <th>Company</th>
                      <th>Signed Date/Time</th>
                      <th>Latitude</th>
                      <th>Longitude</th>
                      <th>Accuracy</th>
                      <th>Signature</th>
                      <th>Photo</th>
                      <th>Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {group.records.map((record) => (
                      <tr key={record.id}>
                        <td>
                          <div>{record.student_name}</div>

                          {record.is_suspicious && (
                            <div className="suspicious-warning">
                              <span className="suspicious-icon" aria-hidden="true">
                                ⚠
                              </span>

                              <div className="suspicious-copy">
                                <div className="suspicious-title">
                                  Duplicate device
                                </div>

                                <div className="suspicious-reason">
                                  {record.suspicious_reason ||
                                    'Same device already submitted for another student in this session'}
                                </div>
                              </div>
                            </div>
                          )}
                        </td>
                        <td>{record.student_email}</td>
                        <td>{record.company || 'N/A'}</td>
                        <td>{formatDateTime(record.signed_at)}</td>
                        <td>{record.latitude}</td>
                        <td>{record.longitude}</td>
                        <td>{formatAccuracy(record.location_accuracy)}</td>
                        <td>
                          <SignaturePreview
                            record={record}
                            onError={handleMediaLoadError}
                          />
                        </td>
                        <td>
                          <StudentPhotoThumbnail
                            record={record}
                            onOpen={openPhotoModal}
                            onError={handleMediaLoadError}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="delete-button"
                            onClick={() => deleteRecord(record)}
                            disabled={deletingId === record.id}
                          >
                            {deletingId === record.id ? 'Deleting...' : 'Delete'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {selectedPhotoUrl && (
        <div
          className="photo-modal-overlay"
          onClick={closePhotoModal}
          role="presentation"
        >
          <div className="photo-modal" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="photo-modal-close"
              onClick={closePhotoModal}
              aria-label="Close photo"
            >
              X
            </button>

            <img
              src={selectedPhotoUrl}
              alt={selectedPhotoAlt}
              className="photo-modal-image"
            />

            <div className="photo-modal-actions">
              <button type="button" onClick={downloadSelectedPhoto}>
                Download Photo
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
