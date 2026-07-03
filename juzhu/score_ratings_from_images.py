#!/usr/bin/env python3
"""根据项目/户型图片质量为好房子评级打分，写回 data.json（并可同步 SQLite）。"""
from __future__ import annotations

import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = Path(__file__).resolve().parent / "data.json"
STAR_LABELS = ["", "基础型", "达标型", "优质型", "精品型", "示范型"]


def laplacian_variance(gray) -> float:
    w, h = gray.size
    if w < 3 or h < 3:
        return 0.0
    px = gray.load()
    vals = []
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            lap = (
                -4 * px[x, y]
                + px[x - 1, y]
                + px[x + 1, y]
                + px[x, y - 1]
                + px[x, y + 1]
            )
            vals.append(float(lap))
    if not vals:
        return 0.0
    mean = sum(vals) / len(vals)
    return sum((v - mean) ** 2 for v in vals) / len(vals)


def analyze_image(path: Path) -> dict | None:
    from PIL import Image

    if not path.is_file():
        return None
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            w, h = im.size
            gray = im.convert("L")
            small = gray.resize((160, 120))
            px = small.getdata()
            mean = sum(px) / len(px)
            rgb_small = im.resize((160, 120)).convert("RGB")
            rg = rgb_small.getdata()
            total = sum(sum(p) for p in rg) + 1
            green_ratio = sum(p[1] for p in rg) / total
            sharp = laplacian_variance(small)
            return {
                "w": w,
                "h": h,
                "mp": (w * h) / 1_000_000,
                "kb": path.stat().st_size / 1024,
                "brightness": mean,
                "sharp": sharp,
                "green_ratio": green_ratio,
            }
    except OSError:
        return None


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def norm01(v: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 0.5
    return clamp((v - lo) / (hi - lo), 0.0, 1.0)


def score_to_dim(base: float, offset: float) -> float:
    return round(clamp(base + offset, 2.0, 5.0), 1)


def build_rating(project: dict, units: list, photos: list, root: Path) -> dict:
    paths: list[Path] = []
    if project.get("cover_image"):
        paths.append(root / project["cover_image"])
    pid = project["id"]
    for u in units:
        if u.get("project_id") == pid and u.get("cover_image"):
            paths.append(root / u["cover_image"])
    for ph in photos:
        if ph.get("entity_type") == "unit":
            uid = ph.get("entity_id")
            if any(u.get("id") == uid and u.get("project_id") == pid for u in units):
                paths.append(root / ph["file_path"])
        elif ph.get("entity_type") == "project" and ph.get("entity_id") == pid:
            paths.append(root / ph["file_path"])

    seen = set()
    unique: list[Path] = []
    for p in paths:
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)

    stats = [analyze_image(p) for p in unique]
    stats = [s for s in stats if s]

    unit_total = max(1, sum(1 for u in units if u.get("project_id") == pid))
    units_with_img = sum(
        1
        for u in units
        if u.get("project_id") == pid and u.get("cover_image")
    )
    coverage = units_with_img / unit_total

    if not stats:
        return {
            "quality": 0.08,
            "dims_hint": {"comfort": 2.8, "green": 2.6, "tech": 2.5, "safety": 3.0},
            "checked": 38,
            "confidence": 0.55,
            "photo_count": 0,
        }

    mp = statistics.mean(s["mp"] for s in stats)
    kb = statistics.mean(s["kb"] for s in stats)
    sharp = statistics.mean(s["sharp"] for s in stats)
    bright = statistics.mean(s["brightness"] for s in stats)
    green = statistics.mean(s["green_ratio"] for s in stats)

    res_s = norm01(mp, 0.12, 2.0)
    size_s = norm01(kb, 35, 500)
    sharp_s = norm01(sharp, 60, 1200)
    bright_s = 1.0 - abs(bright - 128) / 128
    green_s = norm01(green, 0.30, 0.39)
    cover_s = norm01(coverage, 0.15, 1.0)
    count_s = norm01(len(stats), 1, 8)

    quality = (
        res_s * 0.18
        + size_s * 0.10
        + sharp_s * 0.30
        + bright_s * 0.16
        + green_s * 0.08
        + cover_s * 0.10
        + count_s * 0.08
    )

    return {
        "quality": quality,
        "dims_hint": {
            "comfort": score_to_dim(2.0 + quality * 2.8, bright_s * 0.3 - 0.1),
            "green": score_to_dim(2.0 + quality * 2.8, green_s * 0.35 - 0.08),
            "tech": score_to_dim(2.0 + quality * 2.8, res_s * 0.25 + size_s * 0.1 - 0.15),
            "safety": score_to_dim(2.0 + quality * 2.8, cover_s * 0.15),
        },
        "checked": int(36 + quality * 16),
        "confidence": round(0.52 + quality * 0.38, 2),
        "photo_count": len(stats),
    }


def quality_to_stars(quality: float, rank: float) -> int:
    """rank: 0~1 在本批保租房中的相对位置（低→高）"""
    if rank < 0.15:
        return 2
    if rank < 0.50:
        return 3
    if rank < 0.85:
        return 4
    return 5


def finalize_rating(project: dict, meta: dict, stars: int) -> dict:
    hint = meta.get("dims_hint") or {}
    center = {2: 2.7, 3: 3.4, 4: 4.0, 5: 4.6}[stars]
    lo, hi = {2: (2.4, 3.1), 3: (3.1, 3.9), 4: (3.8, 4.4), 5: (4.3, 5.0)}[stars]
    dims = {}
    for k, v in hint.items():
        blended = v * 0.35 + center * 0.65
        dims[k] = round(clamp(blended, lo, hi), 1)
    return _pack(
        project,
        dims,
        stars,
        checked=meta.get("checked", 42),
        confidence=meta.get("confidence", 0.7),
    )


def _pack(project: dict, dims: dict, stars: int, checked: int, confidence: float) -> dict:
    avg = sum(dims.values()) / 4
    return {
        "dims": dims,
        "stars": stars,
        "score": int(round(avg / 5 * 100)),
        "checked": checked,
        "total": 55,
        "code": f"SY-BZF-{project['id']:05d}",
        "star_label": STAR_LABELS[stars],
        "confidence": confidence,
    }


def apply(data: dict, root: Path, channel: str = "bzf", dry_run: bool = False) -> dict:
    units = data.get("units") or []
    photos = data.get("photos") or []
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    summary = []

    bzf = [p for p in data.get("projects") or [] if p.get("channel") == channel]
    metas = []
    for p in bzf:
        meta = build_rating(p, units, photos, root)
        meta["project"] = p
        metas.append(meta)

    metas.sort(key=lambda m: m["quality"])
    n = len(metas)

    for i, meta in enumerate(metas):
        p = meta["project"]
        rank = (i + 0.5) / n if n else 0.5
        stars = quality_to_stars(meta["quality"], rank)
        rating = finalize_rating(p, meta, stars)
        summary.append((p["id"], p["name"], rating["stars"], rating["score"], meta["photo_count"]))
        if dry_run:
            continue
        p["rating"] = rating
        p["rating_status"] = "passed"
        p["rating_submitted_at"] = p.get("rating_submitted_at") or now
        p["rating_reviewed_at"] = now
        p["rating_note"] = "图片质量自动评分"

    return {"rows": summary, "data": data}


def sync_sqlite(data: dict) -> None:
    try:
        from db import connect, rating_to_db
    except ImportError:
        return
    conn = connect()
    for p in data.get("projects") or []:
        if p.get("channel") != "bzf" or not p.get("rating"):
            continue
        conn.execute(
            """UPDATE projects SET rating=?, rating_status='passed',
               rating_reviewed_at=COALESCE(rating_reviewed_at, datetime('now')),
               rating_note=COALESCE(rating_note, '图片质量自动评分')
               WHERE id=?""",
            (rating_to_db(p["rating"]), p["id"]),
        )
    conn.commit()
    conn.close()


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    root = ROOT
    if not JSON_PATH.is_file():
        print("missing", JSON_PATH, file=sys.stderr)
        return 1

    with JSON_PATH.open(encoding="utf-8") as f:
        data = json.load(f)

    result = apply(data, root, dry_run=dry_run)
    rows = result["rows"]
    from collections import Counter

    dist = Counter(r[2] for r in rows)
    print("项目数:", len(rows), "星级分布:", dict(sorted(dist.items())))
    for rid, name, stars, score, photos in sorted(rows, key=lambda x: (-x[2], x[0])):
        print(f"  {rid:3} ★{stars} ({score:3}) {photos:2}图 {name}")

    if dry_run:
        print("(dry-run, 未写入)")
        return 0

    with JSON_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    sync_sqlite(data)
    print("已写入", JSON_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
