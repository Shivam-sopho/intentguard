"""Synthesize the ambient music bed and UI sound cues (no samples, no licensing).

Usage: <python-with-numpy> video/audio_assets.py <seconds>
Writes build/audio/music.wav (48 kHz stereo) and build/audio/sfx_*.wav.
"""
import os
import sys

import numpy as np
import soundfile as sf

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "build", "audio")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def one_pole_lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):  # small signals only (noise layer is downsampled first)
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def pad_voice(freq, n, detune_cents=6.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for c in (-detune_cents, 0.0, detune_cents):
        f = freq * 2 ** (c / 1200)
        ph = rng.uniform(0, 2 * np.pi)
        out += np.sin(2 * np.pi * f * t + ph) + 0.18 * np.sin(2 * np.pi * 2 * f * t + ph)
    return out / 3


def music(seconds):
    # Slow, warm progression: Fmaj9 - Am7(add11) - Dm9 - Bbmaj7(#11); 8 s per chord, 2 s crossfades.
    chords = [
        [53, 60, 64, 67, 69],
        [57, 60, 64, 67, 62],
        [50, 57, 60, 64, 65],
        [46, 57, 62, 65, 64],
    ]
    seg = 8.0
    fade = 2.0
    n_total = int(seconds * SR)
    left = np.zeros(n_total)
    right = np.zeros(n_total)
    t0 = 0.0
    k = 0
    while t0 < seconds:
        notes = chords[k % len(chords)]
        n = int((seg + fade) * SR)
        env = np.ones(n)
        a = int(fade * SR)
        env[:a] = np.sin(np.linspace(0, np.pi / 2, a)) ** 2
        env[-a:] = np.cos(np.linspace(0, np.pi / 2, a)) ** 2
        for j, note in enumerate(notes):
            v = pad_voice(midi(note), n) * env * (0.55 if note < 55 else 0.32)
            pan = 0.5 + 0.35 * np.sin(j * 1.7 + k)
            s = int(t0 * SR)
            e = min(n_total, s + n)
            left[s:e] += v[: e - s] * (1 - pan)
            right[s:e] += v[: e - s] * pan
        t0 += seg
        k += 1
    # Airy texture: very quiet low-passed noise, slowly breathing.
    small = rng.standard_normal(int(seconds * 3000))
    small = one_pole_lowpass(small, 300 * 3000 / SR * 16)
    air = np.interp(np.arange(n_total) / SR * 3000, np.arange(len(small)), small)
    breath = 0.5 + 0.5 * np.sin(2 * np.pi * np.arange(n_total) / SR / 11.0)
    left += air * breath * 0.05
    right += np.roll(air, 2400) * breath * 0.05
    # Slow tremolo for movement, overall fades.
    trem = 1 + 0.06 * np.sin(2 * np.pi * np.arange(n_total) / SR / 5.3)
    st = np.stack([left * trem, right * trem], axis=1)
    fi, fo = int(3 * SR), int(5 * SR)
    st[:fi] *= np.linspace(0, 1, fi)[:, None]
    st[-fo:] *= np.linspace(1, 0, fo)[:, None]
    st /= np.max(np.abs(st)) + 1e-9
    return st * 0.5


def env_exp(n, decay):
    return np.exp(-np.arange(n) / SR / decay)


def tone(freqs, dur, decay, gain=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = sum(np.sin(2 * np.pi * f * t) * (0.6 ** i) for i, f in enumerate(freqs))
    att = int(0.004 * SR)
    e = env_exp(n, decay)
    e[:att] *= np.linspace(0, 1, att)
    return (x * e * gain).astype(np.float32)


def stereo(x):
    return np.stack([x, x], axis=1)


def sfx():
    out = {}
    # soft UI click
    n = int(0.05 * SR)
    click = rng.standard_normal(n) * env_exp(n, 0.006)
    out["click"] = stereo(one_pole_lowpass(click, 2500) * 0.25)
    # whoosh for slide transitions: noise with rising then falling filter
    n = int(0.9 * SR)
    noise = rng.standard_normal(n)
    shaped = np.zeros(n)
    acc = 0.0
    for i in range(n):
        p = i / n
        cutoff = 200 + 2200 * np.sin(np.pi * p) ** 2
        a = np.exp(-2 * np.pi * cutoff / SR)
        acc = (1 - a) * noise[i] + a * acc
        shaped[i] = acc
    shaped *= np.sin(np.linspace(0, np.pi, n)) ** 2
    out["whoosh"] = stereo(shaped / (np.max(np.abs(shaped)) + 1e-9) * 0.22)
    # card issued: bright two-note chime
    a = tone([midi(84), midi(96)], 1.2, 0.35, 0.28)
    b = tone([midi(91), midi(103)], 1.2, 0.4, 0.24)
    ch = np.zeros(int(1.4 * SR), dtype=np.float32)
    ch[: len(a)] += a
    off = int(0.12 * SR)
    ch[off : off + len(b)] += b[: len(ch) - off]
    out["chime"] = stereo(ch)
    # blocked: low, soft double pulse
    p1 = tone([midi(45), midi(57)], 0.7, 0.18, 0.5)
    al = np.zeros(int(1.0 * SR), dtype=np.float32)
    al[: len(p1)] += p1
    off = int(0.22 * SR)
    al[off : off + len(p1)] += p1[: len(al) - off] * 0.8
    out["alert"] = stereo(al)
    # success: rising arpeggio
    notes = [72, 76, 79, 84]
    su = np.zeros(int(1.8 * SR), dtype=np.float32)
    for i, nn in enumerate(notes):
        tt = tone([midi(nn), midi(nn + 12)], 1.2, 0.45, 0.22)
        o = int(i * 0.09 * SR)
        su[o : o + len(tt)] += tt[: len(su) - o]
    out["success"] = stereo(su)
    return out


if __name__ == "__main__":
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 200
    sf.write(os.path.join(OUT, "music.wav"), music(seconds).astype(np.float32), SR)
    for k, v in sfx().items():
        sf.write(os.path.join(OUT, f"sfx_{k}.wav"), v.astype(np.float32), SR)
    print("wrote", sorted(os.listdir(OUT)))
