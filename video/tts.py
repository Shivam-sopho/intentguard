"""Generate the narration with Kokoro (hexgrad/Kokoro-82M).

Usage:  HF_HUB_OFFLINE=1 <python-with-kokoro> video/tts.py
Writes build/voice/<id>.wav (24 kHz mono) and build/voice/durations.json.
Caption timing uses Kokoro's per-segment output so captions change with the speech.
"""
import json
import os
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf
from kokoro import KPipeline

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "build", "voice")
os.makedirs(OUT, exist_ok=True)

script = json.load(open(os.path.join(HERE, "script.json")))
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
SR = 24000
PAUSE = np.zeros(int(SR * 0.12), dtype=np.float32)  # breath between Kokoro segments

meta = {}
for line in script["lines"]:
    parts = []
    segments = []  # (start_s, end_s, spoken text) per Kokoro segment
    t = 0.0
    for graphemes, _, audio in pipe(line["say"], voice=script["voice"], speed=script["speed"]):
        a = np.asarray(audio, dtype=np.float32)
        segments.append({"start": round(t, 3), "end": round(t + len(a) / SR, 3), "text": graphemes})
        parts += [a, PAUSE]
        t += (len(a) + len(PAUSE)) / SR
    audio = np.concatenate(parts[:-1]) if parts else np.zeros(1, dtype=np.float32)
    # gentle fade in/out so cuts never click
    f = int(SR * 0.01)
    audio[:f] *= np.linspace(0, 1, f)
    audio[-f:] *= np.linspace(1, 0, f)
    sf.write(os.path.join(OUT, f"{line['id']}.wav"), audio, SR)
    meta[line["id"]] = {"duration": round(len(audio) / SR, 3), "segments": segments}
    print(f"{line['id']}  {len(audio) / SR:5.2f}s  {line['say'][:60]}")

json.dump(meta, open(os.path.join(OUT, "durations.json"), "w"), indent=1)
print("total narration", round(sum(m["duration"] for m in meta.values()), 1), "s")
