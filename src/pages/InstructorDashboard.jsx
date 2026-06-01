import { Link } from 'react-router-dom';
import './Quiz.css';

export default function InstructorDashboard() {
  return (
    <section className="quiz-page">
      <div className="quiz-card">
        <div className="quiz-header">
          <h1>Instructor Dashboard</h1>
          <p>Choose what you want to create for this class.</p>
        </div>

        <div className="instructor-option-grid">
          <Link className="instructor-option-card" to="/create-session-7392">
            <span>Create Attendance Session</span>
            <p>
              Create a class session, generate a student sign-in link and QR
              code, and collect attendance signatures.
            </p>
          </Link>

          <Link className="instructor-option-card" to="/create-quiz-7392">
            <span>Create Quiz</span>
            <p>
              Build a quiz for a course, generate a student quiz link and QR
              code, and collect self-graded results.
            </p>
          </Link>
        </div>
      </div>
    </section>
  );
}
