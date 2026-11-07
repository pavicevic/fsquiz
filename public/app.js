// Frontend and backend are served from the same origin
const API = "";

let CURRENT_QUESTIONS = [];
let CURRENT_QUIZ_ID = null;

const $ = id => document.getElementById(id);

// Escape text coming from the API before putting it into innerHTML
function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function setStatus(message, isError = false) {
    const box = $("statusBox");
    box.textContent = message;
    box.style.color = isError ? "#b00020" : "#444";
    box.style.display = message ? "block" : "none";
}

// Free hosting puts the backend to sleep, so the first request can be slow
const WAKE_HINT = "Loading… the free server may be waking up, this can take up to a minute.";

async function apiFetch(path, options) {
    const r = await fetch(API + path, options);
    if (!r.ok) {
        let msg = `Request failed (${r.status})`;
        try {
            const body = await r.json();
            if (body.error) msg = body.error;
        } catch { /* not JSON */ }
        throw new Error(msg);
    }
    return r;
}

// =======================
// LOAD EVENTS
// =======================
async function loadEvents() {
    setStatus(WAKE_HINT);
    try {
        const r = await apiFetch("/api/events");
        const events = await r.json();
        const sel = $("eventSelect");
        sel.innerHTML = "";

        events.forEach(e => {
            const opt = document.createElement("option");
            opt.value = e.id;
            opt.textContent = `${e.short_name} – ${e.event_name}`;
            sel.appendChild(opt);
        });
        setStatus("");
    } catch (e) {
        setStatus("Could not load events. Please refresh the page in a moment.", true);
    }
}
loadEvents();

// =======================
// GENERATE QUIZ
// =======================
async function generateQuiz() {
    const eventId = $("eventSelect").value;
    const ys = Number($("yearStart").value);
    const ye = Number($("yearEnd").value);
    const cn = $("classSelect").value;
    const count = Number($("countInput").value) || 5;

    if (!eventId) return setStatus("Choose an event first.", true);
    if (!ys || !ye || ys > ye) return setStatus("Enter a valid year range (From ≤ To).", true);
    if (ye - ys > 9) return setStatus("Year range is limited to 10 years.", true);

    let query = `eventId=${encodeURIComponent(eventId)}&yearStart=${ys}&yearEnd=${ye}&count=${count}`;
    if (cn) query += `&className=${encodeURIComponent(cn)}`;

    setStatus(WAKE_HINT);
    $("generateButton").disabled = true;

    try {
        const r = await apiFetch(`/api/generateRange?${query}`);
        const data = await r.json();

        CURRENT_QUIZ_ID = data.quizId;

        // remove duplicate questions by ID
        const map = new Map();
        data.questions.forEach(q => {
            if (!map.has(q.id)) map.set(q.id, q);
        });
        CURRENT_QUESTIONS = Array.from(map.values());

        $("resultContainer").innerHTML = "";
        renderQuiz(CURRENT_QUESTIONS);

        $("submitButton").style.display = "block";
        $("pdfQuestionsButton").style.display = "inline-block";
        setStatus("");
    } catch (e) {
        setStatus(e.message || "Something went wrong.", true);
    } finally {
        $("generateButton").disabled = false;
    }
}

// =======================
// RENDER QUIZ
// =======================
function renderQuiz(questions) {
    const container = $("quizContainer");
    container.innerHTML = "";

    questions.forEach((q, index) => {
        const div = document.createElement("div");
        div.className = "question";

        let html = `<h3>${index + 1}. ${esc(q.text).replace(/\n/g, "<br>")}</h3>`;

        // images
        (q.images || []).forEach(img => {
            const imgUrl = typeof img === "string" ? img : img?.path ? `https://img.fs-quiz.eu/${img.path}` : "";
            if (!imgUrl.startsWith("https://img.fs-quiz.eu/")) return;

            html += `
            <div style="margin:10px 0;">
                <img src="${esc(imgUrl)}" style="max-width:100%;"
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='inline';">
                <a href="${esc(imgUrl)}" target="_blank" rel="noopener" style="display:none; font-size:12px;">
                    Open image
                </a>
            </div>`;
        });

        if (!q.answers || q.answers.length <= 1) {
            // open question
            html += `<input type="text" name="q_${esc(q.id)}" class="input" style="width:100%;">`;
        } else {
            // multiple choice
            q.answers.forEach(a => {
                html += `
                <label>
                    <input type="radio" name="q_${esc(q.id)}" value="${esc(a.id)}">
                    ${esc(a.text)}
                </label><br>`;
            });
        }

        div.innerHTML = html;
        container.appendChild(div);
    });
}

// =======================
// SUBMIT QUIZ
// =======================
async function submitQuiz() {
    const answers = CURRENT_QUESTIONS.map(q => {
        let sel = [];

        if (!q.answers || q.answers.length <= 1) {
            sel = [document.querySelector(`input[name="q_${q.id}"]`)?.value.trim() || ""];
        } else {
            sel = [...document.querySelectorAll(`input[name="q_${q.id}"]:checked`)]
                .map(i => Number(i.value));
        }

        return { questionId: q.id, selected: sel };
    });

    try {
        const r = await apiFetch("/api/grade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ quizId: CURRENT_QUIZ_ID, answers })
        });
        renderResults(await r.json());
        setStatus("");
    } catch (e) {
        setStatus(e.message || "Grading failed.", true);
    }
}

// =======================
// RENDER RESULTS
// =======================
function renderResults(result) {
    const box = $("resultContainer");

    const getAnswerText = (qId, aId) => {
        const q = CURRENT_QUESTIONS.find(q => q.id === qId);
        const a = q?.answers?.find(x => x.id === aId);
        return a ? a.text : aId;
    };

    let html = `<h2>Results</h2><p>Score: ${esc(result.score)} / ${esc(result.total)}</p><ul>`;

    result.results.forEach((res, index) => {
        const userText = res.userAnswers.map(a => getAnswerText(res.questionId, a)).join(", ");
        const correctText = res.correctAnswers.map(a => getAnswerText(res.questionId, a)).join(", ");

        html += `
        <li style="margin-bottom:12px;">
            <strong>${index + 1}.</strong><br>
            <strong>Your answer:</strong> ${esc(userText) || "-"}<br>
            <strong>Correct answer:</strong> ${esc(correctText)}<br>
            <strong>Status:</strong> ${res.correct ? "✅ Correct" : "❌ Wrong"}
        </li>`;
    });

    html += `</ul>`;
    box.innerHTML = html;
}

// =======================
// EXPORT PDF (QUESTIONS)
// =======================
async function exportQuestionsPDF() {
    setStatus("Preparing PDF…");
    try {
        const r = await apiFetch("/api/exportPDFQuestions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                quizId: CURRENT_QUIZ_ID,
                questions: CURRENT_QUESTIONS
            })
        });

        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `questions_${CURRENT_QUIZ_ID}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setStatus("");
    } catch (e) {
        setStatus(e.message || "PDF export failed.", true);
    }
}
