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

def load_take(path):
    tl = json.load(open(path))
    frames = sorted(tl["frames"], key=lambda f: f["t"])
    events = tl["events"]
    t0 = next(e["t"] for e in events if e["type"] == "start")
    tend = next(e["t"] for e in events if e["type"] == "end")
    cuts, open_cut = [], None
    for e in events:
        if e["type"] == "cutStart":
            open_cut = e["t"]
        elif e["type"] == "cutEnd" and open_cut is not None:
            cuts.append((open_cut, e["t"]))
            open_cut = None
    return frames, events, t0, tend, cuts


frames, events, t0, tend, cuts = load_take(os.path.join(BUILD, "timeline.json"))
durs = json.load(open(os.path.join(BUILD, "voice", "durations.json")))
# voice timings the main take was recorded with (the insert may re-voice its own lines later)
main_durs_path = os.path.join(BUILD, "main_durations.json")
main_durs = json.load(open(main_durs_path)) if os.path.exists(main_durs_path) else durs

# Optional insert take (record.mjs with INSERT=dashboard): replaces the main take's dashboard
# section, from the black frame after the fade-out before it to the black frame after it.
insert_path = os.path.join(BUILD, "insert", "timeline.json")
splice = None
holds = []  # (main-take time, seconds): freeze the frame shown at that time
if os.path.exists(insert_path) and any(e["type"] == "voice" and e["id"] == "vD1" for e in events):
    def voice_end(eid, tail):
        e = next(e for e in events if e["type"] == "voice" and e["id"] == eid)
        return e["t"] + main_durs[eid]["duration"] + tail
    win_a = voice_end("v15c", 0.3) + 1.12  # after the 0.6 s pause and the 0.45 s fade to black
    win_b = voice_end("vD5", 0.6) + 0.5    # after the fade to black that ends the scene
    ins = load_take(insert_path)
    splice = {"a": win_a, "b": win_b, "ins": ins, "len": ins[3] - ins[2]}
    cuts = sorted(cuts + [(win_a, win_b)])
    # Freeze on the in-app refund result ("Refunded $1,000.00 · limit back to ...") before the
    # fade, so it is clearly visible: the live refund returned only just before the scene ended.
    holds.append((voice_end("v15c", 0.3) + 0.5, 2.5))


def mapped(t):
    """Main-take position after removing waits (and the replaced section), plus the insert length."""
    t = min(max(t, t0), tend)
    removed = sum(max(0.0, min(t, b) - a) for a, b in cuts if a < t)
    shift = splice["len"] if splice and t >= splice["b"] else 0.0
    shift += sum(d for h, d in holds if t >= h)
    return t - t0 - removed + shift


def in_cut(t):
    return any(a <= t < b for a, b in cuts)


frame_times = [f["t"] for f in frames]


def state_at(t):
    i = bisect.bisect_right(frame_times, t) - 1
    return frames[max(i, 0)]["file"]


total = mapped(tend)

# ---------------------------------------------------------------- video ----
timeline = [(0.0, state_at(t0))]
for f in frames:
    if t0 < f["t"] <= tend and not in_cut(f["t"]):
        timeline.append((mapped(f["t"]), f["file"]))
for a, b in cuts:
    timeline.append((mapped(b) + 1e-4, state_at(b)))
for h, d in holds:
    timeline.append((mapped(h) - d + 1e-4, state_at(h)))

# events in output time: (mapped time, event, mapped caption end)
timed = [(mapped(e["t"]), e, mapped(e["end"]) if "end" in e else None) for e in events if not in_cut(e["t"]) and t0 <= e["t"] <= tend]

if splice:
    i_frames, i_events, i_t0, i_tend, _ = splice["ins"]
    S = mapped(splice["a"])
    # the main take's own scene-change whoosh can land just before the window; the insert has its own
    timed = [x for x in timed if not (x[1]["type"] == "sfx" and splice["a"] - 0.4 <= x[1]["t"] < splice["a"])]
    ift = [f["t"] for f in i_frames]
    def i_state(t):
        k = bisect.bisect_right(ift, t) - 1
        return i_frames[max(k, 0)]["file"]
    timeline.append((S + 2e-4, i_state(i_t0)))
    for f in i_frames:
        if i_t0 < f["t"] <= i_tend:
            timeline.append((S + f["t"] - i_t0, f["file"]))
    for e in i_events:
        if i_t0 <= e["t"] <= i_tend and e["type"] in ("voice", "sfx", "caption"):
            timed.append((S + e["t"] - i_t0, e, (S + e["end"] - i_t0) if "end" in e else None))
    print(f"spliced insert: {splice['len']:.1f}s at {S:.1f}s (replaced {splice['b'] - splice['a']:.1f}s)")

timed.sort(key=lambda x: x[0])
timeline.sort(key=lambda x: x[0])
print(f"raw {tend - t0:.1f}s, final {total:.1f}s")
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


for tm, e, _ in timed:
    if e["type"] == "voice":
        place(voice, load48(os.path.join(BUILD, "voice", f"{e['id']}.wav")), tm, 1.0)

SFX_GAIN = {"click": 0.35, "whoosh": 0.45, "chime": 0.45, "alert": 0.5, "success": 0.45}
cache = {}
for tm, e, _ in timed:
    if e["type"] == "sfx":
        name = e["name"]
        cache.setdefault(name, load48(os.path.join(BUILD, "audio", f"sfx_{name}.wav")))
        place(fx, cache[name], tm, SFX_GAIN.get(name, 0.5))

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
caps = [(tm, e, end) for tm, e, end in timed if e["type"] == "caption"]


def ts(x):
    ms = int(round(x * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


with open(os.path.join(OUT, "intentguard-demo.srt"), "w") as fh:
    for i, (start, c, end) in enumerate(caps):
        if i + 1 < len(caps):
            end = min(end, caps[i + 1][0] - 0.02)
        fh.write(f"{i + 1}\n{ts(start)} --> {ts(max(end, start + 0.5))}\n{c['text']}\n\n")

print("wrote", final)
