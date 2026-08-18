-- Disable time-based quiz expiration without changing existing quiz data.
-- Published sessions now remain active until the instructor uses Save Quiz Results.

drop function if exists public.finalize_expired_quiz_session(uuid);
