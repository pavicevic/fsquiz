# FS Quiz Trainer

Practice tool for the Formula Student quiz, built for the team Drumska Strela (Road Arrow), Belgrade. Pick an event, a range of years and a class, generate a random quiz, answer it, get graded server-side, and export the questions as a PDF.

Unofficial tool. Questions are loaded on demand from the public [FS Quiz](https://fs-quiz.eu) API (`api.fs-quiz.eu`) and are not stored in this repository.

**Live:** https://fsquiz.onrender.com (free hosting, the first load after a pause can take up to a minute)

<!-- ![screenshot](screenshot.png) -->

## Stack

Node.js, Express 5, Axios, PDFKit; vanilla JavaScript/HTML frontend served from `public/`.

## Run locally

```bash
npm install
npm start      # http://localhost:3000
```

## API

| Method | Route | Description |
| ------ | ----- | ----------- |
| GET | `/api/events` | List of events |
| GET | `/api/generateRange?eventId=&yearStart=&yearEnd=&className=&count=` | Random quiz (max 10 years, 50 questions) |
| POST | `/api/grade` | Grades answers (`{ quizId, answers }`); correct answers never reach the browser before grading |
| POST | `/api/exportPDFQuestions` | PDF with the questions |
| GET | `/health` | Health check |

Generated quizzes are kept in memory for one hour.

## Deploy (Render)

New → Web Service → connect this repo. `render.yaml` sets build `npm install` and start `node index.js`. To avoid free-tier sleeping, ping `/health` every 5 minutes (e.g. UptimeRobot).
