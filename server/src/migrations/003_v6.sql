-- V6: many files per homework/test, and the student's own calendar items.

-- ---- Attachments --------------------------------------------------------------------------------------------
-- Until V5 a homework or test had ONE file in its own columns, so attaching a second file replaced the first
-- (the "only the newest file is viewable" bug). Every file is now its own row; an item can have many.
-- Exactly one of homework_id / test_id is set. Deleting the homework, test or class deletes the rows too
-- (the code removes the stored objects first).
CREATE TABLE attachments (
  id SERIAL PRIMARY KEY,
  homework_id INTEGER REFERENCES homework(id) ON DELETE CASCADE,
  test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_type TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((homework_id IS NOT NULL) <> (test_id IS NOT NULL))
);
CREATE INDEX idx_attachments_homework ON attachments(homework_id, id);
CREATE INDEX idx_attachments_test ON attachments(test_id, id);
CREATE INDEX idx_attachments_class ON attachments(class_id);

-- Carry over every file that exists today. The old columns on homework/tests are left untouched (V6 no longer
-- reads or writes them) so a rollback to the previous version still works; a later release can drop them.
INSERT INTO attachments(homework_id, class_id, uploaded_by, file_path, file_name, file_size, file_type, created_at)
  SELECT id, class_id, teacher_id, file_path, COALESCE(file_name, 'file'), COALESCE(file_size, 0), COALESCE(file_type, ''), created_at
  FROM homework WHERE file_path IS NOT NULL;
INSERT INTO attachments(test_id, class_id, uploaded_by, file_path, file_name, file_size, file_type, created_at)
  SELECT id, class_id, teacher_id, file_path, COALESCE(file_name, 'file'), COALESCE(file_size, 0), COALESCE(file_type, ''), created_at
  FROM tests WHERE file_path IS NOT NULL;

-- ---- The student's own calendar ---------------------------------------------------------------------------
-- Study goals, revision goals and tasks a student plans for themselves: "finish Physics revision by 12 Nov".
-- Private to the student (teachers never see them). start_date..end_date is the window; end_date is the deadline.
CREATE TABLE student_plan_items (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('goal','revision','task')),
  title TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_plan_items_student ON student_plan_items(student_id, start_date, end_date);
