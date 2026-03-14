// ─── State ────────────────────────────────────────────────────────────────────
// Single source of truth for all runtime data.
// Nothing is stored in global variables outside this object.

const state = {
  exercises: [],           // string[] — loaded from /api/exercises on startup
  currentSession: 1,       // 1 | 2 | 3 — which tab the user is viewing
  recordings: {},          // { exerciseName: Blob } — audio blobs captured this session
  transcripts: {},         // { exerciseName: string } — text returned by Whisper
  activeRecorder: null,    // holds the active MediaRecorder + timer while recording
  isProcessing: false,     // true while transcribing/summarizing; blocks UI interactions
  dayData: null,           // today's data object, loaded from and saved to localStorage
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns today's date as YYYY-MM-DD, used as the localStorage key suffix
function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Converts a YYYY-MM-DD string into a human-readable date (e.g. "March 14, 2026").
// We parse as local noon to avoid off-by-one errors from timezone offsets.
function formatDate(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Updates the small status line below the exercise cards (e.g. "Transcribing 2 of 5…")
function setStatus(msg) {
  const el = document.getElementById('status-message');
  if (el) el.textContent = msg;
}

// Shows the coloured notification banner at the top of the page.
// type: 'success' (green) | 'error' (red) | 'info' (blue) | 'warning' (amber)
function showBanner(msg, type = 'info') {
  const banner = document.getElementById('banner');
  const bannerText = document.getElementById('banner-text');
  banner.className = `banner banner-${type}`;
  bannerText.textContent = msg;
  banner.classList.remove('hidden');
}

function hideBanner() {
  document.getElementById('banner').classList.add('hidden');
}

// ─── localStorage ─────────────────────────────────────────────────────────────
// All session progress is persisted in localStorage under the key
// `physio_day_YYYY-MM-DD`. This means the page can be refreshed or closed
// and all recordings, summaries, and Notion push state are safely restored.

// Loads today's data from localStorage, or creates a fresh default structure.
function loadDayData() {
  const date = todayKey();
  const stored = localStorage.getItem(`physio_day_${date}`);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (_) {}
  }
  // Default shape — three sessions, all incomplete, Notion not yet pushed
  return {
    date,
    sessions: {
      '1': { completed: false, summary: null },
      '2': { completed: false, summary: null },
      '3': { completed: false, summary: null }
    },
    notionPushed: false
  };
}

// Writes the current state.dayData back to localStorage
function saveDayData() {
  const date = todayKey();
  localStorage.setItem(`physio_day_${date}`, JSON.stringify(state.dayData));
}

// ─── Session Tab UI ───────────────────────────────────────────────────────────
// Updates the three session tabs to reflect current progress:
//   active   → currently selected (blue background)
//   completed → already done (green background, ✓ badge)
//   disabled  → future session whose predecessor isn't done yet (greyed out)

function renderSessionTabs() {
  [1, 2, 3].forEach(n => {
    const tab = document.getElementById(`tab-${n}`);
    const statusEl = document.getElementById(`tab-status-${n}`);
    const sessionData = state.dayData.sessions[String(n)];

    tab.classList.toggle('active', n === state.currentSession);
    tab.classList.toggle('completed', sessionData.completed);

    // Update the small status indicator inside each tab
    if (sessionData.completed) {
      statusEl.textContent = '✓';
      statusEl.className = 'tab-status tab-status-done';
    } else if (n === state.currentSession) {
      statusEl.textContent = '●';                    // pulsing dot (animated in CSS)
      statusEl.className = 'tab-status tab-status-active';
    } else {
      statusEl.textContent = '';
      statusEl.className = 'tab-status';
    }

    // Lock the tab if the previous session hasn't been completed yet.
    // Session 1 is always unlocked. Sessions 2 and 3 require the prior session to be done.
    const prevCompleted = n === 1 || state.dayData.sessions[String(n - 1)].completed;
    tab.disabled = !prevCompleted && !sessionData.completed;
  });
}

// Called when the user clicks a session tab.
// Resets per-session state (recordings/transcripts are per-session, not persisted).
function switchSession(n) {
  if (state.isProcessing) return;           // ignore clicks while transcribing
  if (state.activeRecorder) stopCurrentRecording();  // stop any live recording

  state.currentSession = n;
  state.recordings = {};    // clear in-memory audio blobs (they're session-scoped)
  state.transcripts = {};   // clear in-memory transcripts
  renderSessionTabs();
  renderExerciseCards();
  updateEndSessionBtn();

  // If switching to an already-completed session, show its stored summary
  const sessionData = state.dayData.sessions[String(n)];
  if (sessionData.completed && sessionData.summary) {
    showSessionSummary(n, sessionData.summary);
  } else {
    hideSessionSummary();
  }

  setStatus('Ready to record');
}

// ─── Exercise Cards ───────────────────────────────────────────────────────────
// Each exercise gets its own card with a record/stop/re-record button,
// a running timer, and a REC indicator. Cards are built dynamically from
// state.exercises so adding exercises to Notion automatically updates the UI.

function renderExerciseCards() {
  const container = document.getElementById('exercise-cards');
  container.innerHTML = '';  // clear any existing cards before re-rendering

  state.exercises.forEach(name => {
    const card = buildExerciseCard(name);
    container.appendChild(card);
  });
}

// Builds the HTML structure for one exercise card and wires up its button.
function buildExerciseCard(exerciseName) {
  const card = document.createElement('article');
  card.className = 'exercise-card';
  card.dataset.exercise = exerciseName;
  card.id = `card-${cssId(exerciseName)}`;

  // If this session is already completed, all record buttons start disabled
  const isCompleted = state.dayData.sessions[String(state.currentSession)].completed;

  card.innerHTML = `
    <div class="card-header">
      <h3 class="card-title">${exerciseName}</h3>
      <span class="card-badge" id="badge-${cssId(exerciseName)}"></span>
    </div>
    <div class="card-body">
      <div class="recorder-row">
        <button
          class="btn btn-record"
          id="rec-btn-${cssId(exerciseName)}"
          data-exercise="${exerciseName}"
          ${isCompleted ? 'disabled' : ''}
          aria-label="Start recording ${exerciseName}"
        >
          Start Recording
        </button>
        <span class="timer hidden" id="timer-${cssId(exerciseName)}">0:00</span>
        <span class="rec-indicator hidden" id="rec-dot-${cssId(exerciseName)}" aria-hidden="true">● REC</span>
      </div>
    </div>
  `;

  const btn = card.querySelector('.btn-record');
  btn.addEventListener('click', () => handleRecordClick(exerciseName));

  // If we already have a recording for this exercise (e.g. user re-opened the tab),
  // restore the "recorded" visual state immediately
  if (state.recordings[exerciseName]) {
    setCardRecorded(exerciseName);
  }

  return card;
}

// Converts an exercise name to a safe CSS id (e.g. "90/90 hold" → "90/90-hold")
function cssId(name) {
  return name.replace(/\s+/g, '-').toLowerCase();
}

// ── Card visual state helpers ─────────────────────────────────────────────────
// These three functions switch a card between its three visual states:
//   idle      → "Start Recording" button, no badge
//   recording → "Stop" button, timer running, red pulsing border
//   recorded  → "Re-record" button, "✓ Recorded" badge, green background

function setCardRecorded(exerciseName) {
  const badge = document.getElementById(`badge-${cssId(exerciseName)}`);
  const btn = document.getElementById(`rec-btn-${cssId(exerciseName)}`);
  const timer = document.getElementById(`timer-${cssId(exerciseName)}`);
  const dot = document.getElementById(`rec-dot-${cssId(exerciseName)}`);
  const card = document.getElementById(`card-${cssId(exerciseName)}`);

  if (badge) { badge.textContent = '✓ Recorded'; badge.className = 'card-badge badge-done'; }
  if (btn) { btn.textContent = 'Re-record'; btn.className = 'btn btn-rerecord'; }
  if (timer) timer.classList.add('hidden');
  if (dot) dot.classList.add('hidden');
  if (card) card.classList.add('card-recorded');
}

function setCardRecording(exerciseName) {
  const badge = document.getElementById(`badge-${cssId(exerciseName)}`);
  const btn = document.getElementById(`rec-btn-${cssId(exerciseName)}`);
  const timer = document.getElementById(`timer-${cssId(exerciseName)}`);
  const dot = document.getElementById(`rec-dot-${cssId(exerciseName)}`);
  const card = document.getElementById(`card-${cssId(exerciseName)}`);

  if (badge) { badge.textContent = ''; badge.className = 'card-badge'; }
  if (btn) { btn.textContent = 'Stop'; btn.className = 'btn btn-stop'; btn.setAttribute('aria-label', `Stop recording ${exerciseName}`); }
  if (timer) timer.classList.remove('hidden');
  if (dot) dot.classList.remove('hidden');
  if (card) { card.classList.add('card-recording'); card.classList.remove('card-recorded'); }
}

function setCardIdle(exerciseName) {
  const badge = document.getElementById(`badge-${cssId(exerciseName)}`);
  const btn = document.getElementById(`rec-btn-${cssId(exerciseName)}`);
  const timer = document.getElementById(`timer-${cssId(exerciseName)}`);
  const dot = document.getElementById(`rec-dot-${cssId(exerciseName)}`);
  const card = document.getElementById(`card-${cssId(exerciseName)}`);

  if (badge) { badge.textContent = ''; badge.className = 'card-badge'; }
  if (btn) { btn.textContent = 'Start Recording'; btn.className = 'btn btn-record'; btn.setAttribute('aria-label', `Start recording ${exerciseName}`); }
  if (timer) { timer.textContent = '0:00'; timer.classList.add('hidden'); }
  if (dot) dot.classList.add('hidden');
  if (card) { card.classList.remove('card-recording'); card.classList.remove('card-recorded'); }
}

// ─── Recording Logic ──────────────────────────────────────────────────────────

// Handles the record button click for any exercise.
// Only one exercise can be recording at a time — clicking another auto-stops the current one.
async function handleRecordClick(exerciseName) {
  if (state.isProcessing) return;

  // Clicking the active exercise's button → stop recording
  if (state.activeRecorder && state.activeRecorder.exerciseName === exerciseName) {
    stopCurrentRecording();
    return;
  }

  // Clicking a different exercise while one is already recording → stop the old one first
  if (state.activeRecorder) {
    stopCurrentRecording();
  }

  // Start recording the clicked exercise
  await startRecording(exerciseName);
}

// Starts capturing microphone audio for the given exercise using the MediaRecorder API.
// Audio is captured in small chunks (every 250ms) to minimise data loss if stopped abruptly.
async function startRecording(exerciseName) {
  let stream;
  try {
    // Request microphone access — browser will prompt if not already allowed
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showBanner('Microphone access required. Please allow in browser settings.', 'error');
    return;
  }

  const chunks = [];  // collects audio data chunks as they arrive

  // Pick the best audio format the current browser supports
  const mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });

  // Each time MediaRecorder has a chunk of audio data ready, push it to the array
  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  // When recording is stopped: combine all chunks into a single Blob, save to state
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());   // release the microphone
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
    state.recordings[exerciseName] = blob;        // store blob keyed by exercise name
    setCardRecorded(exerciseName);
    updateEndSessionBtn();                        // re-check if all exercises are recorded
  };

  // ── Timer: counts seconds while recording is active ──
  let seconds = 0;
  const timerEl = document.getElementById(`timer-${cssId(exerciseName)}`);
  const timerInterval = setInterval(() => {
    seconds++;
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, '0');
    if (timerEl) timerEl.textContent = `${m}:${s}`;
  }, 1000);

  mediaRecorder.start(250);   // emit ondataavailable every 250ms
  setCardRecording(exerciseName);
  setStatus(`Recording ${exerciseName}…`);

  // Store everything needed to stop this recording later
  state.activeRecorder = { exerciseName, mediaRecorder, chunks, timerInterval, stream };
}

// Stops the currently active recording and clears the activeRecorder reference.
function stopCurrentRecording() {
  if (!state.activeRecorder) return;
  const { mediaRecorder, timerInterval } = state.activeRecorder;
  clearInterval(timerInterval);
  if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();  // triggers onstop callback
  state.activeRecorder = null;
  setStatus('Ready to record');
}

// Returns the most compatible audio MIME type the current browser supports.
// Whisper can handle webm, ogg, and mp4 audio formats.
function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';  // fallback: let the browser decide
}

// Maps a MIME type to a file extension for naming the upload
function getFileExtension(mimeType) {
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('ogg')) return '.ogg';
  if (mimeType.includes('mp4')) return '.mp4';
  return '.webm';
}

// ─── End Session Flow ─────────────────────────────────────────────────────────

// Updates the "End Session" button's enabled/disabled state.
// The button is only enabled when every exercise has a recorded blob and
// the session hasn't been completed yet.
function updateEndSessionBtn() {
  const btn = document.getElementById('end-session-btn');
  const sessionCompleted = state.dayData.sessions[String(state.currentSession)].completed;

  if (sessionCompleted) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = 'Session Complete ✓';
    return;
  }

  const allRecorded = state.exercises.length > 0 &&
    state.exercises.every(ex => state.recordings[ex]);

  btn.disabled = !allRecorded || state.isProcessing;
  btn.setAttribute('aria-disabled', String(!allRecorded || state.isProcessing));
  btn.textContent = 'End Session';
}

// Main flow triggered by pressing "End Session".
// Sequentially transcribes each exercise (Whisper can only handle one file at a time),
// then asks Ollama to summarise all transcripts, saves to localStorage, and
// automatically pushes to Notion after Session 3.
async function endSession() {
  if (state.isProcessing) return;
  if (state.activeRecorder) stopCurrentRecording();  // stop any in-progress recording

  const sessionNum = state.currentSession;
  state.isProcessing = true;   // lock UI to prevent double-submits
  updateEndSessionBtn();
  hideBanner();

  // Disable all record buttons while processing
  document.querySelectorAll('.btn-record, .btn-rerecord, .btn-stop').forEach(b => b.disabled = true);

  // ── Step 1: Transcribe each exercise one at a time ──
  // Sequential (not parallel) to avoid overloading the local Whisper process.
  // If any exercise fails, we stop and let the user re-record just that exercise.
  const totalExercises = state.exercises.length;
  for (let i = 0; i < totalExercises; i++) {
    const exerciseName = state.exercises[i];
    setStatus(`Transcribing exercise ${i + 1} of ${totalExercises}…`);

    const blob = state.recordings[exerciseName];
    if (!blob) {
      showBanner(`No recording found for ${exerciseName}. Please re-record.`, 'error');
      state.isProcessing = false;
      updateEndSessionBtn();
      return;
    }

    // Send the audio blob as a multipart form upload to /api/transcribe
    const ext = getFileExtension(blob.type);
    const formData = new FormData();
    formData.append('audio', blob, `recording${ext}`);
    formData.append('exerciseName', exerciseName);

    try {
      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Unknown transcription error');
      }

      state.transcripts[exerciseName] = data.transcript;
    } catch (err) {
      // On failure: show an error, re-enable just this exercise's button so the user
      // can re-record only the failed one without losing everything else.
      showBanner(`Transcription failed for ${exerciseName}. Please re-record.`, 'error');
      const btn = document.getElementById(`rec-btn-${cssId(exerciseName)}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Re-record'; btn.className = 'btn btn-rerecord'; }
      state.isProcessing = false;
      updateEndSessionBtn();
      return;
    }
  }

  // ── Step 2: Summarize all transcripts via Ollama/Mistral ──
  setStatus('Generating summary…');

  let summary = '';
  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exercises: state.exercises, transcripts: state.transcripts })
    });
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Summarization failed');
    summary = data.summary;
  } catch (err) {
    showBanner(`Summarization unavailable. Is Ollama running? (${err.message})`, 'error');
    state.isProcessing = false;
    updateEndSessionBtn();
    return;
  }

  // ── Step 3: Mark session as complete, persist to localStorage ──
  state.dayData.sessions[String(sessionNum)] = { completed: true, summary };
  saveDayData();
  state.isProcessing = false;

  setStatus(`Session ${sessionNum} complete ✓`);
  showBanner(`Session ${sessionNum} complete! Summary saved.`, 'success');
  renderSessionTabs();
  updateEndSessionBtn();
  showSessionSummary(sessionNum, summary);

  // ── Step 4: Auto-push to Notion after Session 3 ──
  // notionPushed flag prevents pushing twice if the user somehow triggers endSession again
  if (sessionNum === 3 && !state.dayData.notionPushed) {
    await pushToNotion();
  }
}

// ─── Notion Push ──────────────────────────────────────────────────────────────
// Sends today's three session summaries to the server, which creates a Notion page.
// If it fails, a retry button is shown — the notionPushed flag ensures we never
// accidentally create duplicate pages even if the user clicks retry multiple times.

async function pushToNotion() {
  setStatus('Pushing to Notion…');
  hideBanner();
  document.getElementById('notion-retry-wrap').classList.add('hidden');

  try {
    const res = await fetch('/api/push-to-notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: state.dayData.date,
        sessions: state.dayData.sessions
      })
    });
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Notion push failed');

    // Persist the flag so refreshing the page doesn't trigger another push
    state.dayData.notionPushed = true;
    saveDayData();
    setStatus('Day complete — saved to Notion ✓');
    showBanner('✓ Day complete — saved to Notion', 'success');
  } catch (err) {
    setStatus('Notion push failed');
    showBanner(`⚠ Notion push failed: ${err.message}`, 'error');
    // Show the retry button so the user can try again without reloading
    document.getElementById('notion-retry-wrap').classList.remove('hidden');
  }
}

// ─── Session Summary Display ──────────────────────────────────────────────────
// Shows the Ollama-generated summary below the exercise cards after a session ends.
// Each line of the summary is rendered as its own styled paragraph.

function showSessionSummary(sessionNum, summary) {
  const section = document.getElementById('session-summary');
  const numEl = document.getElementById('summary-session-num');
  const contentEl = document.getElementById('summary-content');

  numEl.textContent = sessionNum;

  // Split the multi-line summary and render each line as a separate <p>
  // escapeHtml prevents any transcript content from being interpreted as HTML
  const lines = summary.split('\n').filter(l => l.trim());
  contentEl.innerHTML = lines.map(l => `<p class="summary-line">${escapeHtml(l.trim())}</p>`).join('');

  section.classList.remove('hidden');
}

function hideSessionSummary() {
  document.getElementById('session-summary').classList.add('hidden');
}

// Escapes special HTML characters to prevent XSS from transcript content
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
// Runs once on page load. Loads today's stored progress, fetches exercises,
// restores UI state, and wires up all event listeners.

async function init() {
  // Show today's date in the header
  const date = todayKey();
  document.getElementById('today-date').textContent = formatDate(date);

  // Load persisted session data (or create a fresh default if it's a new day)
  state.dayData = loadDayData();

  // Fetch exercises from the server.
  // The server tries Notion first, then falls back to exercises.json.
  try {
    const res = await fetch('/api/exercises');
    const data = await res.json();
    if (!data.success || !data.data.exercises.length) throw new Error('No exercises');
    state.exercises = data.data.exercises;
    document.getElementById('exercises-loading').classList.add('hidden');
  } catch (err) {
    document.getElementById('exercises-loading').classList.add('hidden');
    document.getElementById('exercises-error').classList.remove('hidden');
    showBanner('Could not load exercises. Check exercises.json.', 'error');
    return;
  }

  // Restore the current session:
  // Auto-advance to the first incomplete session, so returning users land in the right place.
  // If all three are done, keep showing Session 3 (the last one).
  const sessions = state.dayData.sessions;
  if (!sessions['1'].completed) state.currentSession = 1;
  else if (!sessions['2'].completed) state.currentSession = 2;
  else state.currentSession = 3;

  renderSessionTabs();
  renderExerciseCards();
  updateEndSessionBtn();

  // If the current session is already complete (e.g. after a page refresh),
  // restore its summary view immediately
  const curData = sessions[String(state.currentSession)];
  if (curData.completed && curData.summary) {
    showSessionSummary(state.currentSession, curData.summary);
    setStatus(`Session ${state.currentSession} complete ✓`);
  }

  // Re-show the Notion success banner if it was already pushed today
  if (state.dayData.notionPushed) {
    showBanner('✓ Day complete — saved to Notion', 'success');
  }

  // If Session 3 is done but Notion push failed before, show the retry button
  if (sessions['3'].completed && !state.dayData.notionPushed) {
    document.getElementById('notion-retry-wrap').classList.remove('hidden');
  }

  // ── Event listeners ──

  // Session tabs: delegate click to the tab container so one listener handles all three
  document.getElementById('session-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.session-tab');
    if (!tab || tab.disabled) return;
    const n = parseInt(tab.dataset.session, 10);
    if (n !== state.currentSession) switchSession(n);
  });

  // End Session button
  document.getElementById('end-session-btn').addEventListener('click', endSession);

  // Banner dismiss button
  document.getElementById('banner-close').addEventListener('click', hideBanner);

  // Notion retry button — only works if session 3 is complete and push hasn't succeeded yet
  document.getElementById('notion-retry-btn').addEventListener('click', () => {
    if (state.dayData.sessions['3'].completed && !state.dayData.notionPushed) {
      pushToNotion();
    }
  });
}

// Kick off initialisation once the DOM is ready
document.addEventListener('DOMContentLoaded', init);
