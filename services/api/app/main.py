from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, String, Text, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

log = logging.getLogger("jarvis")
logging.basicConfig(level=logging.INFO)

class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://jarvis:jarvis@localhost:5432/jarvis"
    ollama_base_url: str = "http://localhost:11434"
    ollama_chat_model: str = "qwen3:4b"
    ollama_vision_model: str = "qwen3-vl:8b"
    voicebox_url: str = "http://localhost:17493"
    voicebox_profile_id: str = ""
    whisper_model: str = "small"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    enable_stt: bool = False
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

settings = Settings()
engine = create_async_engine(settings.database_url, pool_pre_ping=True)
Session = async_sessionmaker(engine, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(12))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

@asynccontextmanager
async def lifespan(app: FastAPI):
    # For the starter only; replace with Alembic migrations when the schema evolves.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()

app = FastAPI(title="Jarvis Local AI", version="0.1.0", lifespan=lifespan)
# All public-facing ports are bound to 127.0.0.1 in Compose.
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173"], allow_methods=["GET", "POST"], allow_headers=["*"])

SYSTEM = ("Ты Jarvis — дружелюбный, внимательный русскоязычный локальный ассистент. "
          "Отвечай естественно, обычно в 1–4 предложениях. Не выдумывай сведения о том, "
          "что видишь: изображение доступно только если приложено к текущему запросу. "
          "Не утверждай, что постоянно следишь за миром, если это не так. "
          "Если пользователь просит помощи, будь конкретным и полезным.")

class ChatRequest(BaseModel):
    conversation_id: str | None = None
    text: str = Field(min_length=1, max_length=4000)
    image: str | None = Field(default=None, max_length=3_000_000) # base64 jpeg

class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)

@app.get("/api/health")
async def health():
    async def probe(url):
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                r = await client.get(url)
                return r.status_code < 500
        except Exception:
            return False
    async def database_ok():
        async def check():
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        try:
            await asyncio.wait_for(check(), timeout=2)
            return True
        except Exception:
            return False
    ollama, voicebox, database = await asyncio.gather(
        probe(f"{settings.ollama_base_url}/api/tags"),
        probe(f"{settings.voicebox_url}/health"),
        database_ok(),
    )
    return {"api": "online", "database": "online" if database else "offline", "ollama": ollama, "voicebox": voicebox,
            "chat_model": settings.ollama_chat_model, "vision_model": settings.ollama_vision_model,
            "stt_enabled": settings.enable_stt, "tts_configured": bool(settings.voicebox_profile_id)}

@app.get("/api/conversations/{conversation_id}")
async def history(conversation_id: str):
    async with Session() as session:
        rows = (await session.scalars(select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at).limit(100))).all()
        return [{"id": msg.id, "role": msg.role, "content": msg.content} for msg in rows]

@app.post("/api/chat")
async def chat(body: ChatRequest):
    started = time.perf_counter()
    if body.image:
        try:
            data = base64.b64decode(body.image, validate=True)
            if not data.startswith(b"\xff\xd8") or len(data) > 1_000_000:
                raise ValueError("invalid JPEG")
        except Exception:
            raise HTTPException(status_code=400, detail="Expected JPEG base64 image up to 1MB")
    conversation_id = body.conversation_id or str(uuid4())
    async with Session() as session:
        existing = await session.get(Conversation, conversation_id)
        if existing is None:
            if body.conversation_id:
                raise HTTPException(status_code=404, detail="Conversation not found")
            session.add(Conversation(id=conversation_id))
            await session.flush()
        previous = (await session.scalars(select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at.desc()).limit(12))).all()
        messages = [{"role": "system", "content": SYSTEM}]
        messages += [{"role": m.role, "content": m.content} for m in reversed(previous)]
        user_msg = {"role": "user", "content": body.text}
        if body.image:
            user_msg["images"] = [body.image]
        messages.append(user_msg)
        model = settings.ollama_vision_model if body.image else settings.ollama_chat_model
        try:
            async with httpx.AsyncClient(timeout=180) as client:
                response = await client.post(f"{settings.ollama_base_url}/api/chat", json={"model": model, "messages": messages, "stream": False, "think": False})
                response.raise_for_status()
                answer = response.json().get("message", {}).get("content", "").strip()
                if not answer:
                    raise ValueError("Empty response from Ollama")
        except Exception as exc:
            log.warning("Ollama request failed: %s", exc)
            raise HTTPException(status_code=503, detail=f"Ollama unavailable or model not installed ({model}). Check ollama list.")
        session.add_all([Message(id=str(uuid4()), conversation_id=conversation_id, role="user", content=body.text),
                         Message(id=str(uuid4()), conversation_id=conversation_id, role="assistant", content=answer)])
        await session.commit()
    return {"conversation_id": conversation_id, "answer": answer, "model": model, "latency_ms": round((time.perf_counter()-started)*1000)}

# Lazy load STT; keeping it disabled avoids the initial model download and CPU usage.
_whisper = None
_whisper_lock = asyncio.Lock()

def _transcribe_file(path: str) -> str:
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        _whisper = WhisperModel(settings.whisper_model, device=settings.whisper_device, compute_type=settings.whisper_compute_type)
    segments, _ = _whisper.transcribe(path, language="ru", vad_filter=True, beam_size=3)
    return " ".join(segment.text.strip() for segment in segments).strip()

@app.post("/api/stt")
async def transcribe(audio: UploadFile = File(...)):
    if not settings.enable_stt:
        raise HTTPException(status_code=503, detail="STT is disabled. Set ENABLE_STT=true in .env and restart API")
    data = await audio.read(8_000_001)
    if len(data) > 8_000_000:
        raise HTTPException(status_code=413, detail="Audio too large (max 8MB)")
    suffix = Path(audio.filename or "voice.webm").suffix or ".webm"
    if suffix not in (".webm", ".wav", ".mp3", ".ogg", ".mp4"):
        raise HTTPException(status_code=400, detail="Unsupported audio format")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp:
        temp.write(data)
        filename = temp.name
    try:
        async with _whisper_lock:
            text = await asyncio.to_thread(_transcribe_file, filename)
        return {"text": text}
    finally:
        os.unlink(filename)

@app.post("/api/tts")
async def synthesize(body: SpeechRequest):
    if not settings.voicebox_profile_id:
        raise HTTPException(status_code=503, detail="Set VOICEBOX_PROFILE_ID in .env to enable Voicebox TTS")
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            generation = await client.post(f"{settings.voicebox_url}/generate", json={"text": body.text, "profile_id": settings.voicebox_profile_id, "language": "ru"})
            generation.raise_for_status()
            generation_id = generation.json()["id"]
            # Some generation configurations may queue the work; poll the file endpoint.
            for _ in range(50):
                r = await client.get(f"{settings.voicebox_url}/audio/{generation_id}")
                if r.status_code == 200 and r.headers.get("content-type", "").startswith("audio/"):
                    from fastapi.responses import Response
                    return Response(content=r.content, media_type=r.headers["content-type"])
                await asyncio.sleep(0.4)
            raise RuntimeError("Voicebox audio was not ready")
    except Exception as exc:
        log.warning("Voicebox failed: %s", exc)
        raise HTTPException(status_code=503, detail="Voicebox unavailable; check application, chosen profile and model")
