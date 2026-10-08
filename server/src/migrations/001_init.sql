-- StudyTrack V4 schema (PostgreSQL). Dates are DATE, instants are TIMESTAMPTZ, flags are BOOLEAN.

CREATE TABLE institutes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  head_id INTEGER,
  owner_email TEXT NOT NULL,
  contact_phone TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  expected_teachers INTEGER,
  expected_students INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','suspended','banned')),
  status_reason TEXT NOT NULL DEFAULT '',
  control_mode TEXT NOT NULL DEFAULT 'managed' CHECK (control_mode IN ('managed','independent')),
  read_only BOOLEAN NOT NULL DEFAULT FALSE,
  max_teachers INTEGER,
  max_students INTEGER,
  storage_limit_mb INTEGER,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  google_sub TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  role TEXT NOT NULL CHECK (role IN ('teacher','student')),
  institute_id INTEGER REFERENCES institutes(id) ON DELETE SET NULL,
  institute_role TEXT CHECK (institute_role IN ('head','co_head','teacher')),
  institute_note TEXT NOT NULL DEFAULT '',
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason TEXT NOT NULL DEFAULT '',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_institute ON users(institute_id);
CREATE INDEX idx_institutes_head ON institutes(head_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_reauth_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_type TEXT NOT NULL DEFAULT 'unknown',
  os TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  ip_masked TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id, revoked_at);

CREATE TABLE login_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE security_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  type TEXT NOT NULL,
  ip_masked TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_security_events_created ON security_events(id);

CREATE TABLE classes (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspend_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_classes_teacher ON classes(teacher_id);

-- A student can belong to many classes; a class has many students.
CREATE TABLE student_class_memberships (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  UNIQUE (student_id, class_id)
);
CREATE INDEX idx_memberships_class ON student_class_memberships(class_id, status);
CREATE INDEX idx_memberships_student ON student_class_memberships(student_id, status);

CREATE TABLE join_requests (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','blocked','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_join_requests_class ON join_requests(class_id, status);
CREATE INDEX idx_join_requests_student ON join_requests(student_id, id);
CREATE UNIQUE INDEX idx_join_requests_one_pending ON join_requests(student_id, class_id) WHERE status = 'pending';

CREATE TABLE teacher_blocks (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  student_email TEXT NOT NULL,
  student_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, student_email)
);

CREATE TABLE homework (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date DATE,
  file_path TEXT,
  file_name TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_homework_class ON homework(class_id, created_at);

CREATE TABLE homework_submissions (
  id SERIAL PRIMARY KEY,
  homework_id INTEGER NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','late','reviewed')),
  feedback TEXT NOT NULL DEFAULT '',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (homework_id, student_id)
);
CREATE INDEX idx_homework_submissions_student ON homework_submissions(student_id);

CREATE TABLE tests (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  max_marks INTEGER NOT NULL CHECK (max_marks > 0),
  solution TEXT NOT NULL DEFAULT '',
  test_date DATE,
  file_path TEXT,
  file_name TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tests_class ON tests(class_id, test_date);

CREATE TABLE marks (
  id SERIAL PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marks DOUBLE PRECISION NOT NULL CHECK (marks >= 0),
  remark TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (test_id, student_id)
);
CREATE INDEX idx_marks_student ON marks(student_id);

CREATE TABLE study_logs (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('tuition','self-study','outside')),
  subject TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  study_date DATE NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_study_logs_student_date ON study_logs(student_id, study_date);

CREATE TABLE attendance (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, class_id, attendance_date)
);
CREATE INDEX idx_attendance_class_date ON attendance(class_id, attendance_date);

CREATE TABLE syllabus_chapters (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not-started' CHECK (status IN ('not-started','in-progress','completed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (class_id, subject, chapter)
);

CREATE TABLE admin_log (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  target_label TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notification centre
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important')),
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX idx_notifications_user ON notifications(user_id, id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at);

-- Announcements: one class, several classes, or the whole institute
CREATE TABLE announcements (
  id SERIAL PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institute_id INTEGER REFERENCES institutes(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('class','classes','institute')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_announcements_created ON announcements(id);
CREATE TABLE announcement_targets (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, class_id)
);

-- Academic calendar
CREATE TABLE class_schedule (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  subject TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_class_schedule_class ON class_schedule(class_id, weekday);

CREATE TABLE calendar_events (
  id SERIAL PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institute_id INTEGER REFERENCES institutes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event','holiday')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_calendar_events_dates ON calendar_events(start_date, end_date);
CREATE TABLE calendar_event_targets (
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, class_id)
);

-- Student goals and smart study planner
CREATE TABLE student_goals (
  student_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_minutes INTEGER NOT NULL CHECK (daily_minutes > 0),
  weekly_minutes INTEGER NOT NULL CHECK (weekly_minutes > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE study_plan_slots (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  subject TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_study_plan_student ON study_plan_slots(student_id, weekday);
CREATE TABLE student_exams (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  exam_date DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_student_exams_student ON student_exams(student_id, exam_date);

-- Backup bookkeeping (one row per backup attempt; period_key stops two instances running the same backup)
CREATE TABLE backup_runs (
  id SERIAL PRIMARY KEY,
  period_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('daily','weekly','manual')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  size_bytes INTEGER,
  storage_path TEXT,
  sha256 TEXT,
  row_counts TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  verified_at TIMESTAMPTZ,
  verify_status TEXT NOT NULL DEFAULT 'never' CHECK (verify_status IN ('never','ok','failed')),
  verify_detail TEXT NOT NULL DEFAULT ''
);
