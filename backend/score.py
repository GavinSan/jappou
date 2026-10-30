"""Build a Guitar Pro 5 file (rendered in the browser by alphaTab) from note events.

Input events are in seconds; they are snapped to the beat grid from timing.py.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from fractions import Fraction

import guitarpro as gp

from timing import Grid, choose_subdivisions, quantize, pos_value

# ---------------------------------------------------------------- track specs

KICK = {35, 36}
FEET = {35, 36, 44}  # kick + hi-hat pedal go in the lower (feet) voice


@dataclass
class TrackSpec:
    key: str
    name: str
    program: int
    strings: list[int]           # MIDI values, highest string first
    lo: int                      # lowest pitch kept (lower notes are moved up an octave)
    hi: int
    max_poly: int
    keep: str = "high"           # which notes to keep when over max_poly
    fretted: bool = False        # real instrument fingering (guitar/bass) vs. notation-only
    percussion: bool = False


SPECS = {
    "drums": TrackSpec("drums", "Drums 鼓", 0, [0] * 6, 0, 127, 6, percussion=True),
    "bass": TrackSpec("bass", "Bass", 33, [43, 38, 33, 28], 28, 67, 1, keep="low", fretted=True),
    "guitar": TrackSpec("guitar", "Guitar 結他", 27, [64, 59, 55, 50, 45, 40], 40, 88, 6, fretted=True),
    "piano_rh": TrackSpec("piano_rh", "Piano 琴 (右手)", 0, [108, 96, 84, 72, 60, 48], 60, 108, 5),
    "piano_lh": TrackSpec("piano_lh", "Piano 琴 (左手)", 0, [72, 60, 48, 36, 24, 21], 21, 59, 4, keep="low"),
    "vocals": TrackSpec("vocals", "Vocal 人聲旋律", 53, [96, 84, 72, 60, 48, 36], 40, 84, 1),
    "other": TrackSpec("other", "Other 其他", 48, [108, 96, 84, 72, 60, 48], 48, 100, 3),
}
TRACK_ORDER = ["drums", "vocals", "guitar", "bass", "piano_rh", "piano_lh", "other"]


# ---------------------------------------------------------------- segments

@dataclass
class Seg:
    start: Fraction                     # in beats from bar start
    length: Fraction                    # in beats
    m: int                              # subdivision of the beat it came from (4 or 3)
    slots: int                          # length in slots
    notes: dict = field(default_factory=dict)   # pitch -> (tie: bool, vel)

    @property
    def rest(self):
        return not self.notes


def _duration_for(m: int, slots: int) -> gp.Duration:
    if m == 3:
        if slots == 1:
            return gp.Duration(value=8, tuplet=gp.Tuplet(3, 2))
        if slots == 2:
            return gp.Duration(value=4, tuplet=gp.Tuplet(3, 2))
        return gp.Duration(value=4)
    return {
        1: gp.Duration(value=16),
        2: gp.Duration(value=8),
        3: gp.Duration(value=8, isDotted=True),
        4: gp.Duration(value=4),
    }[slots]


def _merged_duration(beats: Fraction) -> gp.Duration | None:
    return {
        Fraction(1): gp.Duration(value=4),
        Fraction(2): gp.Duration(value=2),
        Fraction(3): gp.Duration(value=2, isDotted=True),
        Fraction(4): gp.Duration(value=1),
    }.get(beats)


def build_segments(grid: Grid, notes: list[dict], percussion: bool, splits: set | None = None):
    splits = splits or set()
    """notes: [{start, end, pitch, vel}] -> {bar: [Seg, ...]} for one voice."""
    onsets: dict[tuple[int, int], dict[int, int]] = {}
    spans = []  # (start_pos, end_pos, pitch)
    for n in notes:
        k, j = quantize(grid, n["start"])
        onsets.setdefault((k, j), {})[n["pitch"]] = n.get("vel", 90)
        if not percussion:
            k2, j2 = quantize(grid, n["end"])
            sp, ep = pos_value(grid, k, j), pos_value(grid, k2, j2)
            if ep <= sp:
                ep = sp + 1 / grid.subdiv[k]
            spans.append((sp, ep, n["pitch"], n.get("vel", 90)))
    spans.sort()

    N = grid.beats_per_bar
    bars: dict[int, list[Seg]] = {}
    span_i = 0
    live: list = []
    for k in range(grid.n_beats):
        m = int(grid.subdiv[k])
        slot_sets = []
        for j in range(m):
            pos = k + j / m
            ons = onsets.get((k, j), {})
            if percussion:
                active = {p: (False, v) for p, v in ons.items()}
            else:
                while span_i < len(spans) and spans[span_i][0] <= pos + 1e-9:
                    live.append(spans[span_i])
                    span_i += 1
                live = [s for s in live if s[1] > pos + 1e-9]
                active = {}
                for s in live:
                    tie = s[2] not in ons and s[0] < pos - 1e-9
                    active[s[2]] = (tie, s[3])
                for p, v in ons.items():
                    active[p] = (False, v)
            slot_sets.append((ons, active))

        # split beat into segments
        bar, beat_in_bar = divmod(k, N)
        segs = bars.setdefault(bar, [])
        j = 0
        while j < m:
            ons, active = slot_sets[j]
            j2 = j + 1
            while j2 < m:
                o2, a2 = slot_sets[j2]
                # drums: a hit lasts until the next hit; pitched: split when the sounding notes change
                if o2 or (k, j2) in splits or (not percussion and set(a2) != set(active)):
                    break
                j2 += 1
            segs.append(Seg(start=Fraction(beat_in_bar) + Fraction(j, m), length=Fraction(j2 - j, m),
                            m=m, slots=j2 - j, notes=dict(active)))
            j = j2
    # merge whole-beat rests / whole-beat tied notes into longer values
    for bar, segs in bars.items():
        bars[bar] = _merge(segs, N, {Fraction(kk - bar * N) + Fraction(jj, int(grid.subdiv[kk])) for kk, jj in splits if kk // N == bar})
    return bars


def _merge(segs: list[Seg], N: int, split_starts: set | None = None) -> list[Seg]:
    split_starts = split_starts or set()
    out: list[Seg] = []
    for s in segs:
        if out:
            prev = out[-1]
            full_beats = prev.length.denominator == 1 and s.length == 1 and s.start.denominator == 1
            same_rest = prev.rest and s.rest
            same_tied = (not prev.rest and not s.rest and set(prev.notes) == set(s.notes)
                         and all(t for t, _ in s.notes.values()))
            if full_beats and (same_rest or same_tied) and s.start not in split_starts:
                total = prev.length + 1
                ok_align = (total == 2 and prev.start % 2 == 0) or (total in (3, 4) and prev.start == 0)
                if ok_align and total <= N and _merged_duration(total) is not None:
                    out[-1] = Seg(start=prev.start, length=total, m=4, slots=int(total) * 4, notes=prev.notes)
                    continue
        out.append(s)
    return out


# ---------------------------------------------------------------- fingering

class Fingerer:
    def __init__(self, spec: TrackSpec):
        self.spec = spec
        self.position = 3
        self.prev: dict[int, int] = {}  # pitch -> string number of the previous segment

    def assign(self, pitches: list[int], ties: dict[int, bool]):
        """Return list of (pitch, string_no, fret) for the given chord."""
        strings = self.spec.strings
        n_str = len(strings)
        if self.spec.fretted:
            best, best_cost = None, None
            options = []
            for p in pitches:
                opts = [(si, p - strings[si]) for si in range(n_str) if 0 <= p - strings[si] <= 22]
                if ties.get(p) and p in self.prev:
                    s = self.prev[p] - 1
                    opts = [o for o in opts if o[0] == s] or opts
                options.append(opts)
            for combo in itertools.product(*options):
                used = [c[0] for c in combo]
                if len(set(used)) != len(used):
                    continue
                frets = [f for _, f in combo]
                fretted = [f for f in frets if f > 0]
                span = (max(fretted) - min(fretted)) if fretted else 0
                if span > 4:
                    continue
                cost = sum(abs(f - self.position) * (0.3 if f == 0 else 1.0) for f in frets) + span
                if best_cost is None or cost < best_cost:
                    best, best_cost = combo, cost
            if best is None:
                # fall back: drop notes until it fits
                if len(pitches) > 1:
                    return self.assign(pitches[:-1], ties)
                p = pitches[0]
                si = max(range(n_str), key=lambda i: strings[i] if strings[i] <= p else -1)
                best = ((si, max(0, p - strings[si])),)
            result = [(p, si + 1, f) for p, (si, f) in zip(pitches, best)]
            fretted = [f for _, _, f in result if f > 0]
            if fretted:
                self.position = round(sum(fretted) / len(fretted))
        else:
            used = set()
            result = []
            for p in sorted(pitches, reverse=True):
                cand = [i for i in range(n_str) if i not in used and strings[i] <= p]
                if not cand:
                    continue
                si = cand[0]
                used.add(si)
                result.append((p, si + 1, p - strings[si]))
        self.prev = {p: s for p, s, _ in result}
        return result


# ---------------------------------------------------------------- song

def _fit_range(spec: TrackSpec, notes: list[dict]) -> list[dict]:
    out = []
    for n in notes:
        p = n["pitch"]
        while p < spec.lo:
            p += 12
        while p > spec.hi:
            p -= 12
        out.append({**n, "pitch": p})
    return out


def _limit_poly(spec: TrackSpec, segs_by_bar):
    for segs in segs_by_bar.values():
        for s in segs:
            if len(s.notes) > spec.max_poly:
                ps = sorted(s.notes, reverse=(spec.keep == "high"))
                if spec.keep == "high" and spec.max_poly >= 2:
                    keep = set(ps[: spec.max_poly - 1]) | {ps[-1]}  # top voices + bass note
                else:
                    keep = set(ps[: spec.max_poly])
                s.notes = {p: v for p, v in s.notes.items() if p in keep}


# bump when the GP5 layout changes so existing songs get their score rebuilt
SCORE_FORMAT = 3


def build_song(grid: Grid, title: str, artist: str, drums: list[dict] | None,
               pitched: dict[str, list[dict]], allow_triplets: bool = True, chord_times: list[float] | None = None) -> tuple[gp.Song, list[dict]]:
    """Return the gp.Song and a description of the tracks it contains."""
    # subdivisions are decided from drum onsets (most rhythmic) or all onsets
    onset_src = [d["time"] for d in (drums or [])]
    if not onset_src:
        onset_src = [n["start"] for ns in pitched.values() for n in ns]
    grid.subdiv = choose_subdivisions(grid, onset_src, allow_triplets)
    # chord changes: notes / rests are split there so chord names sit on the right spot
    chord_splits = {quantize(grid, t) for t in (chord_times or []) if 0 <= t < grid.beats[grid.n_beats]}

    song = gp.Song()
    song.title = (title or "")[:80]
    song.artist = (artist or "")[:60]
    song.tempo = int(round(grid.bpm))
    song.tempoName = ""
    song.measureHeaders = []
    song.tracks = []
    N = grid.beats_per_bar
    for b in range(grid.n_bars):
        h = gp.MeasureHeader(number=b + 1, start=gp.Duration.quarterTime * (1 + b * N),
                             timeSignature=gp.TimeSignature(numerator=N, denominator=gp.Duration(value=4)))
        song.measureHeaders.append(h)

    track_infos = []
    channel_pairs = [(0, 1), (2, 3), (4, 5), (6, 7), (10, 11), (12, 13), (14, 15)]

    voices_by_track: dict[str, list[dict[int, list[Seg]]]] = {}
    if drums:
        dn = [{"start": d["time"], "end": d["time"], "pitch": d["note"], "vel": d.get("vel", 100)} for d in drums]
        hands = [d for d in dn if d["pitch"] not in FEET]
        feet = [d for d in dn if d["pitch"] in FEET]
        voices_by_track["drums"] = [build_segments(grid, hands, True), build_segments(grid, feet, True)]
    for key in TRACK_ORDER:
        if key == "drums" or key not in pitched or not pitched[key]:
            continue
        spec = SPECS[key]
        segs = build_segments(grid, _fit_range(spec, pitched[key]), False, chord_splits)
        _limit_poly(spec, segs)
        voices_by_track[key] = [segs]

    for key in TRACK_ORDER:
        if key not in voices_by_track:
            continue
        spec = SPECS[key]
        idx = len(song.tracks)
        if spec.percussion:
            ch = gp.MidiChannel(channel=9, effectChannel=9, instrument=0)
        else:
            c, e = channel_pairs[min(idx, len(channel_pairs) - 1)]
            ch = gp.MidiChannel(channel=c, effectChannel=e, instrument=spec.program)
        track = gp.Track(song, number=idx + 1, name=spec.name, channel=ch,
                         isPercussionTrack=spec.percussion,
                         strings=[gp.GuitarString(i + 1, v) for i, v in enumerate(spec.strings)])
        track.fretCount = 24 if spec.fretted else 99
        track.measures = [gp.Measure(track, h) for h in song.measureHeaders]
        song.tracks.append(track)
        fingerer = Fingerer(spec)

        n_notes = 0
        for vi, segs_by_bar in enumerate(voices_by_track[key]):
            for b, measure in enumerate(track.measures):
                voice = measure.voices[vi]
                segs = segs_by_bar.get(b, [])
                # NOTE: never leave a voice without beats. alphaTab only creates a voice
                # when it has beats, and a bar with 2 voices followed by a bar with 1
                # crashes its importer. Bars without kicks get an invisible "empty" beat.
                if all(s.rest for s in segs) and (spec.percussion or len(segs) <= 1 or
                                                  not any(kk // N == b for kk, _ in chord_splits)):
                    segs = [Seg(start=Fraction(0), length=Fraction(N), m=4, slots=N * 4)]
                # (a rest-only bar with a chord change keeps its merged rests, split at the change)
                tick = measure.start
                for s in segs:
                    if s.length == N and s.rest:
                        dur = gp.Duration(value=1) if N == 4 else (
                            gp.Duration(value=2, isDotted=True) if N == 3 else gp.Duration(value=2) if N == 2 else None)
                        if dur is None:  # odd meters: one quarter rest per beat
                            for _ in range(N):
                                st = gp.BeatStatus.empty if (spec.percussion and vi == 1) else gp.BeatStatus.rest
                                beat = gp.Beat(voice, duration=gp.Duration(value=4), status=st, start=tick)
                                voice.beats.append(beat)
                                tick += gp.Duration.quarterTime
                            continue
                    elif s.length.denominator == 1 and s.length > 1:
                        dur = _merged_duration(s.length)
                    else:
                        dur = _duration_for(s.m, s.slots)
                    beat = gp.Beat(voice, duration=dur, start=tick)
                    if s.rest:
                        # rests in the drum "feet" voice are hidden (standard drum notation)
                        beat.status = gp.BeatStatus.empty if (spec.percussion and vi == 1) else gp.BeatStatus.rest
                    else:
                        beat.status = gp.BeatStatus.normal
                        if spec.percussion:
                            used = 1
                            for p, (tie, vel) in sorted(s.notes.items())[:6]:
                                beat.notes.append(gp.Note(beat, value=p, string=used, type=gp.NoteType.normal,
                                                          velocity=_gp_vel(vel)))
                                used += 1
                        else:
                            ties = {p: t for p, (t, _) in s.notes.items()}
                            for p, string_no, fret in fingerer.assign(sorted(s.notes, reverse=True), ties):
                                tie, vel = s.notes[p]
                                beat.notes.append(gp.Note(beat, value=fret, string=string_no,
                                                          type=gp.NoteType.tie if tie else gp.NoteType.normal,
                                                          velocity=_gp_vel(vel)))
                        n_notes += len(beat.notes)
                        if not beat.notes:
                            beat.status = gp.BeatStatus.rest
                    voice.beats.append(beat)
                    tick += int(dur.time)
        track_infos.append({"key": key, "index": idx, "name": spec.name, "notes": n_notes})
    return song, track_infos


def _gp_vel(v: int) -> int:
    # Every note gets the same dynamic: per-note dynamics from the transcription
    # are noisy and would print "f / ff / fff" under almost every note.
    return gp.Velocities.default


def write_gp5(song: gp.Song, path: str):
    gp.write(song, path, version=(5, 1, 0), encoding="utf-8")
