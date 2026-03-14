// Load environment variables from .env into process.env
// (NOTION_TOKEN, NOTION_DATABASE_ID, PORT)
require('dotenv').config();

// Express — HTTP framework; handles routing and middleware
const express = require('express');

// Multer — parses multipart/form-data so we can receive audio file uploads
const multer = require('multer');

// path — cross-platform file/directory path utilities
const path = require('path');

// fs — file system: read exercises.json, write Whisper output, delete temp files
const fs = require('fs');

// exec — runs a shell command and returns stdout/stderr
// Used to invoke the Whisper CLI, which is a Python program (not a JS library)
const { exec } = require('child_process');

// node-fetch v2 — HTTP client for calling Notion and Ollama APIs
// Must stay at v2.x because this file uses CommonJS require() — v3 is ESM-only
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Uploads folder ─────────────────────────────────────────────────────────────
// Whisper is a CLI tool that reads audio from disk (not from memory/stream).
// We save each uploaded audio blob here, run Whisper on it, then delete both
// the audio file and the JSON transcript Whisper produces.
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ── Middleware ─────────────────────────────────────────────────────────────────

// Parse JSON request bodies — used by /api/summarize and /api/push-to-notion
app.use(express.json());

// Parse URL-encoded bodies — fallback for form submissions
app.use(express.urlencoded({ extended: true }));

// Serve everything in public/ as static files:
// index.html → GET /
// app.js     → GET /app.js
// style.css  → GET /style.css
app.use(express.static(path.join(__dirname, 'public')));

// ── CORS ───────────────────────────────────────────────────────────────────────
// Allows the browser to call the local API even if origins differ.
// The pre-flight OPTIONS handler is needed for POST requests with JSON bodies.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Multer — disk storage config ───────────────────────────────────────────────
// We use disk storage (not memory storage) so Whisper can be given a real file path.
// Each file gets a unique name using Date.now() to avoid collisions.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // Preserve the browser-reported extension (.webm, .ogg, .mp4); default to .webm
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `audio_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// ── GET /api/exercises ────────────────────────────────────────────────────────
// Returns the list of exercises for today's sessions.
//
// Strategy:
// 1. Try to pull the "Exercises" field from the Notion database.
//    - The field is a rich_text column whose VALUE is stored per-row (page),
//      not in the database schema. So we must query the actual rows.
//    - We sort rows by last_edited_time descending and take the first row
//      that has a non-empty Exercises value.
//    - The value is a comma-separated string → we split and trim it.
//    - On success: write the result back to exercises.json and return it.
// 2. If Notion is unreachable / token missing / no value found → fall back
//    to reading exercises.json directly (the last known good list).
app.get('/api/exercises', async (req, res) => {
  const exercisesPath = path.join(__dirname, 'exercises.json');
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (token && databaseId) {
    try {
      // Step 1a: Fetch the database schema — just to log property names for debugging.
      // The schema does NOT contain rich_text values, only type metadata.
      const notionRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28'
        }
      });

      if (notionRes.ok) {
        const dbData = await notionRes.json();

        // Log all property names and types so we can see what's available
        const propSummary = Object.entries(dbData.properties || {})
          .map(([n, p]) => `${n} (${p.type})`).join(', ');
        console.log('[exercises] Database properties:', propSummary);

        // Step 1b: Query the rows (pages) inside the database.
        // rich_text columns store their actual values per row, not in the schema —
        // so we have to read the rows to find what exercises are listed.
        // We sort by last_edited_time so we get the most recently updated row first.
        const queryRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28'
          },
          body: JSON.stringify({
            sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
            page_size: 10
          })
        });

        if (!queryRes.ok) {
          const qErr = await queryRes.json().catch(() => ({}));
          throw new Error(`Database query failed: ${qErr.message || queryRes.status}`);
        }

        const queryData = await queryRes.json();
        console.log('[exercises] Pages returned from query:', queryData.results.length);

        let exercises = [];

        // Walk each returned row until we find one with a non-empty Exercises field
        for (const page of queryData.results) {
          const pageProp = page.properties && page.properties['Exercises'];
          if (!pageProp) continue;

          // Extract plain text from rich_text or title block arrays
          let rawText = '';
          if (pageProp.type === 'rich_text') {
            rawText = (pageProp.rich_text || []).map(r => r.plain_text).join('');
          } else if (pageProp.type === 'title') {
            rawText = (pageProp.title || []).map(r => r.plain_text).join('');
          }

          // Split on commas, trim whitespace, remove empty strings
          // (filter(Boolean) handles trailing commas like "exercise1, exercise2,")
          const parsed = rawText.split(',').map(e => e.trim()).filter(Boolean);
          if (parsed.length > 0) {
            console.log('[exercises] Found value on page', page.id, ':', parsed);
            exercises = parsed;
            break; // stop at the first row that has data
          }
        }

        console.log('[exercises] Parsed exercises:', exercises);

        if (exercises.length > 0) {
          // Write the updated list to exercises.json so the local fallback stays fresh
          const today = new Date().toISOString().split('T')[0];
          const data = { last_updated: today, exercises };
          fs.writeFileSync(exercisesPath, JSON.stringify(data, null, 2), 'utf8');
          console.log('[exercises] exercises.json updated from Notion ✓');
          return res.json({ success: true, data });
        } else {
          console.warn('[exercises] No exercises found in any page row — using local fallback');
        }
      } else {
        const errBody = await notionRes.json().catch(() => ({}));
        console.warn(`[exercises] Notion returned ${notionRes.status}: ${errBody.message || 'unknown error'} — using local fallback`);
      }
    } catch (err) {
      console.warn('[exercises] Notion fetch failed:', err.message, '— using local fallback');
    }
  }

  // ── Fallback: read exercises.json from disk ──
  if (!fs.existsSync(exercisesPath)) {
    return res.status(404).json({ success: false, error: 'exercises.json not found' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(exercisesPath, 'utf8'));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to parse exercises.json' });
  }
});

// ── POST /api/transcribe ──────────────────────────────────────────────────────
// Receives a recorded audio blob from the browser, runs Whisper on it,
// and returns the transcript text.
//
// Flow:
// 1. Multer saves the audio blob to uploads/<timestamped>.webm
// 2. We shell out to the Whisper CLI: `whisper <file> --output_format json --output_dir uploads/`
// 3. Whisper writes a .json file alongside the audio with { "text": "..." }
// 4. We read that JSON, extract the text, delete both temp files, respond.
//
// Whisper runs locally — no internet required. Timeout is 2 minutes.
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  console.log('\n─── /api/transcribe ───────────────────────────────────');

  if (!req.file) {
    console.error('[transcribe] No audio file in request');
    return res.status(400).json({ success: false, error: 'No audio file received' });
  }

  const audioPath = req.file.path;           // e.g. uploads/audio_1710000000000.webm
  const exerciseName = req.body.exerciseName || 'Unknown Exercise';
  const outputDir = uploadsDir;

  console.log('[transcribe] Exercise     :', exerciseName);
  console.log('[transcribe] Audio file   :', audioPath);
  console.log('[transcribe] File size    :', req.file.size, 'bytes');
  console.log('[transcribe] MIME type    :', req.file.mimetype);
  console.log('[transcribe] Output dir   :', outputDir);

  // Confirm the file actually landed on disk before invoking Whisper
  if (!fs.existsSync(audioPath)) {
    console.error('[transcribe] ERROR: audio file does not exist on disk after upload');
    return res.status(500).json({ success: false, error: 'Uploaded audio file missing from disk', exerciseName });
  }
  console.log('[transcribe] Audio file confirmed on disk ✓');

  // Build the Whisper CLI command.
  // --output_format json  → write a .json file (easier to parse than plain text)
  // --output_dir          → write the JSON next to the audio in uploads/
  const whisperCmd = `whisper "${audioPath}" --output_format json --output_dir "${outputDir}"`;
  console.log('[transcribe] Whisper cmd  :', whisperCmd);
  console.log('[transcribe] Running Whisper...');

  // exec() is asynchronous — the callback fires when Whisper finishes (or times out)
  exec(whisperCmd, { timeout: 120000 }, (error, stdout, stderr) => {
    // Whisper names the JSON output after the input file, minus extension
    const baseName = path.basename(audioPath, path.extname(audioPath));
    const jsonOutputPath = path.join(outputDir, `${baseName}.json`);

    console.log('[transcribe] Whisper exited');
    console.log('[transcribe] Expected JSON output:', jsonOutputPath);

    if (stdout && stdout.trim()) {
      console.log('[transcribe] STDOUT:\n' + stdout.trim());
    } else {
      console.log('[transcribe] STDOUT: (empty)');
    }

    if (stderr && stderr.trim()) {
      // Whisper often writes progress to stderr — this is normal, not always an error
      console.log('[transcribe] STDERR:\n' + stderr.trim());
    } else {
      console.log('[transcribe] STDERR: (empty)');
    }

    // List what Whisper actually wrote so we can diagnose missing output files
    try {
      const uploadedFiles = fs.readdirSync(outputDir);
      console.log('[transcribe] Files in uploads/ after Whisper:', uploadedFiles);
    } catch (dirErr) {
      console.error('[transcribe] Could not read uploads/ dir:', dirErr.message);
    }

    // Helper: delete the audio file and Whisper's JSON output once we're done
    const cleanup = () => {
      [audioPath, jsonOutputPath].forEach(f => {
        if (fs.existsSync(f)) {
          try {
            fs.unlinkSync(f);
            console.log('[transcribe] Deleted:', f);
          } catch (unlinkErr) {
            console.error('[transcribe] Failed to delete', f, '—', unlinkErr.message);
          }
        }
      });
    };

    // If exec itself failed (Whisper not found, timed out, non-zero exit code)
    if (error) {
      console.error('[transcribe] exec error code :', error.code);
      console.error('[transcribe] exec error signal:', error.signal);
      console.error('[transcribe] exec error message:', error.message);
      cleanup();
      return res.status(500).json({
        success: false,
        error: `Whisper transcription failed: ${error.message}`,
        exerciseName
      });
    }

    // If Whisper exited cleanly but didn't write a JSON file (shouldn't happen normally)
    if (!fs.existsSync(jsonOutputPath)) {
      console.error('[transcribe] ERROR: JSON output file not found at', jsonOutputPath);
      cleanup();
      return res.status(500).json({
        success: false,
        error: 'Whisper output file not found',
        exerciseName
      });
    }

    console.log('[transcribe] JSON output file found ✓');

    // Read and parse Whisper's JSON → extract the .text field
    try {
      const raw = fs.readFileSync(jsonOutputPath, 'utf8');
      console.log('[transcribe] Raw JSON length:', raw.length, 'chars');
      const whisperData = JSON.parse(raw);
      const transcript = whisperData.text ? whisperData.text.trim() : '';
      console.log('[transcribe] Transcript:', transcript || '(empty)');
      cleanup();
      console.log('─── /api/transcribe done ───────────────────────────\n');
      res.json({ success: true, exerciseName, transcript });
    } catch (parseErr) {
      console.error('[transcribe] JSON parse error:', parseErr.message);
      cleanup();
      res.status(500).json({
        success: false,
        error: 'Failed to parse Whisper output',
        exerciseName
      });
    }
  });
});

// ── POST /api/summarize ───────────────────────────────────────────────────────
// Takes all exercise transcripts for a session and asks Ollama/Mistral to
// condense them into brief clinical summaries (one line per exercise).
//
// Ollama runs locally at http://localhost:11434 — no internet required.
// stream: false → wait for the full response before returning (not streaming tokens).
app.post('/api/summarize', async (req, res) => {
  const { exercises, transcripts } = req.body;

  if (!exercises || !transcripts) {
    return res.status(400).json({ success: false, error: 'Missing exercises or transcripts' });
  }

  const exerciseList = exercises.join(', ');

  // Format each exercise with its raw transcript as labelled lines for the prompt
  const transcriptLines = exercises
    .map(ex => `${ex}: ${transcripts[ex] || '(no transcript)'}`)
    .join('\n');

  // The prompt instructs Mistral to produce a tightly-formatted clinical note:
  // one line per exercise, max 15 words, no filler words.
  const prompt = `You are a medical note assistant helping a physiotherapy patient log their recovery.

Convert raw voice transcripts into concise clinical summaries for a physiotherapist.

STRICT RULES:
- One line per exercise maximum
- Format: "Exercise Name: [summary]"
- Focus only on: pain (presence/absence/level), sensations (tightness, burning, fatigue)
- Remove all filler words and conversational language
- No pain / feels good → write "No pain" or "Pain-free"
- It hurts → write "Pain present" with brief description
- Keep each summary under 15 words
- Output ONLY the exercise summaries, nothing else

EXERCISES: ${exerciseList}

TRANSCRIPTS:
${transcriptLines}

RESPONSE:`;

  try {
    // POST to Ollama's generate endpoint — uses the local Mistral model
    const ollamaRes = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral',
        prompt,
        stream: false   // Return one complete JSON response, not a stream of tokens
      })
    });

    if (!ollamaRes.ok) {
      throw new Error(`Ollama returned status ${ollamaRes.status}`);
    }

    const ollamaData = await ollamaRes.json();
    const summary = ollamaData.response ? ollamaData.response.trim() : '';

    res.json({ success: true, summary });
  } catch (err) {
    console.error('Ollama error:', err.message);
    res.status(500).json({
      success: false,
      error: `Summarization failed. Is Ollama running? (${err.message})`
    });
  }
});

// ── POST /api/push-to-notion ──────────────────────────────────────────────────
// Creates a new page in the user's Notion database containing all three
// session summaries for today. Called automatically after Session 3 completes.
//
// Two-step process:
// Step 1 — Fetch the database schema to discover actual column names by type.
//   We can't hardcode "Name" or "Date" because users may name their columns anything.
//   We look for the column with type=title and the column with type=date.
// Step 2 — Create the page using those discovered names, with session summaries
//   as heading_2 + paragraph blocks.
app.post('/api/push-to-notion', async (req, res) => {
  const { date, sessions } = req.body;

  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!token || !databaseId) {
    return res.status(500).json({
      success: false,
      error: 'NOTION_TOKEN or NOTION_DATABASE_ID not configured in .env'
    });
  }

  // Shared headers for all Notion API calls
  const notionHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'   // Pin the API version so changes don't break us
  };

  // ── Step 1: Fetch database schema to find column names by type ──
  // We look for the 'title' type column (required for page name) and
  // the 'date' type column (optional, used to set the log date).
  let titlePropName = null;
  let datePropName = null;

  try {
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      headers: notionHeaders
    });
    const dbData = await dbRes.json();

    if (!dbRes.ok) {
      throw new Error(dbData.message || `Could not fetch database schema (${dbRes.status})`);
    }

    // Iterate over all properties and pick the first title and date columns
    for (const [name, prop] of Object.entries(dbData.properties)) {
      if (prop.type === 'title') titlePropName = name;
      if (prop.type === 'date' && !datePropName) datePropName = name;
    }

    console.log('[notion] Database properties:', Object.entries(dbData.properties).map(([n, p]) => `${n} (${p.type})`).join(', '));
    console.log('[notion] Using title property:', titlePropName);
    console.log('[notion] Using date property :', datePropName || '(none — will skip)');
  } catch (err) {
    console.error('[notion] Schema fetch error:', err.message);
    return res.status(500).json({ success: false, error: `Failed to read Notion database: ${err.message}` });
  }

  if (!titlePropName) {
    return res.status(500).json({
      success: false,
      error: 'Notion database has no title property. Ensure the database has at least one title column.'
    });
  }

  // ── Step 2a: Build the page title ──
  // Parse the YYYY-MM-DD date as local noon to avoid timezone-shifting the day
  const dateObj = new Date(date + 'T12:00:00');
  const titleStr = dateObj.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });
  const pageTitle = `Physio Log — ${titleStr}`;

  // ── Step 2b: Build the page content blocks ──
  // Each session gets a heading_2 followed by paragraph lines from its summary.
  // Sessions are separated by a divider block.
  const sessionLabels = { '1': 'Morning', '2': 'Afternoon', '3': 'Evening' };
  const blocks = [];

  ['1', '2', '3'].forEach(num => {
    const session = sessions[num];
    const label = sessionLabels[num] || `Session ${num}`;

    // Section heading: "Session 1 (Morning)"
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: `Session ${num} (${label})` } }]
      }
    });

    if (session && session.completed && session.summary) {
      // Each non-empty line of the Ollama summary becomes its own paragraph block
      const lines = session.summary.split('\n').filter(l => l.trim());
      lines.forEach(line => {
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: line.trim() } }]
          }
        });
      });
    } else {
      // Session was skipped or didn't complete
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: 'Session not completed.' } }]
        }
      });
    }

    // Add a visual divider between sessions (but not after the last one)
    if (num !== '3') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    }
  });

  // ── Step 2c: Build Notion page properties using discovered column names ──
  const properties = {
    [titlePropName]: {
      title: [{ text: { content: pageTitle } }]
    }
  };

  // Only include the date property if the database has one
  if (datePropName) {
    properties[datePropName] = { date: { start: date } };
  }

  const payload = {
    parent: { database_id: databaseId },  // Target database
    properties,
    children: blocks                       // Page body content
  };

  // ── Step 2d: Create the Notion page ──
  try {
    const notionRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: notionHeaders,
      body: JSON.stringify(payload)
    });

    const notionData = await notionRes.json();

    if (!notionRes.ok) {
      throw new Error(notionData.message || `Notion API error ${notionRes.status}`);
    }

    res.json({ success: true, pageId: notionData.id, pageUrl: notionData.url });
  } catch (err) {
    console.error('[notion] Page create error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Physio Tracker running at http://localhost:${PORT}`);
  console.log(`Uploads directory: ${uploadsDir}`);
});
