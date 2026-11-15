"""Cut the Airwallex dashboard screen recording into a muted, zoomed clip timed to narration.

Usage: python video/dashboard.py [path/to/recording.mov]
Output: build/dash/dashboard-clip.mp4 (2080x1076, 30 fps, no audio)

Each segment = (source start, source end, crop rect in source pixels, narration it sits under).
Segments play at normal speed (or slightly faster if needed) and then hold their last frame,
so the picture never runs ahead of or behind the voice. The browser toolbar is cropped away.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Desktop/AirwallexRecording.mov")
OUT_DIR = os.path.join(HERE, "build", "dash")
os.makedirs(OUT_DIR, exist_ok=True)
W, H, FPS, XF = 2080, 1076, 30, 0.3
TAIL = {"vD1": 0.3, "vD2": 0.3, "vD3": 0.3, "vD4": 0.3, "vD5": 0.3, "vD6": 0.8}  # must match record.mjs

dur = json.load(open(os.path.join(HERE, "build", "voice", "durations.json")))
line = {k: dur[k]["duration"] + TAIL[k] for k in TAIL}

FULL = (0, 82, 3012, 1558)          # whole page below the browser toolbar
CARD = (870, 84, 2142, 1107)        # card details panel: name, status, limits
LIST = (750, 180, 2262, 1170)       # the card's transaction list
TXN = (1200, 99, 1812, 936)         # transaction detail panel (amount, status, reason)

segments = [
    # (src_start, src_end, crop, target seconds)
    (0.3, 3.6, FULL, 3.0),
    (5.8, 8.4, CARD, line["vD1"] - 3.0),
    (11.3, 14.0, LIST, line["vD2"]),
    (19.4, 20.4, TXN, line["vD3"]),
    (25.2, 26.4, TXN, line["vD4"]),
    (29.1, 29.8, TXN, line["vD5"]),
    (35.1, 36.2, TXN, line["vD6"]),       # the refund: +1,000.00 USD, Refunded
]

parts = []
for i, (a, b, (x, y, w, h), target) in enumerate(segments):
    length = target + (XF if i < len(segments) - 1 else 0)  # crossfade overlap is compensated
    natural = b - a
    speed = max(1.0, natural / length)                    # never slow motion; speed up if needed
    played = natural / speed
    hold = max(0.0, length - played)
    out = os.path.join(OUT_DIR, f"seg{i}.mp4")
    vf = (
        f"crop={w}:{h}:{x}:{y},scale={W}:{H}:flags=lanczos,setpts=(PTS-STARTPTS)/{speed},"
        f"fps={FPS},tpad=stop_mode=clone:stop_duration={hold:.3f},trim=duration={length:.3f},format=yuv420p"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(a), "-t", str(natural), "-i", SRC,
         "-an", "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "14", out],
        check=True,
    )
    parts.append((out, length))
    print(f"seg{i}: src {a:.1f}-{b:.1f}s x{speed:.2f}, hold {hold:.2f}s -> {length:.2f}s")

# chain crossfades
inputs = []
for p, _ in parts:
    inputs += ["-i", p]
chain = ""
prev = "[0:v]"
offset = 0.0
for i in range(1, len(parts)):
    offset += parts[i - 1][1] - XF
    label = f"[x{i}]"
    chain += f"{prev}[{i}:v]xfade=transition=fade:duration={XF}:offset={offset:.3f}{label};"
    prev = label
final = os.path.join(OUT_DIR, "dashboard-clip.mp4")
subprocess.run(
    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", chain.rstrip(";"),
     "-map", prev, "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p",
     "-movflags", "+faststart", final],
    check=True,
)
total = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final]))
print(f"wrote {final} ({total:.2f}s; narration {sum(line.values()):.2f}s)")
