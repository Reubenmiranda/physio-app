# Physio Tracker

Local physiotherapy session tracker for spine injury recovery. Records voice notes per exercise, transcribes via Whisper, summarizes via Ollama/Mistral, and pushes a daily log to Notion after the third session.

---

## Prerequisites

Install these before running the app:

1. **Node.js** (v18+) — https://nodejs.org
2. **OpenAI Whisper** (local CLI) — `pip install -r requirements.txt`
3. **Ollama** — https://ollama.com/download
   - After installing: `ollama pull mistral`
4. **Notion account** with an integration token and a database

---

## Setup

### 1. Install dependencies

```bat
cd physio-app
npm install
```

### 2. Configure environment

```bat
copy .env.example .env
```

Edit `.env` and fill in:
```
NOTION_TOKEN=secret_xxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxx
```

**Getting your Notion token:**
1. Go to https://www.notion.so/my-integrations
2. Create a new integration (name it "Physio Tracker")
3. Copy the Internal Integration Token

**Getting your Notion database ID:**
1. Create a new database page in Notion
2. Add your integration to the database (Share → Invite → select your integration)
3. The database ID is the 32-character string in the URL:
   `https://notion.so/workspace/DATABASE_ID?v=...`
4. Make sure your database has a **Name** (title) property and a **Date** property

### 3. Verify Whisper is working

```bat
whisper --help
```

If the command isn't found, ensure `whisper` is in your PATH (Whisper is installed via pip).

### 4. Update exercises (twice a week)

Edit `exercises.json`:
```json
{
  "last_updated": "2026-03-11",
  "exercises": [
    "Glute Bridges",
    "Hamstring Stretch",
    "Core Hold",
    "Hip Flexor Stretch",
    "Dead Bug"
  ]
}
```

---

## Running the app

Double-click **start.bat** or run in terminal:

```bat
start.bat
```

This will:
1. Start Ollama (if not already running)
2. Start the Node.js server on port 5000
3. Open http://localhost:5000 in your browser

To stop everything:

```bat
stop.bat
```

---

## Daily workflow

1. Run `start.bat`
2. **Session 1 (Morning):** Record each exercise → End Session
3. **Session 2 (Afternoon):** Record each exercise → End Session
4. **Session 3 (Evening):** Record each exercise → End Session → auto-pushes to Notion

Sessions are stored in `localStorage` keyed by date — safe to refresh or close the browser.

---

## File structure

```
physio-app/
├── server.js          Backend (Express)
├── package.json
├── .env               Your secrets (never commit)
├── .env.example       Template
├── .gitignore
├── exercises.json     Current week's exercises
├── start.bat          Start everything
├── stop.bat           Stop everything
├── uploads/           Temporary audio files (auto-cleaned)
└── public/
    ├── index.html
    ├── app.js
    └── style.css
```

---

## API endpoints

| Method | Endpoint             | Description                        |
|--------|----------------------|------------------------------------|
| GET    | /api/exercises       | Returns exercises.json             |
| POST   | /api/transcribe      | Transcribes audio via Whisper      |
| POST   | /api/summarize       | Summarizes transcripts via Ollama  |
| POST   | /api/push-to-notion  | Creates a Notion page              |

---

## Troubleshooting

**"Transcription failed"** — Whisper not installed or not in PATH. Run `pip install openai-whisper` and restart terminal.

**"Is Ollama running?"** — Run `ollama serve` manually or check that `start.bat` launched it.

**"Notion push failed"** — Check your `NOTION_TOKEN` and `NOTION_DATABASE_ID` in `.env`. Ensure your integration has access to the database.

**Microphone not working** — Open Chrome/Edge settings and allow microphone for localhost.
