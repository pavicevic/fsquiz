import express from "express";
import cors from "cors";
import axios from "axios";
import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, "public", "logo.png");

const PORT = process.env.PORT || 3000;
const FS_API = "https://api.fs-quiz.eu/2";
const IMG_BASE = "https://img.fs-quiz.eu";

const MAX_YEAR_SPAN = 10; // max number of years per quiz request
const MAX_QUESTIONS = 50; // max questions per quiz
const MAX_PDF_QUESTIONS = 100;
const QUIZ_TTL_MS = 60 * 60 * 1000; // generated quizzes are kept for 1 hour
const ALLOWED_CLASSES = ["ev", "cv", "dv"];

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ============================
// IMAGE URL BUILDER
// ============================
function getImageURL(imgObj) {
    if (!imgObj || !imgObj.path) return null;
    return `${IMG_BASE}/${imgObj.path}`;
}

// ============================
// QUIZ STORAGE (in memory, expires after QUIZ_TTL_MS)
// ============================
const QuizStore = {};

setInterval(() => {
    const now = Date.now();
    for (const id of Object.keys(QuizStore)) {
        if (now - QuizStore[id].createdAt > QUIZ_TTL_MS) delete QuizStore[id];
    }
}, 10 * 60 * 1000).unref();

// ============================
// HEALTH CHECK + FRONTEND
// ============================
app.get("/health", (_, res) => res.send("ok"));

// frontend (static files)
app.use(express.static(path.join(__dirname, "public")));

// ============================
// GET EVENTS
// ============================
app.get("/api/events", async (req, res) => {
    try {
        const r = await axios.get(`${FS_API}/event`);
        res.json(r.data.events);
    } catch (e) {
        console.error(e.message);
        res.status(500).json({ error: "Failed to load events" });
    }
});

// ============================
// GENERATE RANGE QUIZ
// ============================
app.get("/api/generateRange", async (req, res) => {
    try {
        const { eventId, yearStart, yearEnd, className, count } = req.query;

        // ---- input validation ----
        if (!/^\d+$/.test(String(eventId || ""))) {
            return res.status(400).json({ error: "eventId is required" });
        }

        const y0 = Number(yearStart);
        const y1 = Number(yearEnd);
        if (!Number.isInteger(y0) || !Number.isInteger(y1) || y0 > y1) {
            return res.status(400).json({ error: "Invalid year range" });
        }
        if (y1 - y0 + 1 > MAX_YEAR_SPAN) {
            return res
                .status(400)
                .json({ error: `Year range is limited to ${MAX_YEAR_SPAN} years` });
        }

        if (className && !ALLOWED_CLASSES.includes(String(className))) {
            return res.status(400).json({ error: "Invalid class" });
        }

        const n = Math.min(Math.max(Number(count) || 5, 1), MAX_QUESTIONS);

        // ---- load quizzes for each year ----
        const allQuizzes = [];

        for (let y = y0; y <= y1; y++) {
            let link = `${FS_API}/event/${eventId}/quizzes?year=${y}`;
            if (className) link += `&class=${className}`;
            const r = await axios.get(link);
            allQuizzes.push(...(r.data.quizzes || []));
        }

        // ---- load questions of every quiz ----
        const allQuestions = [];

        for (const q of allQuizzes) {
            const r = await axios.get(`${FS_API}/quiz/${q.quiz_id}`);
            allQuestions.push(...(r.data.questions || []));
        }

        if (allQuestions.length === 0) {
            return res
                .status(404)
                .json({ error: "No questions found for this selection" });
        }

        // ---- shuffle (Fisher-Yates) and pick n ----
        for (let i = allQuestions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allQuestions[i], allQuestions[j]] = [allQuestions[j], allQuestions[i]];
        }
        const selected = allQuestions.slice(0, n);

        const cleaned = selected.map(q => ({
            id: q.question_id,
            text: q.text,
            type: q.type,
            images: q.images?.map(im => getImageURL(im)).filter(Boolean) || [],
            answers: (q.answers || []).map(a => ({
                id: a.answer_id,
                text: a.answer_text,
                is_correct: a.is_correct === true
            }))
        }));

        const quizId = Date.now().toString();

        // correct answers stay on the server, the client only gets the questions
        QuizStore[quizId] = {
            createdAt: Date.now(),
            questions: cleaned.map(q => ({
                id: q.id,
                correctAnswers: q.answers.filter(a => a.is_correct).map(a => a.id),
                solutions:
                    q.answers.length <= 1
                        ? q.answers.map(a => a.text.toLowerCase().trim())
                        : null
            }))
        };

        // is_correct is not sent to the browser
        const forClient = cleaned.map(q => ({
            ...q,
            // for open questions the single "answer" is the solution: never send it
            answers:
                q.answers.length <= 1
                    ? []
                    : q.answers.map(({ id, text }) => ({ id, text }))
        }));

        res.json({ quizId, questions: forClient });

    } catch (e) {
        console.error(e.message);
        res.status(500).json({ error: "Quiz generation failed" });
    }
});

// ============================
// GRADE QUIZ
// ============================
app.post("/api/grade", (req, res) => {
    try {
        const { quizId, answers } = req.body;
        const stored = QuizStore[quizId]?.questions;

        if (!stored) return res.status(404).json({ error: "Quiz not found or expired" });
        if (!Array.isArray(answers)) {
            return res.status(400).json({ error: "answers must be an array" });
        }

        let score = 0;
        const results = [];

        answers.forEach(ans => {
            const qInfo = stored.find(q => q.id == ans.questionId);
            if (!qInfo) return;

            const selected = Array.isArray(ans.selected) ? ans.selected : [];
            let correct = false;

            if (qInfo.solutions !== null) {
                // open question: compare typed text with accepted solutions
                correct = qInfo.solutions.includes(
                    String(selected[0] || "").toLowerCase().trim()
                );
            } else {
                // multiple choice: selected ids must match the correct ids exactly
                const ca = qInfo.correctAnswers;
                correct =
                    ca.length === selected.length &&
                    ca.every(a => selected.includes(a));
            }

            if (correct) score++;

            results.push({
                questionId: ans.questionId,
                correct,
                correctAnswers:
                    qInfo.solutions !== null
                        ? qInfo.solutions
                        : qInfo.correctAnswers,
                userAnswers: selected
            });
        });

        res.json({ score, total: answers.length, results });

    } catch (e) {
        console.error(e.message);
        res.status(500).json({ error: "Grade failed" });
    }
});

// ============================
// EXPORT QUESTIONS PDF
// ============================
app.post("/api/exportPDFQuestions", async (req, res) => {
    try {
        const { quizId, questions } = req.body;

        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: "questions must be a non-empty array" });
        }
        if (questions.length > MAX_PDF_QUESTIONS) {
            return res.status(400).json({ error: "Too many questions" });
        }

        const safeId = String(quizId || "quiz").replace(/\D/g, "") || "quiz";

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=questions_${safeId}.pdf`
        );

        const doc = new PDFDocument({ margin: 40 });
        doc.pipe(res);

        const PAGE_BOTTOM = doc.page.height - doc.page.margins.bottom;
        const MAX_IMAGE_HEIGHT = 350;

        // === LOGO ===
        try {
            doc.image(LOGO_PATH, { width: 120 });
        } catch {
            console.log("Logo not found");
        }

        doc.moveDown(2);

        // === TITLE ===
        doc.fontSize(22).text("FS Quiz – Questions", { align: "center" });
        doc.moveDown(2);

        // === QUESTIONS ===
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];

            // if little space is left on the page, continue on a new one
            if (doc.y > PAGE_BOTTOM - 100) {
                doc.addPage();
            }

            // ---- QUESTION TITLE (numbered 1., 2., 3. ...) ----
            doc
                .fontSize(14)
                .font("Helvetica-Bold")
                .text(`${i + 1}. ${q.text}`, { width: 520 });

            doc.moveDown(0.5);

            // ---- IMAGES ----
            if (q.images && q.images.length > 0) {
                for (const url of q.images) {
                    try {
                        // only images from the FS Quiz image host are fetched
                        if (typeof url !== "string" || !url.startsWith(`${IMG_BASE}/`)) {
                            continue;
                        }

                        const imgBuffer = (
                            await axios.get(url, { responseType: "arraybuffer" })
                        ).data;

                        if (doc.y > PAGE_BOTTOM - MAX_IMAGE_HEIGHT) {
                            doc.addPage();
                        }

                        doc.image(imgBuffer, {
                            fit: [500, MAX_IMAGE_HEIGHT],
                            align: "center"
                        });
                        doc.moveDown(1);
                    } catch {
                        doc.fontSize(10).fillColor("red").text("Image failed to load").fillColor("black");
                    }
                }
            }

            // ---- ANSWERS (a), b), c) ...) ----
            doc.font("Helvetica").fontSize(12);

            if (q.answers && q.answers.length > 1) {
                doc.text("Options:", { underline: true });
                doc.moveDown(0.2);

                q.answers.forEach((a, index) => {
                    const letter = String.fromCharCode(97 + index); // 0 = a, 1 = b ...
                    doc.fontSize(11).text(`${letter}) ${a.text}`, {
                        indent: 20
                    });
                });
            } else {
                doc.font("Helvetica-Oblique").text("(Open answer)", { indent: 20 });
            }

            // spacing and a light separator line between questions
            doc.moveDown(1.5);
            doc.moveTo(doc.x, doc.y).lineTo(550, doc.y).strokeColor("#eeeeee").stroke();
            doc.moveDown(1);
        }

        doc.end();

    } catch (e) {
        console.error(e.message);
        if (!res.headersSent) {
            res.status(500).json({ error: "PDF export failed" });
        } else {
            res.end();
        }
    }
});

// ============================
// START SERVER
// ============================
app.listen(PORT, () =>
    console.log(`Backend running on port ${PORT}`)
);
