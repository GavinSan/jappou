"""Pitched-instrument transcription with Spotify's Basic Pitch."""
from __future__ import annotations

from pathlib import Path

# per-stem settings: (onset_threshold, frame_threshold, min_note_ms, min_hz, max_hz, monophonic)
SETTINGS = {
    "bass":   (0.5, 0.3, 90, 30, 400, "low"),
    "guitar": (0.55, 0.3, 80, 75, 1400, None),
    "piano":  (0.5, 0.3, 70, 27, 4200, None),
    "vocals": (0.55, 0.35, 110, 80, 1100, "high"),
    "other":  (0.6, 0.35, 110, 60, 3000, None),
}

_model = None


def _get_model():
    """Use Basic Pitch's ONNX model: it runs on onnxruntime and avoids TensorFlow,
    whose saved-model loading is broken on many Windows / Python 3.11 setups."""
    global _model
    if _model is None:
        import basic_pitch
        from basic_pitch.inference import Model
        onnx = Path(basic_pitch.__file__).parent / "saved_models" / "icassp_2022" / "nmp.onnx"
        try:
            import onnxruntime  # noqa: F401
            have_ort = True
        except ImportError:
            have_ort = False
        if onnx.exists() and have_ort:
            _model = Model(onnx)
        else:
            if not have_ort:
                print("[pitched] onnxruntime missing - run install again (pip install onnxruntime)")
            from basic_pitch import ICASSP_2022_MODEL_PATH
            _model = Model(ICASSP_2022_MODEL_PATH)
    return _model


def transcribe(stem_wav: Path, stem: str):
    """Returns [{start, end, pitch, vel}] sorted by start."""
    from basic_pitch.inference import predict

    onset_t, frame_t, min_ms, fmin, fmax, mono = SETTINGS[stem]
    _, _, note_events = predict(
        str(stem_wav), _get_model(),
        onset_threshold=onset_t, frame_threshold=frame_t,
        minimum_note_length=min_ms, minimum_frequency=fmin, maximum_frequency=fmax,
        multiple_pitch_bends=False, melodia_trick=True,
    )
    notes = [{"start": float(s), "end": float(e), "pitch": int(p), "vel": int(min(127, max(30, a * 127)))}
             for (s, e, p, a, *_rest) in note_events]
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    if mono:
        notes = _monophonic(notes, keep=mono)
    return notes


def _monophonic(notes, keep="high"):
    """Keep one note at a time (bass: lowest, vocal melody: loudest/highest)."""
    out = []
    groups = []
    for n in notes:
        if groups and n["start"] - groups[-1][0]["start"] < 0.05:
            groups[-1].append(n)
        else:
            groups.append([n])
    for g in groups:
        if keep == "low":
            pick = min(g, key=lambda n: n["pitch"])
        else:
            pick = max(g, key=lambda n: (n["vel"], n["pitch"]))
        out.append(dict(pick))
    # cut overlaps
    for a, b in zip(out, out[1:]):
        if a["end"] > b["start"]:
            a["end"] = max(a["start"] + 0.05, b["start"])
    return out


def split_hands(notes, split=60):
    rh = [n for n in notes if n["pitch"] >= split]
    lh = [n for n in notes if n["pitch"] < split]
    return rh, lh
