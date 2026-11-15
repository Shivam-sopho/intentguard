"""Assemble the IntentGuard demo video from record.mjs output.

Usage: <python-with-numpy+soundfile> video/build.py
Inputs : build/timeline.json, build/frames/*.jpg, build/voice/*.wav, build/audio/*.wav
Outputs: out/intentguard-demo.mp4 (1080p30, captions burned in), out/intentguard-demo.srt
"""
import bisect
import json
import os
import subprocess

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
SR = 48000
FPS = 30

tl = json.load(open(os.path.join(BUILD, "timeline.json")))
frames = sorted(tl["frames"], key=lambda f: f["t"])
events = tl["events"]
t0 = next(e["t"] for e in events if e["type"] == "start")
tend = next(e["t"] for e in events if e["type"] == "end")

cuts = []
open_cut = None
for e in events:
    if e["type"] == "cutStart":
        open_cut = e["t"]
    elif e["type"] == "cutEnd" and open_cut is not None:
        cuts.append((open_cut, e["t"]))
        open_cut = None


def mapped(t):
    """Timeline position after removing the cut (waiting) intervals."""
    t = min(max(t, t0), tend)
    removed = sum(max(0.0, min(t, b) - a) for a, b in cuts if a < t)
    return t - t0 - removed


def in_cut(t):
    return any(a <= t < b for a, b in cuts)


frame_times = [f["t"] for f in frames]


def state_at(t):
    i = bisect.bisect_right(frame_times, t) - 1
    return frames[max(i, 0)]["file"]


total = mapped(tend)
print(f"raw {tend - t0:.1f}s, cut {sum(b - a for a, b in cuts):.1f}s in {len(cuts)} cuts, final {total:.1f}s")

# ---------------------------------------------------------------- video ----
timeline = [(0.0, state_at(t0))]
for f in frames:
    if t0 < f["t"] <= tend and not in_cut(f["t"]):
        timeline.append((mapped(f["t"]), f["file"]))
for a, b in cuts:
    timeline.append((mapped(b) + 1e-4, state_at(b)))
timeline.sort(key=lambda x: x[0])
dedup = []
for tm, fl in timeline:
    if dedup and abs(tm - dedup[-1][0]) < 1e-3:
        dedup[-1] = (tm, fl)
    else:
        dedup.append((tm, fl))

# Resample to an exact constant frame rate: output frame k shows the latest captured frame
# at or before k / FPS. (The concat demuxer stretches sub-40 ms image durations, which
# would desync picture and narration.)
seq = os.path.join(BUILD, "seq")
if os.path.isdir(seq):
    for f in os.listdir(seq):
        os.remove(os.path.join(seq, f))
else:
    os.makedirs(seq)
times = [tm for tm, _ in dedup]
n_frames = int(round(total * FPS))
for k in range(n_frames):
    i = bisect.bisect_right(times, k / FPS) - 1
    os.symlink(dedup[max(i, 0)][1], os.path.join(seq, f"{k:06d}.jpg"))

# Frames are 2560x1440. Encode a 1440p master and a 1080p version downscaled from it
# (supersampled, so text stays crisp), as limited-range BT.709 for correct colour everywhere.
X264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "14", "-x264-params", "aq-mode=3",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-r", str(FPS), "-movflags", "+faststart"]
scale = "scale={w}:{h}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p"
video_1440 = os.path.join(BUILD, "video_1440.mp4")
video_only = os.path.join(BUILD, "video.mp4")
subprocess.run(
    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(seq, "%06d.jpg"),
     "-filter_complex", f"[0:v]split=2[a][b];[a]{scale.format(w=2560, h=1440)}[o1];[b]{scale.format(w=1920, h=1080)}[o2]",
     "-map", "[o1]", *X264, video_1440, "-map", "[o2]", *X264, video_only],
    check=True,
)

# ---------------------------------------------------------------- audio ----
n = int((total + 0.5) * SR)
voice = np.zeros((n, 2), dtype=np.float32)
fx = np.zeros((n, 2), dtype=np.float32)


def load48(path):
    """Load any wav as 48 kHz stereo float32 (resampled by ffmpeg)."""
    tmp = os.path.join(BUILD, "tmp48.wav")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", path, "-ar", str(SR), "-ac", "2", tmp], check=True)
    data, _ = sf.read(tmp, dtype="float32", always_2d=True)
    return data


def place(buf, data, at, gain=1.0):
    s = int(at * SR)
    if s >= len(buf):
        return
    e = min(len(buf), s + len(data))
    buf[s:e] += data[: e - s] * gain


for e in events:
    if e["type"] == "voice":
        place(voice, load48(os.path.join(BUILD, "voice", f"{e['id']}.wav")), mapped(e["t"]), 1.0)

SFX_GAIN = {"click": 0.35, "whoosh": 0.45, "chime": 0.45, "alert": 0.5, "success": 0.45}
cache = {}
for e in events:
    if e["type"] == "sfx" and not in_cut(e["t"]):
        name = e["name"]
        cache.setdefault(name, load48(os.path.join(BUILD, "audio", f"sfx_{name}.wav")))
        place(fx, cache[name], mapped(e["t"]), SFX_GAIN.get(name, 0.5))

music = load48(os.path.join(BUILD, "audio", "music.wav"))
if len(music) < n:
    music = np.concatenate([music, np.zeros((n - len(music), 2), dtype=np.float32)])
music = music[:n].copy()
fade = int(4 * SR)
music[-fade:] *= np.linspace(1, 0, fade)[:, None]

# Duck the music under the voice: envelope follower with 80 ms attack, 700 ms release.
level = np.abs(voice).max(axis=1)
hop = 480
blocks = level[: len(level) // hop * hop].reshape(-1, hop).max(axis=1)
env = np.zeros_like(blocks)
att, rel = np.exp(-hop / (0.08 * SR)), np.exp(-hop / (0.7 * SR))
acc = 0.0
for i, v in enumerate(blocks):
    coef = att if v > acc else rel
    acc = coef * acc + (1 - coef) * v
    env[i] = acc
duck = 1 - 0.55 * np.clip(env / 0.08, 0, 1)
duck = np.repeat(duck, hop)
duck = np.concatenate([duck, np.full(n - len(duck), duck[-1] if len(duck) else 1.0)])
MUSIC_GAIN = 0.14
mix = voice + fx + music * (MUSIC_GAIN * duck)[:, None]
peak = np.max(np.abs(mix))
if peak > 0.98:
    mix *= 0.98 / peak
mix_path = os.path.join(BUILD, "mix.wav")
sf.write(mix_path, mix, SR)

final = os.path.join(OUT, "intentguard-demo.mp4")
for vid, out in [(video_only, final), (video_1440, os.path.join(OUT, "intentguard-demo-1440p.mp4"))]:
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", vid, "-i", mix_path,
         "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-shortest", "-movflags", "+faststart", out],
        check=True,
    )

# ------------------------------------------------------------- captions ----
caps = [e for e in events if e["type"] == "caption" and not in_cut(e["t"])]


def ts(x):
    ms = int(round(x * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


with open(os.path.join(OUT, "intentguard-demo.srt"), "w") as fh:
    for i, c in enumerate(caps):
        start = mapped(c["t"])
        end = mapped(c["end"])
        if i + 1 < len(caps):
            end = min(end, mapped(caps[i + 1]["t"]) - 0.02)
        fh.write(f"{i + 1}\n{ts(start)} --> {ts(max(end, start + 0.5))}\n{c['text']}\n\n")

print("wrote", final)
