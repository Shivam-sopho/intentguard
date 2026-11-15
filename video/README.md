# Demo video pipeline

Everything in the video is generated from this folder and recorded against the **live** app:

| Piece | How |
|---|---|
| Narration | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), voice `af_heart` (`tts.py`, script in `script.json`) |
| Picture | The real app driven in Chrome with a visible cursor, captured as 1080p frames over the Chrome DevTools screencast (`record.mjs`) |
| Slides | HTML in `slides/`, same visual language as the app |
| Captions | Burned into the frames while recording, timed to the narration; also written as `out/intentguard-demo.srt` |
| Music and sound cues | Synthesized from scratch, so there is nothing to license (`audio_assets.py`) |
| Edit and mix | `build.py`: cuts the waits while Claude works, places every voice line where it was spoken, ducks the music under the voice, loudness-normalizes to −16 LUFS, encodes H.264 1080p30 |

## Rebuild

```bash
# 1. the app must be running (live Airwallex sandbox + Claude Code)
npm run dev                                   # from the repo root, in another terminal

# 2. narration and audio assets (any Python with kokoro, numpy, soundfile)
HF_HUB_OFFLINE=1 python video/tts.py
python video/audio_assets.py 230

# 3. record and build
cd video && npm install && node record.mjs && cd ..
python video/build.py                         # -> video/out/intentguard-demo.mp4 (+ .srt, thumbnail via ffmpeg)
```

To change what's said, edit `script.json` (`say` is what Kokoro speaks, `caption` is what's shown), then rerun steps 2 and 3. To change pacing or what's on screen, edit the film section at the bottom of `record.mjs`.
