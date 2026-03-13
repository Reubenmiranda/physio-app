require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Multer config — store audio files in uploads/
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `audio_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// GET /api/exercises
app.get('/api/exercises', (req, res) => {
  const exercisesPath = path.join(__dirname, 'exercises.json');
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

// POST /api/transcribe
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  console.log('\n─── /api/transcribe ───────────────────────────────────');

  if (!req.file) {
    console.error('[transcribe] No audio file in request');
    return res.status(400).json({ success: false, error: 'No audio file received' });
  }

  const audioPath = req.file.path;
  const exerciseName = req.body.exerciseName || 'Unknown Exercise';
  const outputDir = uploadsDir;

  console.log('[transcribe] Exercise     :', exerciseName);
  console.log('[transcribe] Audio file   :', audioPath);
  console.log('[transcribe] File size    :', req.file.size, 'bytes');
  console.log('[transcribe] MIME type    :', req.file.mimetype);
  console.log('[transcribe] Output dir   :', outputDir);

  // Verify the audio file actually landed on disk
  if (!fs.existsSync(audioPath)) {
    console.error('[transcribe] ERROR: audio file does not exist on disk after upload');
    return res.status(500).json({ success: false, error: 'Uploaded audio file missing from disk', exerciseName });
  }
  console.log('[transcribe] Audio file confirmed on disk ✓');

  // Build whisper command
  const whisperCmd = `whisper "${audioPath}" --output_format json --output_dir "${outputDir}"`;
  console.log('[transcribe] Whisper cmd  :', whisperCmd);
  console.log('[transcribe] Running Whisper...');

  exec(whisperCmd, { timeout: 120000 }, (error, stdout, stderr) => {
    // Determine expected JSON output path
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
      console.log('[transcribe] STDERR:\n' + stderr.trim());
    } else {
      console.log('[transcribe] STDERR: (empty)');
    }

    // List files in uploads dir so we can see what Whisper actually wrote
    try {
      const uploadedFiles = fs.readdirSync(outputDir);
      console.log('[transcribe] Files in uploads/ after Whisper:', uploadedFiles);
    } catch (dirErr) {
      console.error('[transcribe] Could not read uploads/ dir:', dirErr.message);
    }

    // Cleanup helper
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

    // Read Whisper JSON output
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

// POST /api/summarize
app.post('/api/summarize', async (req, res) => {
  const { exercises, transcripts } = req.body;

  if (!exercises || !transcripts) {
    return res.status(400).json({ success: false, error: 'Missing exercises or transcripts' });
  }

  const exerciseList = exercises.join(', ');
  const transcriptLines = exercises
    .map(ex => `${ex}: ${transcripts[ex] || '(no transcript)'}`)
    .join('\n');

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
    const ollamaRes = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral',
        prompt,
        stream: false
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

// POST /api/push-to-notion
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

  const notionHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  // ── Step 1: Fetch the database schema to discover actual property names ──
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

    // Find properties by type, not by name
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

  // ── Step 2: Build page title ──
  const dateObj = new Date(date + 'T12:00:00');
  const titleStr = dateObj.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });
  const pageTitle = `Physio Log — ${titleStr}`;

  // ── Step 3: Build Notion content blocks ──
  const sessionLabels = { '1': 'Morning', '2': 'Afternoon', '3': 'Evening' };
  const blocks = [];

  ['1', '2', '3'].forEach(num => {
    const session = sessions[num];
    const label = sessionLabels[num] || `Session ${num}`;

    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: `Session ${num} (${label})` } }]
      }
    });

    if (session && session.completed && session.summary) {
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
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: 'Session not completed.' } }]
        }
      });
    }

    if (num !== '3') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    }
  });

  // ── Step 4: Build properties using discovered names ──
  const properties = {
    [titlePropName]: {
      title: [{ text: { content: pageTitle } }]
    }
  };

  if (datePropName) {
    properties[datePropName] = { date: { start: date } };
  }

  const payload = {
    parent: { database_id: databaseId },
    properties,
    children: blocks
  };

  // ── Step 5: Create the page ──
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
