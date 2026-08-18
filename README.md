# StudyTrack MVP

A starter full-stack coaching-management app with:

- Teacher / Student login
- Student self-registration with teacher class code
- JWT authentication
- Teacher dashboard
- Create homework
- Create tests
- Publish solutions
- Enter student marks and remarks
- Student dashboard
- Homework/test list
- Student study tracker (tuition, self-study, outside)
- Persistent SQLite database
- Basic progress/score analytics
- Mobile-friendly React UI

## Requirements

- Node.js 20+
- npm

## Run

### 1. Backend

```bash
cd server
npm install
npm run dev
```

Backend runs at `http://localhost:5000`.

### 2. Frontend

In another terminal:

```bash
cd client
npm install
npm run dev
```

Open the URL Vite prints (normally `http://localhost:5173`).

## Demo accounts

Teacher:
- email: teacher@coaching.com
- password: teacher123

Student:
- email: student@coaching.com
- password: student123

Demo class code:
- DEMO01

The server seeds these accounts on first startup.

## Important

This is an MVP foundation. For a real public deployment, replace the local SQLite setup with a hosted database (for example PostgreSQL/Supabase), use environment secrets, add HTTPS, rate limiting, stronger validation, and production file storage.
