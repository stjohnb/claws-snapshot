# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "faster-whisper==1.2.1",
#   "fastapi==0.115.6",
#   "uvicorn==0.34.0",
#   "python-multipart==0.0.20",
# ]
# ///
"""Minimal OpenAI-compatible /v1/audio/transcriptions server for Claws.

Run by deploy/whisper.service via `uv run --script`. Replaces Speaches,
which is not published on PyPI and could never be installed by uvx.
"""
import io
import os

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from faster_whisper import WhisperModel

MODEL_ID = os.environ.get("WHISPER_MODEL", "Systran/faster-whisper-base")
HOST = os.environ.get("WHISPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WHISPER_PORT", "9000"))

model = WhisperModel(MODEL_ID, device="cpu", compute_type="int8")
app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(default=""),
    prompt: str = Form(default=""),
):
    audio = await file.read()
    segments, _info = globals()["model"].transcribe(
        io.BytesIO(audio), initial_prompt=prompt or None
    )
    return {"text": "".join(s.text for s in segments).strip()}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
