#### Task 2.1.4: Audio capture
**Files:** create `apps/ai/app/audio.py`; `apps/ai/Dockerfile` (deploy/docker/ai.Dockerfile) adds `yt-dlp` (pinned, with renovate comment) and `ffmpeg`.
- [ ] `async def fetch_audio(video_id: str, bucket: str) -> str | None` — `yt-dlp -x --audio-format m4a` to a temp dir, uploads to `gs://{bucket}/audio/{video_id}.m4a` (ADC), returns object key, or `None` on any failure (logged, not raised).
- [ ] Test with a fake runner: success returns key; non-zero exit returns `None`.

