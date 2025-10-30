# PDF → Video Summaries

A self-hosted service that turns PDF documents into narrated summary videos. The backend extracts text, creates AI‑generated slides, renders branded imagery, records ElevenLabs voiceovers, and compiles everything into an MP4 or MOV using `ffmpeg`—all without any client-side dependencies.

## Highlights
- **Document ingestion** – Extracts clean text from uploaded PDFs using `pdf-parse` with whitespace normalization.
- **AI slide planning** – Uses the Longcat/OpenAI stack to outline 3‑6 slides with headlines, bullets, and optional chart hints.
- **Branded slide visuals** – Renders SVG → PNG slides locally with `resvg`, pulling supporting art from Supabase storage when configured.
- **Automatic narration** – Generates per-slide voiceovers via ElevenLabs and stitches them into a single track.
- **Deterministic video render** – Builds videos locally with `ffmpeg-static`/`fluent-ffmpeg`; no third-party renderers.

> **Note:** Background music and Sonauto integration were removed. The app now focuses strictly on narrated summaries, simplifying configuration and reducing dependencies.

## Getting Started

```bash
npm install
cp .env.example .env  # fill in required values before running
npm run dev           # starts Express on http://localhost:8787
```

### Required Environment Variables
| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Used by Longcat/OpenAI summarization pipeline |
| `JSONCUT_API_KEY`, `JSONCUT_BASE_URL` (optional) | Only needed if you call the JSONCut API elsewhere |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Required for TTS voiceovers |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE` | Needed if you want remote illustration assets; otherwise leave unset |
| `SUPABASE_BUCKET` | Asset bucket name (default `slides-assets`) |
| `DEFAULT_ORIENTATION`, `VIDEO_FPS`, `VIDEO_FORMAT` | Rendering defaults (see `.env.example`) |

If Supabase credentials are not provided, the renderer falls back to purely typographic slides.

## Running the Service

- `npm run dev` – Launches the Express server with `.env` loaded (recommended during development).
- `npm start` – Starts the server in production mode. Make sure the `tmp/` directory is writable for render jobs.

The server exposes static assets from `public/`, so opening `http://localhost:8787` gives you a simple dashboard for manual testing.

## API

### `POST /api/create-video`
Multipart form-data fields:

| Field | Type | Notes |
| --- | --- | --- |
| `pdf` | file | **Required.** PDF up to 25 MB. |
| `orientation` | string | Optional; `9:16` (default) or `16:9`. |

Sample response:
```jsonc
{
  "ok": true,
  "downloadUrl": "/api/download?fileId=abc123&fmt=mp4&local=1",
  "filename": "summary-video.mp4",
  "orientation": "9:16",
  "durationSeconds": 60.5,
  "provider": "local",
  "slides": [
    { "index": 1, "headline": "Overview", "imageSource": "supabase-illustration", "chart": null, "ttsDuration": 10.1 }
  ],
  "progress": [
    { "step": "analyze", "status": "completed", "detail": "Extracted 1800 chars" }
  ]
}
```

### `GET /api/download`
Returns the rendered video as an attachment and deletes the temp file once the stream closes.

## Front-End

`public/index.html` is a lightweight testing UI:
- Drag-and-drop PDF upload
- Orientation toggle (vertical or horizontal)
- Live progress log with stepper UI
- Download link once rendering finishes

No build pipeline is required; the file is served directly by Express.

## Project Structure

```
assets/         → Character art & fonts bundled with slides
lib/            → Core helpers (summaries, Supabase asset fetcher, TTS, rendering glue)
public/         → Static client UI
scripts/        → Dev utilities (slide SVG debugging, font inspection)
src/            → Low-level SVG rendering utilities
tmp/            → Working directory for renders (cleaned per job)
server.js       → Express entrypoint orchestrating the pipeline
slide-svg.js    → SVG template + renderer used for each slide
```

## Development Notes
- `server.js` coordinates the end-to-end flow; start here when troubleshooting.
- Temporary job folders live under `tmp/job-*`. The rendered video is moved to `tmp/renders/` until downloaded.
- Voiceover clips are padded to 10 s each to keep slide durations consistent; adjust `buildVoiceover` if you need variable timing.
- The system currently assumes stable network access to ElevenLabs and (optionally) Supabase.
- Keep fonts in `assets/fonts/` synced with `src/font-embed.js` to ensure accurate SVG text rendering.

## Roadmap / Ideas
- Optional OpenAI or local TTS fallback (scaffolding already present in `.env`).
- Slide theming controls exposed via the API.
- Background music reintegration behind a feature flag if ever needed again.

---

If you find issues after the music cleanup, search for `TODO:` markers or open GitHub issues with reproduction details. Enjoy building faster narrated summaries!
