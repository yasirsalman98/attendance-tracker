import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import './Quiz.css';

function formatDateTime(value) {
  if (!value) return 'Never';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';

  return date.toLocaleString();
}

async function readFunctionResponse(response, fallbackMessage) {
  const responseText = await response.text();
  let data = null;
  const readableResponseText =
    responseText && responseText.trim().startsWith('<')
      ? `${fallbackMessage} (${response.status} ${response.statusText})`
      : responseText;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errorMessage =
      data?.error ||
      readableResponseText ||
      `${fallbackMessage} (${response.status} ${response.statusText})`;

    throw new Error(errorMessage);
  }

  return data;
}

function getDefaultAttendanceCompany(companies) {
  return companies[0] || '';
}

function formatImportedCounts(data) {
  const importedParts = [];

  if (data?.importedQuizCount) {
    importedParts.push(`${data.importedQuizCount} saved quizzes`);
  }

  if (data?.importedSavedResultCount) {
    importedParts.push(`${data.importedSavedResultCount} saved quiz results`);
  }

  return importedParts.length ? `${importedParts.join(' and ')} imported.` : '';
}

export default function Settings() {
  const [users, setUsers] = useState([]);
  const [attendanceCompanies, setAttendanceCompanies] = useState([]);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pendingAddUser, setPendingAddUser] = useState(null);
  const [importOptions, setImportOptions] = useState({
    none: true,
    attendanceRecords: false,
    walletCards: false,
    certificateTemplate: false,
    quizzes: false,
    savedQuizResults: false,
  });
  const [templateDesigns, setTemplateDesigns] = useState({
    walletCardDesign: 'excourse',
    walletFront: 'same',
    walletBack: 'same',
    certificateTemplate: 'same',
    certificateDesign: 'excourse',
    attendanceRecordsCompany: '',
    savedQuizLibraryCompany: '',
    savedQuizResultsCompany: '',
  });
  const [currentUserId, setCurrentUserId] = useState('');
  const [status, setStatus] = useState('Loading emails...');
  const [errorMessage, setErrorMessage] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [resettingUserId, setResettingUserId] = useState('');
  const [resetTargetUser, setResetTargetUser] = useState(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordError, setResetPasswordError] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState('');
  const [deleteTargetUser, setDeleteTargetUser] = useState(null);
  const [featureTargetUser, setFeatureTargetUser] = useState(null);
  const [featureOptions, setFeatureOptions] = useState({
    attendanceRecords: false,
    walletCards: false,
    certificateTemplate: false,
    quizzes: false,
    savedQuizResults: false,
  });
  const [featureTemplateDesigns, setFeatureTemplateDesigns] = useState({
    walletCardDesign: 'excourse',
    walletFront: 'same',
    walletBack: 'same',
    certificateTemplate: 'same',
    certificateDesign: 'excourse',
    attendanceRecordsCompany: '',
    savedQuizLibraryCompany: '',
    savedQuizResultsCompany: '',
  });
  const [isUpdatingFeatures, setIsUpdatingFeatures] = useState(false);

  async function getAccessToken() {
    const { data, error } = await supabase.auth.getSession();

    if (error || !data?.session?.access_token) {
      throw new Error('Please sign in again.');
    }

    setCurrentUserId(data.session.user.id);
    return data.session.access_token;
  }

  async function loadUsers() {
    setErrorMessage('');
    setStatus('Loading emails...');

    try {
      const accessToken = await getAccessToken();
      const response = await fetch('/.netlify/functions/instructor-users', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const data = await readFunctionResponse(response, 'Unable to load emails.');

      setUsers(data?.users || []);
      setAttendanceCompanies(data?.attendanceCompanies || []);
      setStatus(data?.users?.length ? '' : 'No emails found.');
    } catch (error) {
      console.error('Load instructor users error:', error);
      setUsers([]);
      setStatus('');
      setErrorMessage(error?.message || 'Unable to load emails.');
    }
  }

  async function addUser(event) {
    event.preventDefault();

    const cleanEmail = newEmail.trim().toLowerCase();

    if (!cleanEmail) {
      setErrorMessage('Email is required.');
      return;
    }

    if (newPassword.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }

    setPendingAddUser({ email: cleanEmail, password: newPassword });
    setImportOptions({
      none: true,
      attendanceRecords: false,
      walletCards: false,
      certificateTemplate: false,
      quizzes: false,
      savedQuizResults: false,
    });
    setTemplateDesigns({
      walletCardDesign: 'excourse',
      walletFront: 'same',
      walletBack: 'same',
      certificateTemplate: 'same',
      certificateDesign: 'excourse',
      attendanceRecordsCompany: getDefaultAttendanceCompany(attendanceCompanies),
      savedQuizLibraryCompany: getDefaultAttendanceCompany(attendanceCompanies),
      savedQuizResultsCompany: getDefaultAttendanceCompany(attendanceCompanies),
    });
  }

  async function confirmAddUser() {
    if (!pendingAddUser) return;

    setIsAdding(true);
    setErrorMessage('');
    setStatus('');

    try {
      const nextTemplateDesigns = {
        ...templateDesigns,
        walletCards: 'same',
        walletFront: 'same',
        walletBack: 'same',
        certificateTemplate: 'same',
      };

      if (importOptions.attendanceRecords && !nextTemplateDesigns.attendanceRecordsCompany) {
        throw new Error('Choose an attendance records company.');
      }

      if (importOptions.quizzes && !nextTemplateDesigns.savedQuizLibraryCompany) {
        throw new Error('Choose a saved quiz library company.');
      }

      if (
        importOptions.savedQuizResults &&
        !nextTemplateDesigns.savedQuizResultsCompany
      ) {
        throw new Error('Choose a saved quiz results company.');
      }

      const templateUploads = {
        certificateTemplate: null,
        walletCards: null,
      };
      const accessToken = await getAccessToken();
      const response = await fetch('/.netlify/functions/instructor-users', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: pendingAddUser.email,
          password: pendingAddUser.password,
          importOptions,
          templateDesigns: nextTemplateDesigns,
          templateUploads,
        }),
      });
      const data = await readFunctionResponse(response, 'Unable to add email.');

      setNewEmail('');
      setNewPassword('');
      setPendingAddUser(null);
      setUsers(data?.users || []);
      setAttendanceCompanies(data?.attendanceCompanies || attendanceCompanies);
      const importedMessage = formatImportedCounts(data);
      setStatus(
        importedMessage
          ? `Email added. ${importedMessage}`
          : 'Email added. The user can now log in with the password you set.'
      );
    } catch (error) {
      console.error('Add instructor user error:', error);
      setErrorMessage(error?.message || 'Unable to add email.');
    } finally {
      setIsAdding(false);
    }
  }

  function openResetPassword(user) {
    setResetTargetUser(user);
    setResetPasswordValue('');
    setResetPasswordError('');
    setShowResetPassword(false);
    setErrorMessage('');
    setStatus('');
  }

  async function resetPassword() {
    if (!resetTargetUser?.email) return;

    if (resetPasswordValue.length < 6) {
      setResetPasswordError('New password must be at least 6 characters.');
      return;
    }

    setIsResettingPassword(true);
    setResettingUserId(resetTargetUser.id);
    setResetPasswordError('');
    setErrorMessage('');
    setStatus('');

    try {
      const accessToken = await getAccessToken();
      const response = await fetch('/.netlify/functions/instructor-users', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: resetTargetUser.email,
          password: resetPasswordValue,
        }),
      });
      const data = await readFunctionResponse(response, 'Unable to reset password.');

      setUsers(data?.users || []);
      setAttendanceCompanies(data?.attendanceCompanies || attendanceCompanies);
      setResetPasswordValue('');
      setResetTargetUser(null);
      setStatus('Password reset.');
    } catch (error) {
      console.error('Reset instructor password error:', error);
      setResetPasswordError(error?.message || 'Unable to reset password.');
    } finally {
      setIsResettingPassword(false);
      setResettingUserId('');
    }
  }

  function openFeatureSettings(user) {
    setFeatureTargetUser(user);
    setFeatureOptions({
      attendanceRecords: Boolean(user.imported_assets?.attendanceRecords),
      walletCards: Boolean(user.imported_assets?.walletCards),
      certificateTemplate: Boolean(user.imported_assets?.certificateTemplate),
      quizzes: Boolean(user.imported_assets?.quizzes),
      savedQuizResults: Boolean(user.imported_assets?.savedQuizResults),
    });
    setFeatureTemplateDesigns({
      walletCardDesign: user.template_designs?.walletCardDesign || 'excourse',
      walletFront:
        user.template_designs?.walletFront ||
        user.template_designs?.walletCards ||
        'same',
      walletBack:
        user.template_designs?.walletBack ||
        user.template_designs?.walletCards ||
        'same',
      certificateTemplate: user.template_designs?.certificateTemplate || 'same',
      certificateDesign: user.template_designs?.certificateDesign || 'excourse',
      attendanceRecordsCompany:
        user.template_designs?.attendanceRecordsCompany ||
        getDefaultAttendanceCompany(attendanceCompanies),
      savedQuizLibraryCompany:
        user.template_designs?.savedQuizLibraryCompany ||
        user.template_designs?.attendanceRecordsCompany ||
        getDefaultAttendanceCompany(attendanceCompanies),
      savedQuizResultsCompany:
        user.template_designs?.savedQuizResultsCompany ||
        user.template_designs?.attendanceRecordsCompany ||
        getDefaultAttendanceCompany(attendanceCompanies),
    });
    setErrorMessage('');
    setStatus('');
  }

  function updateFeatureOption(optionName, checked) {
    setFeatureOptions((currentOptions) => ({
      walletCards:
        optionName === 'none'
          ? false
          : optionName === 'walletCards'
            ? checked
            : currentOptions.walletCards,
      attendanceRecords:
        optionName === 'none'
          ? false
          : optionName === 'attendanceRecords'
            ? checked
            : currentOptions.attendanceRecords,
      certificateTemplate:
        optionName === 'none'
          ? false
          : optionName === 'certificateTemplate'
            ? checked
            : currentOptions.certificateTemplate,
      quizzes:
        optionName === 'none'
          ? false
          : optionName === 'quizzes'
            ? checked
            : currentOptions.quizzes,
      savedQuizResults:
        optionName === 'none'
          ? false
          : optionName === 'savedQuizResults'
            ? checked
            : currentOptions.savedQuizResults,
    }));
  }

  function updateFeatureTemplateDesign(templateName, design) {
    setFeatureTemplateDesigns((currentDesigns) => ({
      ...currentDesigns,
      [templateName]: design,
    }));
  }

  async function saveFeatureSettings() {
    if (!featureTargetUser?.email) return;

    setIsUpdatingFeatures(true);
    setErrorMessage('');
    setStatus('');

    try {
      const nextFeatureTemplateDesigns = {
        ...featureTemplateDesigns,
        walletCards: 'same',
        walletFront: 'same',
        walletBack: 'same',
        certificateTemplate: 'same',
      };

      if (
        featureOptions.attendanceRecords &&
        !nextFeatureTemplateDesigns.attendanceRecordsCompany
      ) {
        throw new Error('Choose an attendance records company.');
      }

      if (
        featureOptions.quizzes &&
        !nextFeatureTemplateDesigns.savedQuizLibraryCompany
      ) {
        throw new Error('Choose a saved quiz library company.');
      }

      if (
        featureOptions.savedQuizResults &&
        !nextFeatureTemplateDesigns.savedQuizResultsCompany
      ) {
        throw new Error('Choose a saved quiz results company.');
      }

      const templateUploads = {
        certificateTemplate: null,
        walletCards: null,
      };
      const accessToken = await getAccessToken();
      const response = await fetch('/.netlify/functions/instructor-users', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'update-features',
          email: featureTargetUser.email,
          importOptions: featureOptions,
          templateDesigns: nextFeatureTemplateDesigns,
          templateUploads,
        }),
      });
      const data = await readFunctionResponse(response, 'Unable to update features.');

      setUsers(data?.users || []);
      setAttendanceCompanies(data?.attendanceCompanies || attendanceCompanies);
      setFeatureTargetUser(null);
      const importedMessage = formatImportedCounts(data);
      setStatus(
        importedMessage
          ? `Features updated. ${importedMessage}`
          : 'Features updated.'
      );
    } catch (error) {
      console.error('Update instructor features error:', error);
      setErrorMessage(error?.message || 'Unable to update features.');
    } finally {
      setIsUpdatingFeatures(false);
    }
  }

  function updateImportOption(optionName, checked) {
    setImportOptions((currentOptions) => ({
      ...currentOptions,
      none: optionName === 'none' ? checked : false,
      walletCards:
        optionName === 'none'
          ? false
          : optionName === 'walletCards'
            ? checked
            : currentOptions.walletCards,
      certificateTemplate:
        optionName === 'none'
          ? false
          : optionName === 'certificateTemplate'
            ? checked
            : currentOptions.certificateTemplate,
      attendanceRecords:
        optionName === 'none'
          ? false
          : optionName === 'attendanceRecords'
            ? checked
            : currentOptions.attendanceRecords,
      quizzes:
        optionName === 'none'
          ? false
          : optionName === 'quizzes'
            ? checked
            : currentOptions.quizzes,
      savedQuizResults:
        optionName === 'none'
          ? false
          : optionName === 'savedQuizResults'
            ? checked
            : currentOptions.savedQuizResults,
    }));
  }

  function updateTemplateDesign(templateName, design) {
    setTemplateDesigns((currentDesigns) => ({
      ...currentDesigns,
      [templateName]: design,
    }));
  }

  async function deleteUser() {
    if (!deleteTargetUser?.id) return;

    setDeletingUserId(deleteTargetUser.id);
    setErrorMessage('');
    setStatus('');

    try {
      const accessToken = await getAccessToken();
      const response = await fetch('/.netlify/functions/instructor-users', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId: deleteTargetUser.id }),
      });
      const data = await readFunctionResponse(response, 'Unable to delete email.');

      setUsers(data?.users || []);
      setAttendanceCompanies(data?.attendanceCompanies || attendanceCompanies);
      setDeleteTargetUser(null);
      setStatus('Email and all owned ExCourse data deleted.');
    } catch (error) {
      console.error('Delete instructor user error:', error);
      setErrorMessage(error?.message || 'Unable to delete email.');
    } finally {
      setDeletingUserId('');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUsers();
    // Settings loads once when the protected page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="quiz-page">
      <div className="quiz-card settings-card">
        <div className="admin-header">
          <div>
            <h2>Login Emails</h2>
            <p className="muted">
              Manage which emails can log in to ExCourse. Users only see the
              sessions and quizzes they create.
            </p>
          </div>

        </div>

        {errorMessage && (
          <div className="alert alert-error" role="alert">
            {errorMessage}
          </div>
        )}

        {status && (
          <div className="alert alert-success" role="status">
            {status}
          </div>
        )}

        <form className="settings-add-email-form" onSubmit={addUser}>
          <div className="settings-add-email-grid">
            <label htmlFor="newInstructorEmail">
              Email
              <input
                id="newInstructorEmail"
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder="name@example.com"
                autoComplete="email"
              />
            </label>

            <label htmlFor="newInstructorPassword">
              Password
              <span className="settings-password-control">
                <input
                  id="newInstructorPassword"
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="At least 6 characters"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="settings-password-toggle"
                  onClick={() => setShowPassword((currentValue) => !currentValue)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="3" />
                    {showPassword ? <path d="M4 4l16 16" /> : null}
                  </svg>
                </button>
              </span>
            </label>

            <div className="settings-email-actions">
              <button
                type="submit"
                className="settings-email-action-button"
                disabled={isAdding || isResettingPassword}
              >
                {isAdding ? 'Adding...' : 'Add Email'}
              </button>
            </div>
          </div>
        </form>

        <div className="settings-user-list">
          {users.map((user) => (
            <div className="settings-user-row" key={user.id}>
              <div>
                <strong>{user.email}</strong>
                <span>Last login: {formatDateTime(user.last_sign_in_at)}</span>
              </div>
              <div className="settings-user-actions">
                {user.email !== 'excourse7233@gmail.com' && (
                  <>
                    <button
                      type="button"
                      className="secondary-button settings-row-reset-button"
                      onClick={() => openResetPassword(user)}
                      disabled={isResettingPassword || isAdding || isUpdatingFeatures}
                    >
                      {resettingUserId === user.id ? 'Resetting...' : 'Reset Password'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button settings-row-reset-button"
                      onClick={() => openFeatureSettings(user)}
                      disabled={isAdding || isResettingPassword || isUpdatingFeatures}
                    >
                      Manage Features
                    </button>
                    <button
                      type="button"
                      className="secondary-button settings-delete-button"
                      onClick={() => setDeleteTargetUser(user)}
                      disabled={user.id === currentUserId || deletingUserId === user.id}
                      aria-label={`Delete ${user.email}`}
                      title={`Delete ${user.email}`}
                    >
                      <svg
                        aria-hidden="true"
                        className="settings-trash-icon"
                        viewBox="0 0 24 24"
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
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {deleteTargetUser && (
          <div
            className="quiz-confirm-overlay"
            role="presentation"
            onClick={() => {
              if (!deletingUserId) setDeleteTargetUser(null);
            }}
          >
            <div
              className="quiz-confirm-popup"
              role="dialog"
              aria-modal="true"
              aria-labelledby="deleteEmailTitle"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="deleteEmailTitle">Delete Email?</h3>
              <p>
                This will permanently delete {deleteTargetUser.email}, their
                login access, and all ExCourse data owned by that email.
              </p>
              <div className="quiz-confirm-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setDeleteTargetUser(null)}
                  disabled={Boolean(deletingUserId)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="quiz-danger-button"
                  onClick={deleteUser}
                  disabled={Boolean(deletingUserId)}
                >
                  {deletingUserId ? 'Deleting...' : 'Delete Email'}
                </button>
              </div>
            </div>
          </div>
        )}

        {resetTargetUser && (
          <div
            className="quiz-confirm-overlay"
            role="presentation"
            onClick={() => {
              if (!isResettingPassword) setResetTargetUser(null);
            }}
          >
            <div
              className="quiz-confirm-popup"
              role="dialog"
              aria-modal="true"
              aria-labelledby="resetPasswordTitle"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="resetPasswordTitle">Reset Password</h3>
              <p>Enter a new password for {resetTargetUser.email}.</p>

              {resetPasswordError && (
                <div className="alert alert-error" role="alert">
                  {resetPasswordError}
                </div>
              )}

              <label className="settings-modal-field" htmlFor="resetInstructorPassword">
                New Password
                <span className="settings-password-control">
                  <input
                    id="resetInstructorPassword"
                    type={showResetPassword ? 'text' : 'password'}
                    value={resetPasswordValue}
                    onChange={(event) => setResetPasswordValue(event.target.value)}
                    placeholder="At least 6 characters"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="settings-password-toggle"
                    onClick={() => setShowResetPassword((currentValue) => !currentValue)}
                    aria-label={showResetPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showResetPassword}
                    title={showResetPassword ? 'Hide password' : 'Show password'}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                      <circle cx="12" cy="12" r="3" />
                      {showResetPassword ? <path d="M4 4l16 16" /> : null}
                    </svg>
                  </button>
                </span>
              </label>

              <div className="quiz-confirm-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setResetTargetUser(null)}
                  disabled={isResettingPassword}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={resetPassword}
                  disabled={isResettingPassword}
                >
                  {isResettingPassword ? 'Resetting...' : 'Reset Password'}
                </button>
              </div>
            </div>
          </div>
        )}

        {featureTargetUser && (
          <div
            className="quiz-confirm-overlay"
            role="presentation"
            onClick={() => {
              if (!isUpdatingFeatures) setFeatureTargetUser(null);
            }}
          >
            <div
              className="quiz-confirm-popup"
              role="dialog"
              aria-modal="true"
              aria-labelledby="manageFeaturesTitle"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="manageFeaturesTitle">Manage Features</h3>
              <p>
                Choose which shared resources are available for {featureTargetUser.email}.
                Every email can create new quizzes by default.
              </p>

              <div className="settings-import-options">
                <label>
                  <input
                    type="checkbox"
                    checked={
                      !featureOptions.walletCards &&
                      !featureOptions.attendanceRecords &&
                      !featureOptions.certificateTemplate &&
                      !featureOptions.quizzes &&
                      !featureOptions.savedQuizResults
                    }
                    onChange={(event) =>
                      updateFeatureOption('none', event.target.checked)
                    }
                  />
                  None
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={featureOptions.attendanceRecords}
                    onChange={(event) =>
                      updateFeatureOption('attendanceRecords', event.target.checked)
                    }
                  />
                  Attendance records
                </label>
                {featureOptions.attendanceRecords && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Attendance records company
                      <select
                        value={featureTemplateDesigns.attendanceRecordsCompany}
                        onChange={(event) =>
                          updateFeatureTemplateDesign(
                            'attendanceRecordsCompany',
                            event.target.value
                          )
                        }
                      >
                        {attendanceCompanies.length === 0 ? (
                          <option value="">No companies found</option>
                        ) : (
                          attendanceCompanies.map((company) => (
                            <option key={company} value={company}>
                              {company}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={featureOptions.walletCards}
                    onChange={(event) =>
                      updateFeatureOption('walletCards', event.target.checked)
                    }
                  />
                  Wallet cards
                </label>
                {featureOptions.walletCards && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Wallet card design
                      <select
                        value={featureTemplateDesigns.walletCardDesign}
                        onChange={(event) =>
                          updateFeatureTemplateDesign(
                            'walletCardDesign',
                            event.target.value
                          )
                        }
                      >
                        <option value="excourse">ExCourse wallet cards</option>
                        <option value="bowman">Bowman Steel wallet cards</option>
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={featureOptions.certificateTemplate}
                    onChange={(event) =>
                      updateFeatureOption(
                        'certificateTemplate',
                        event.target.checked
                      )
                    }
                  />
                  Certificate template
                </label>
                {featureOptions.certificateTemplate && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Certificate design
                      <select
                        value={featureTemplateDesigns.certificateDesign}
                        onChange={(event) =>
                          updateFeatureTemplateDesign(
                            'certificateDesign',
                            event.target.value
                          )
                        }
                      >
                        <option value="excourse">ExCourse certificate</option>
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={featureOptions.quizzes}
                    onChange={(event) =>
                      updateFeatureOption('quizzes', event.target.checked)
                    }
                  />
                  Saved quiz library
                </label>
                {featureOptions.quizzes && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Saved quiz library company
                      <select
                        value={featureTemplateDesigns.savedQuizLibraryCompany}
                        onChange={(event) =>
                          updateFeatureTemplateDesign(
                            'savedQuizLibraryCompany',
                            event.target.value
                          )
                        }
                      >
                        {attendanceCompanies.length === 0 ? (
                          <option value="">No companies found</option>
                        ) : (
                          attendanceCompanies.map((company) => (
                            <option key={company} value={company}>
                              {company}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={featureOptions.savedQuizResults}
                    onChange={(event) =>
                      updateFeatureOption('savedQuizResults', event.target.checked)
                    }
                  />
                  Saved quiz results
                </label>
                {featureOptions.savedQuizResults && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Saved quiz results company
                      <select
                        value={featureTemplateDesigns.savedQuizResultsCompany}
                        onChange={(event) =>
                          updateFeatureTemplateDesign(
                            'savedQuizResultsCompany',
                            event.target.value
                          )
                        }
                      >
                        {attendanceCompanies.length === 0 ? (
                          <option value="">No companies found</option>
                        ) : (
                          attendanceCompanies.map((company) => (
                            <option key={company} value={company}>
                              {company}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  </div>
                )}
              </div>

              <div className="quiz-confirm-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setFeatureTargetUser(null)}
                  disabled={isUpdatingFeatures}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={saveFeatureSettings}
                  disabled={isUpdatingFeatures}
                >
                  {isUpdatingFeatures ? 'Saving...' : 'Save Features'}
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingAddUser && (
          <div
            className="quiz-confirm-overlay"
            role="presentation"
            onClick={() => {
              if (!isAdding) setPendingAddUser(null);
            }}
          >
            <div
              className="quiz-confirm-popup"
              role="dialog"
              aria-modal="true"
              aria-labelledby="addEmailOptionsTitle"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="addEmailOptionsTitle">Include Information?</h3>
              <p>Choose what should be imported for {pendingAddUser.email}.</p>

              <div className="settings-import-options">
                <label>
                  <input
                    type="checkbox"
                    checked={importOptions.none}
                    onChange={(event) =>
                      updateImportOption('none', event.target.checked)
                    }
                  />
                  None
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={importOptions.attendanceRecords}
                    onChange={(event) =>
                      updateImportOption('attendanceRecords', event.target.checked)
                    }
                  />
                  Attendance records
                </label>
                {importOptions.attendanceRecords && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Attendance records company
                      <select
                        value={templateDesigns.attendanceRecordsCompany}
                        onChange={(event) =>
                          updateTemplateDesign(
                            'attendanceRecordsCompany',
                            event.target.value
                          )
                        }
                      >
                        {attendanceCompanies.length === 0 ? (
                          <option value="">No companies found</option>
                        ) : (
                          attendanceCompanies.map((company) => (
                            <option key={company} value={company}>
                              {company}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={importOptions.walletCards}
                    onChange={(event) =>
                      updateImportOption('walletCards', event.target.checked)
                    }
                  />
                  Wallet cards
                </label>
                {importOptions.walletCards && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Wallet card design
                      <select
                        value={templateDesigns.walletCardDesign}
                        onChange={(event) =>
                          updateTemplateDesign(
                            'walletCardDesign',
                            event.target.value
                          )
                        }
                      >
                        <option value="excourse">ExCourse wallet cards</option>
                        <option value="bowman">Bowman Steel wallet cards</option>
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={importOptions.certificateTemplate}
                    onChange={(event) =>
                      updateImportOption(
                        'certificateTemplate',
                        event.target.checked
                      )
                    }
                  />
                  Certificate template
                </label>
                {importOptions.certificateTemplate && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Certificate design
                      <select
                        value={templateDesigns.certificateDesign}
                        onChange={(event) =>
                          updateTemplateDesign(
                            'certificateDesign',
                            event.target.value
                          )
                        }
                      >
                        <option value="excourse">ExCourse certificate</option>
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={importOptions.quizzes}
                    onChange={(event) =>
                      updateImportOption('quizzes', event.target.checked)
                    }
                  />
                  Saved quiz library
                </label>
                {importOptions.quizzes && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Saved quiz library company
                      <select
                        value={templateDesigns.savedQuizLibraryCompany}
                        onChange={(event) =>
                          updateTemplateDesign(
                            'savedQuizLibraryCompany',
                            event.target.value
                          )
                        }
                      >
                        {attendanceCompanies.length === 0 ? (
                          <option value="">No companies found</option>
                        ) : (
                          attendanceCompanies.map((company) => (
                            <option key={company} value={company}>
                              {company}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={importOptions.savedQuizResults}
                    onChange={(event) =>
                      updateImportOption('savedQuizResults', event.target.checked)
                    }
                  />
                  Saved quiz results
                </label>
                {importOptions.savedQuizResults && (
                  <div className="settings-design-options">
                    <label className="settings-design-select">
                      Saved quiz results company
                      <select
                        value={templateDesigns.savedQuizResultsCompany}
                        onChange={(event) =>
                          updateTemplateDesign(
                            'savedQuizResultsCompany',
                            event.target.value
                          )
                        }
                      >
                        {attendanceCompanies.length === 0 ? (
                          <option value="">No companies found</option>
                        ) : (
                          attendanceCompanies.map((company) => (
                            <option key={company} value={company}>
                              {company}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  </div>
                )}
              </div>

              <div className="quiz-confirm-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPendingAddUser(null)}
                  disabled={isAdding}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={confirmAddUser}
                  disabled={isAdding}
                >
                  {isAdding ? 'Adding...' : 'Add Email'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
