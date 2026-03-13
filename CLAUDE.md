# CLAUDE.md — Physio Tracker

Instructions for Claude Code when working in this project.

## Project summary

Local physiotherapy session tracker. No database, no auth, no cloud audio.
- **Frontend:** HTML5 + Vanilla JS + CSS3 (no frameworks)
- **Backend:** Node.js + Express
- **Transcription:** Whisper CLI (local, `whisper` must be in PATH)
- **Summarization:** Ollama + Mistral at `http://localhost:11434`
- **Storage:** localStorage (keyed by date) + exercises.json
- **Notion push:** After Session 3 completes, auto-push to Notion API

## Key files

- `server.js` — all Express routes
- `public/app.js` — all client-side logic
- `public/style.css` — all styles (CSS variables, no preprocessors)
- `public/index.html` — single page
- `exercises.json` — updated twice a week manually
- `.env` — NOTION_TOKEN, NOTION_DATABASE_ID, PORT

## Architecture decisions

- `node-fetch` v2 (CommonJS, not ESM) — required because server.js uses `require()`
- Audio recorded via MediaRecorder API; only one exercise records at a time
- Transcripts processed sequentially (not parallel) to avoid overloading Whisper
- localStorage key format: `physio_day_YYYY-MM-DD`
- Notion push guarded by `notionPushed` flag — never pushes twice per day
- `uploads/` folder auto-created on server start; files deleted after transcription

## Running locally

```
npm install
copy .env.example .env   # fill in values
start.bat                # starts ollama + node + opens browser
```

## Constraints

- Never add authentication
- Never store audio permanently
- Never use a database — localStorage only
- Never push to cloud (audio stays local, only summary goes to Notion)
- Keep `node-fetch` at v2.x (CommonJS compatible)
- Whisper command: `whisper <file> --output_format json --output_dir <dir>`
- Ollama endpoint: `http://localhost:11434/api/generate` with model `mistral`
- Notion API version header: `2022-06-28`

## Error handling pattern

All errors shown as non-blocking banners (`.banner` element).
No `alert()` or `confirm()` dialogs.
On transcription failure: allow re-record of that specific exercise without losing others.
On Notion failure: show retry button, keep data in localStorage.
