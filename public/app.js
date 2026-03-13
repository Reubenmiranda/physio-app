// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  exercises: [],           // string[] from exercises.json
  currentSession: 1,       // 1 | 2 | 3
  recordings: {},          // { exerciseName: Blob }
  transcripts: {},         // { exerciseName: string }
  activeRecorder: null,    // { exerciseName, mediaRecorder, chunks, timerInterval }
  isProcessing: false,     // true while transcribing or summarizing
  dayData: null,           // loaded from / saved to localStorage
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatDate(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function setStatus(msg) {
  const el = document.getElementById('status-message');
  if (el) el.textContent = msg;
}

function showBanner(msg, type = 'info') {
  // type: 'success' | 'error' | 'info' | 'warning'
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

function loadDayData() {
  const date = todayKey();
  const stored = localStorage.getItem(`physio_day_${date}`);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (_) {}
  }
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

function saveDayData() {
  const date = todayKey();
  localStorage.setItem(`physio_day_${date}`, JSON.stringify(state.dayData));
}

// ─── Session Tab UI ───────────────────────────────────────────────────────────

function renderSessionTabs() {
  [1, 2, 3].forEach(n => {
    const tab = document.getElementById(`tab-${n}`);
    const statusEl = document.getElementById(`tab-status-${n}`);
    const sessionData = state.dayData.sessions[String(n)];

    tab.classList.toggle('active', n === state.currentSession);
    tab.classList.toggle('completed', sessionData.completed);

    if (sessionData.completed) {
      statusEl.textContent = '✓';
      statusEl.className = 'tab-status tab-status-done';
    } else if (n === state.currentSession) {
      statusEl.textContent = '●';
      statusEl.className = 'tab-status tab-status-active';
    } else {
      statusEl.textContent = '';
      statusEl.className = 'tab-status';
    }

    // Disable future sessions that aren't unlocked yet
    const prevCompleted = n === 1 || state.dayData.sessions[String(n - 1)].completed;
    tab.disabled = !prevCompleted && !sessionData.completed;
  });
}

function switchSession(n) {
  if (state.isProcessing) return;
  if (state.activeRecorder) stopCurrentRecording();

  state.currentSession = n;
  state.recordings = {};
  state.transcripts = {};
  renderSessionTabs();
  renderExerciseCards();
  updateEndSessionBtn();

  // Show summary if already completed
  const sessionData = state.dayData.sessions[String(n)];
  if (sessionData.completed && sessionData.summary) {
    showSessionSummary(n, sessionData.summary);
  } else {
    hideSessionSummary();
  }

  setStatus('Ready to record');
}

// ─── Exercise Cards ───────────────────────────────────────────────────────────

function renderExerciseCards() {
  const container = document.getElementById('exercise-cards');
  container.innerHTML = '';

  state.exercises.forEach(name => {
    const card = buildExerciseCard(name);
    container.appendChild(card);
  });
}

function buildExerciseCard(exerciseName) {
  const card = document.createElement('article');
  card.className = 'exercise-card';
  card.dataset.exercise = exerciseName;
  card.id = `card-${cssId(exerciseName)}`;

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

  // Restore visual state if recording exists
  if (state.recordings[exerciseName]) {
    setCardRecorded(exerciseName);
  }

  return card;
}

function cssId(name) {
  return name.replace(/\s+/g, '-').toLowerCase();
}

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

async function handleRecordClick(exerciseName) {
  if (state.isProcessing) return;

  // If this exercise is currently recording → stop it
  if (state.activeRecorder && state.activeRecorder.exerciseName === exerciseName) {
    stopCurrentRecording();
    return;
  }

  // If another exercise is recording → stop it first
  if (state.activeRecorder) {
    stopCurrentRecording();
  }

  // Start new recording
  await startRecording(exerciseName);
}

async function startRecording(exerciseName) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showBanner('Microphone access required. Please allow in browser settings.', 'error');
    return;
  }

  const chunks = [];
  const mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });

  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
    state.recordings[exerciseName] = blob;
    setCardRecorded(exerciseName);
    updateEndSessionBtn();
  };

  // Timer
  let seconds = 0;
  const timerEl = document.getElementById(`timer-${cssId(exerciseName)}`);
  const timerInterval = setInterval(() => {
    seconds++;
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, '0');
    if (timerEl) timerEl.textContent = `${m}:${s}`;
  }, 1000);

  mediaRecorder.start(250); // collect data every 250ms
  setCardRecording(exerciseName);
  setStatus(`Recording ${exerciseName}…`);

  state.activeRecorder = { exerciseName, mediaRecorder, chunks, timerInterval, stream };
}

function stopCurrentRecording() {
  if (!state.activeRecorder) return;
  const { mediaRecorder, timerInterval } = state.activeRecorder;
  clearInterval(timerInterval);
  if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  state.activeRecorder = null;
  setStatus('Ready to record');
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function getFileExtension(mimeType) {
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('ogg')) return '.ogg';
  if (mimeType.includes('mp4')) return '.mp4';
  return '.webm';
}

// ─── End Session Flow ─────────────────────────────────────────────────────────

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

async function endSession() {
  if (state.isProcessing) return;
  if (state.activeRecorder) stopCurrentRecording();

  const sessionNum = state.currentSession;
  state.isProcessing = true;
  updateEndSessionBtn();
  hideBanner();

  // Disable all record buttons
  document.querySelectorAll('.btn-record, .btn-rerecord, .btn-stop').forEach(b => b.disabled = true);

  // ── Step 1: Transcribe each exercise sequentially ──
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
      showBanner(`Transcription failed for ${exerciseName}. Please re-record.`, 'error');
      // Re-enable that card's record button
      const btn = document.getElementById(`rec-btn-${cssId(exerciseName)}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Re-record'; btn.className = 'btn btn-rerecord'; }
      state.isProcessing = false;
      updateEndSessionBtn();
      return;
    }
  }

  // ── Step 2: Summarize ──
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

  // ── Step 3: Save to state ──
  state.dayData.sessions[String(sessionNum)] = { completed: true, summary };
  saveDayData();
  state.isProcessing = false;

  setStatus(`Session ${sessionNum} complete ✓`);
  showBanner(`Session ${sessionNum} complete! Summary saved.`, 'success');
  renderSessionTabs();
  updateEndSessionBtn();
  showSessionSummary(sessionNum, summary);

  // ── Step 4: If Session 3, push to Notion ──
  if (sessionNum === 3 && !state.dayData.notionPushed) {
    await pushToNotion();
  }
}

// ─── Notion Push ──────────────────────────────────────────────────────────────

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

    state.dayData.notionPushed = true;
    saveDayData();
    setStatus('Day complete — saved to Notion ✓');
    showBanner('✓ Day complete — saved to Notion', 'success');
  } catch (err) {
    setStatus('Notion push failed');
    showBanner(`⚠ Notion push failed: ${err.message}`, 'error');
    document.getElementById('notion-retry-wrap').classList.remove('hidden');
  }
}

// ─── Session Summary Display ──────────────────────────────────────────────────

function showSessionSummary(sessionNum, summary) {
  const section = document.getElementById('session-summary');
  const numEl = document.getElementById('summary-session-num');
  const contentEl = document.getElementById('summary-content');

  numEl.textContent = sessionNum;

  // Render each line as a paragraph
  const lines = summary.split('\n').filter(l => l.trim());
  contentEl.innerHTML = lines.map(l => `<p class="summary-line">${escapeHtml(l.trim())}</p>`).join('');

  section.classList.remove('hidden');
}

function hideSessionSummary() {
  document.getElementById('session-summary').classList.add('hidden');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Display today's date
  const date = todayKey();
  document.getElementById('today-date').textContent = formatDate(date);

  // Load day data
  state.dayData = loadDayData();

  // Load exercises
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

  // Restore current session: pick the first incomplete one, or 3 if all done
  const sessions = state.dayData.sessions;
  if (!sessions['1'].completed) state.currentSession = 1;
  else if (!sessions['2'].completed) state.currentSession = 2;
  else state.currentSession = 3;

  renderSessionTabs();
  renderExerciseCards();
  updateEndSessionBtn();

  // Restore summary if current session is complete
  const curData = sessions[String(state.currentSession)];
  if (curData.completed && curData.summary) {
    showSessionSummary(state.currentSession, curData.summary);
    setStatus(`Session ${state.currentSession} complete ✓`);
  }

  // Show notion status
  if (state.dayData.notionPushed) {
    showBanner('✓ Day complete — saved to Notion', 'success');
  }

  // Show retry button if session 3 is done but Notion push failed
  if (sessions['3'].completed && !state.dayData.notionPushed) {
    document.getElementById('notion-retry-wrap').classList.remove('hidden');
  }

  // Wire up session tabs
  document.getElementById('session-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.session-tab');
    if (!tab || tab.disabled) return;
    const n = parseInt(tab.dataset.session, 10);
    if (n !== state.currentSession) switchSession(n);
  });

  // Wire up End Session button
  document.getElementById('end-session-btn').addEventListener('click', endSession);

  // Wire up banner close
  document.getElementById('banner-close').addEventListener('click', hideBanner);

  // Wire up Notion retry
  document.getElementById('notion-retry-btn').addEventListener('click', () => {
    if (state.dayData.sessions['3'].completed && !state.dayData.notionPushed) {
      pushToNotion();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
