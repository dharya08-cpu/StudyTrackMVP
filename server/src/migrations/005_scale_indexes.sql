-- Indexes for the cleanup paths: removing a user or a teacher scans these columns (foreign keys), which is slow on a big table without one.
CREATE INDEX idx_submission_files_student ON submission_files(student_id);
CREATE INDEX idx_attachments_uploaded_by ON attachments(uploaded_by);
