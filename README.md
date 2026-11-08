# JARVIS — local multimodal AI companion (v0.1)

Desktop-first prototype for **Windows 11 + RTX 4070 Ti SUPER 16 GB**. Monorepo: React/TypeScript dashboard, FastAPI, PostgreSQL, Ollama and optional Voicebox + local Whisper STT.

> **What already works:** web camera preview; manual frame capture sent to local Qwen3-VL; persistent text conversations through Ollama; model/endpoint status; record-and-transcribe Russian speech (after enabling local Whisper); optional Russian speech via an installed Voicebox profile. **What is not implemented:** continuous visual analysis, wake-word/VAD, interruption of in-flight TTS, independent initiative, object tracking, solidcv benchmark and real-time low-latency full-duplex audio. The UI is an actual application, not a mockup. No benchmark results are claimed.

## Requirements

- Windows 11, Docker Desktop with WSL2 backend, Ollama for Windows. Node optional (if developing UI locally), Astral uv optional (if developing or testing the API locally).
- Webcam and microphone, Chrome/Edge on `http://localhost:3000`.
- Voicebox desktop optional. GPU resources shared by Ollama and Voicebox. STT defaults to CPU to avoid VRAM contention.

## Quick start (PowerShell)

```powershell
# 1. Install and launch Ollama separately on Windows
ollama pull qwen3:4b
ollama pull qwen3-vl:8b
ollama list

# 2. In the project directory
Copy-Item .env.example .env
# 3. Boot PostgreSQL + API + dashboard
# If Ollama refuses requests from Docker, see Windows note below.
docker compose up --build -d
# 4. Open http://localhost:3000
```

Test health: http://localhost:8000/api/health. View API docs: http://localhost:8000/docs. DB is internal-only; neither PostgreSQL nor models are exposed publicly. Web and API ports bind to **127.0.0.1**.

### Ollama on Windows + Docker

Docker reaches host Ollama at `host.docker.internal:11434`. Ollama may listen only on `127.0.0.1` on the Windows host; if containers cannot reach it, set Windows environment variable `OLLAMA_HOST=0.0.0.0:11434` and restart the Ollama application/service. This makes Ollama listen on network interfaces: **block port 11434 from your LAN/WAN with Windows Firewall**, or prefer a more restricted host-to-WSL networking configuration. The Compose-exposed application itself remains bound to loopback. Check `docker compose logs api` and `/api/health`.

### Local speech-to-text (optional)

Change `ENABLE_STT=true` in `.env`, then `docker compose up -d --force-recreate api`. Press the microphone in the UI, speak Russian, press again to finish. `faster-whisper` downloads the selected model the first time it runs; network is needed for this one-time download. Defaults: `WHISPER_MODEL=small`, `WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`. The initial recording is processed **after you stop**; this is not yet streaming VAD.

### Voicebox speech synthesis (optional)

Start Voicebox on Windows (default `http://127.0.0.1:17493`); create a Russian-capable voice profile in its UI and retrieve its profile ID using `GET /profiles` or the Voicebox API docs. Set `VOICEBOX_PROFILE_ID` in `.env`, and enable sound using the speaker button in Jarvis. Backend uses `POST /generate` and `GET /audio/{generation_id}`. Voicebox may take significant time loading its model and can conflict with Ollama VRAM usage. If Voicebox isn't available, turn off speaking and continue with text.

### Developer mode

```powershell
# Infrastructure / API in containers
 docker compose up -d db api
cd apps/web
npm install
npm run dev
# http://localhost:5173, Vite proxies /api to localhost:8000
```

Backend development and tests (Astral uv manages dependencies; `uv.lock` is the source of truth):

```powershell
cd services/api
uv sync --group dev      # .venv with runtime + dev dependencies (pinned by uv.lock)
uv run pytest            # tests
uv run ruff check app tests
# Local API server (expects DATABASE_URL, OLLAMA_BASE_URL, … from .env or environment)
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

The API image itself builds with `uv sync --locked --no-dev` — see `services/api/Dockerfile`.

### Privacy / limitations

- Jarvis does not use remote inference API endpoints. The first installation/build, model pulls, and dependencies **do** require online access. Fonts use system fallback and do not trigger external requests. Docker images, npm and uv dependencies also need initial downloads.
- Camera stays in the browser. Only an individually sampled JPEG on explicit chat prompts (if checkbox enabled) is sent to the local FastAPI server/Ollama. It is **not stored** in PostgreSQL. No continuous video monitoring yet.
- Text conversations **are stored** in a local PostgreSQL Docker volume. Delete them by deleting the volume (destructive) or implement a retention policy.
- Browser mic recording only goes to your local backend; no browser STT/cloud speech service is used. Keep this app on localhost until authentication and security hardening are added.
- No face recognition, medical monitoring, emergency detection, or actual autonomous actions. This is a developer MVP.

## Structure

```
apps/web/            React 19 + TypeScript + Vite, dark Jarvis UI
services/api/        FastAPI, Ollama chat/vision, optional Whisper/Voicebox, async SQLAlchemy
                     Python deps managed by Astral uv: pyproject.toml + uv.lock (+ .python-version 3.12)
compose.yaml         Postgres 17 + API + Nginx UI
.env.example         Runtime configuration
```

## Useful commands

```powershell
docker compose ps
docker compose logs -f api
docker compose down
# WARNING: next command deletes stored conversations:
docker compose down -v
```

## Next milestones

1. Event-driven frame sampler with OpenCV, then solidcv Rust adapter + benchmark against OpenCV.
2. Full duplex audio via WebSocket, VAD, acoustic echo cancellation, low-latency chunked TTS.
3. Persistent structured world-state and event memory; consent and retention controls.
4. Tool use and proactive behavior with policies and confirmation gates.
5. Tauri app shell, then Android client reusing backend.
