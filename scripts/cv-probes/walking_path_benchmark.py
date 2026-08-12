#!/usr/bin/env python3
"""Walking-path pixel-classification benchmark (single-fixture exploratory).

Benchmarks cheap per-pixel feature representations x cheap classifiers for
separating UDisc walking-path pixels from surrounding terrain in
resources/ThrownRounds/IMG_5612.png, against the hand-verified annotation in
resources/walking-path/. This is a Stage-1 "is the signal learnable" probe:
training and evaluation both happen on this one image, split into disjoint
spatial regions (train A/B/D, test C/E/F) so that scores measure held-out
*spatial* performance on a single fixture -- NOT cross-capture
generalization.

Stage 2 (only because Stage 1 masks are good) runs a small reconstruction
pass on the best classifiers: threshold -> morphology -> component filter ->
skeletonize, scored for completeness/correctness against the ground truth.

Usage:
  python3 scripts/cv-probes/walking_path_benchmark.py --out /tmp/chainspot-walking-path

Outputs in --out: results.md / results.json (metrics tables),
contact-sheet-crop.png + contact-sheet-full.png (diagnostic overlays,
TP=green FP=red FN=blue), stage2-reconstruction.png, per-model masks.
Dependencies: numpy, scipy, scikit-image, scikit-learn, Pillow.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.color import rgb2hsv, rgb2lab
from skimage.morphology import skeletonize
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.svm import LinearSVC
from sklearn.tree import DecisionTreeClassifier

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "resources/ThrownRounds/IMG_5612.png"
LABELS_PNG = REPO / "resources/walking-path/IMG_5612-walking-path-labels.png"
REGIONS_JSON = REPO / "resources/walking-path/IMG_5612-walking-path-regions.json"

RNG = np.random.default_rng(0)
N_POS, N_NEG = 25_000, 50_000  # per split, subsampled with fixed seed


# ---------------------------------------------------------------- features

FEATURE_NAMES = ["R", "G", "B", "cosH", "sinH", "S", "V", "L", "a", "b",
                 "dL", "da", "db", "stdL", "gradL"]

FEATURE_SETS = {
    "rgb": ["R", "G", "B"],
    "hsv": ["cosH", "sinH", "S", "V"],
    "lab": ["L", "a", "b"],
    "lab+d": ["L", "a", "b", "dL", "da", "db", "S"],
    "full": FEATURE_NAMES,
}


def compute_features(rgb: np.ndarray) -> np.ndarray:
    """(H, W, 15) float32 stack of cheap per-pixel features."""
    im = rgb.astype(np.float32) / 255.0
    hsv = rgb2hsv(im)
    lab = rgb2lab(im)
    # Local background estimate: 31x31 box mean, wider than the ~24px stroke,
    # so pixel-minus-local-mean deltas capture the translucent overlay's
    # shift relative to the underlying terrain.
    local = np.stack([ndi.uniform_filter(lab[:, :, i], 31) for i in range(3)], -1)
    dlab = lab - local
    mean7 = ndi.uniform_filter(lab[:, :, 0], 7)
    sq7 = ndi.uniform_filter(lab[:, :, 0] ** 2, 7)
    std_l = np.sqrt(np.clip(sq7 - mean7 ** 2, 0, None))
    grad_l = np.hypot(ndi.sobel(lab[:, :, 0], 0), ndi.sobel(lab[:, :, 0], 1))
    ang = hsv[:, :, 0] * (2 * np.pi)
    feats = np.stack([
        im[:, :, 0], im[:, :, 1], im[:, :, 2],
        np.cos(ang), np.sin(ang), hsv[:, :, 1], hsv[:, :, 2],
        lab[:, :, 0], lab[:, :, 1], lab[:, :, 2],
        dlab[:, :, 0], dlab[:, :, 1], dlab[:, :, 2],
        std_l, grad_l,
    ], axis=-1).astype(np.float32)
    return feats


def cols(names: list[str]) -> list[int]:
    return [FEATURE_NAMES.index(n) for n in names]


# ------------------------------------------------------------------ models


class TunedScalarRule:
    """Threshold a single derived scalar; threshold tuned on train (max F1)."""

    def __init__(self, name, scalar_fn):
        self.name, self.scalar_fn, self.t = name, scalar_fn, None

    def fit(self, feats, X_idx, y):
        s = self.scalar_fn(feats)[X_idx]
        best = (-1.0, 0.0)
        for t in np.quantile(s, np.linspace(0.5, 0.999, 120)):
            f1 = f1_score_bool(y, s > t)
            if f1 > best[0]:
                best = (f1, float(t))
        self.t = best[1]

    def predict_image(self, feats):
        return self.scalar_fn(feats) > self.t


class HsvBoxRule:
    """Hue window + saturation/value floors, grid-tuned on train."""

    def __init__(self):
        self.params = None

    def fit(self, feats, X_idx, y):
        cos_h, sin_h = feats[..., 3][X_idx], feats[..., 4][X_idx]
        h = (np.arctan2(sin_h, cos_h) / (2 * np.pi)) % 1.0
        s, v = feats[..., 5][X_idx], feats[..., 6][X_idx]
        best = (-1.0, None)
        for h0 in np.arange(0.70, 0.84, 0.02):
            for w in (0.04, 0.06, 0.08, 0.10):
                dh = np.abs((h - h0 + 0.5) % 1.0 - 0.5) < w
                for smin in (0.10, 0.15, 0.20, 0.25, 0.30):
                    for vmin in (0.2, 0.3, 0.4):
                        f1 = f1_score_bool(y, dh & (s > smin) & (v > vmin))
                        if f1 > best[0]:
                            best = (f1, (float(h0), float(w), smin, vmin))
        self.params = best[1]

    def predict_image(self, feats):
        h0, w, smin, vmin = self.params
        h = (np.arctan2(feats[..., 4], feats[..., 3]) / (2 * np.pi)) % 1.0
        dh = np.abs((h - h0 + 0.5) % 1.0 - 0.5) < w
        return dh & (feats[..., 5] > smin) & (feats[..., 6] > vmin)


class Mahalanobis:
    """Distance to the positive-class Gaussian; threshold tuned on train."""

    def __init__(self, feature_set):
        self.feature_set, self.t = feature_set, None

    def fit(self, feats, X_idx, y):
        X = feats[..., cols(FEATURE_SETS[self.feature_set])][X_idx]
        pos = X[y]
        self.mu = pos.mean(0)
        self.icov = np.linalg.inv(np.cov(pos.T) + 1e-6 * np.eye(X.shape[1]))
        d = self._dist(X)
        best = (-1.0, 0.0)
        for t in np.quantile(d, np.linspace(0.001, 0.6, 120)):
            f1 = f1_score_bool(y, d < t)
            if f1 > best[0]:
                best = (f1, float(t))
        self.t = best[1]

    def _dist(self, X):
        z = X - self.mu
        return np.sqrt(np.einsum("...i,ij,...j->...", z, self.icov, z))

    def predict_image(self, feats):
        X = feats[..., cols(FEATURE_SETS[self.feature_set])]
        return self._dist(X) < self.t


class SklearnModel:
    def __init__(self, est, feature_set, max_train=None):
        self.est, self.feature_set, self.max_train = est, feature_set, max_train

    def fit(self, feats, X_idx, y):
        X = feats[..., cols(FEATURE_SETS[self.feature_set])][X_idx]
        if self.max_train and len(y) > self.max_train:
            keep = RNG.choice(len(y), self.max_train, replace=False)
            X, y = X[keep], y[keep]
        self.est.fit(X, y)

    def predict_image(self, feats, chunk=400_000):
        X = feats[..., cols(FEATURE_SETS[self.feature_set])].reshape(-1, len(
            FEATURE_SETS[self.feature_set]))
        out = np.empty(len(X), bool)
        for i in range(0, len(X), chunk):
            out[i:i + chunk] = self.est.predict(X[i:i + chunk]).astype(bool)
        return out.reshape(feats.shape[:2])


# ------------------------------------------------------------------- eval


def f1_score_bool(y, p):
    tp = int(np.sum(p & y))
    fp = int(np.sum(p & ~y))
    fn = int(np.sum(~p & y))
    return 2 * tp / max(1, 2 * tp + fp + fn)


def prf(y, p):
    tp = int(np.sum(p & y)); fp = int(np.sum(p & ~y))
    fn = int(np.sum(~p & y)); tn = int(np.sum(~p & ~y))
    prec = tp / max(1, tp + fp)
    rec = tp / max(1, tp + fn)
    f1 = 2 * prec * rec / max(1e-9, prec + rec)
    return dict(precision=round(prec, 4), recall=round(rec, 4),
                f1=round(f1, 4), tp=tp, fp=fp, fn=fn, tn=tn)


def sample_split(labels, regions, names):
    """Fixed-seed subsample of (pos, neg) pixel indices from region boxes."""
    sel = np.zeros(labels.shape, bool)
    for n in names:
        x0, y0, x1, y1 = regions[n]
        sel[y0:y1, x0:x1] = True
    pos = np.flatnonzero(sel.ravel() & (labels.ravel() == 1))
    neg = np.flatnonzero(sel.ravel() & (labels.ravel() == 0))
    pos = RNG.choice(pos, min(N_POS, len(pos)), replace=False)
    neg = RNG.choice(neg, min(N_NEG, len(neg)), replace=False)
    idx = np.concatenate([pos, neg])
    y = np.zeros(len(idx), bool)
    y[:len(pos)] = True
    return np.unravel_index(idx, labels.shape), y


# -------------------------------------------------------------- rendering


def diagnostic_panel(rgb, pred, labels, box=None, scale=0.5):
    """Grayscale base; TP green, FP red, FN blue; ignore untouched."""
    if box:
        x0, y0, x1, y1 = box
        rgb, pred, labels = (a[y0:y1, x0:x1] for a in (rgb, pred, labels))
    g = (rgb.astype(np.float32).mean(-1) * 0.55)[..., None].repeat(3, -1)
    gt, ig = labels == 1, labels == 2
    g[pred & gt & ~ig] = (60, 220, 60)
    g[pred & ~gt & ~ig] = (255, 50, 50)
    g[~pred & gt & ~ig] = (70, 110, 255)
    img = Image.fromarray(g.astype(np.uint8))
    return img.resize((int(img.width * scale), int(img.height * scale)),
                      Image.NEAREST)


def contact_sheet(panels, path, ncols=3, pad=6, title_h=16):
    w, h = panels[0][1].size
    nrows = -(-len(panels) // ncols)
    sheet = Image.new("RGB", (ncols * (w + pad) + pad,
                              nrows * (h + title_h + pad) + pad), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    for i, (name, img) in enumerate(panels):
        r, c = divmod(i, ncols)
        x = pad + c * (w + pad)
        y = pad + r * (h + title_h + pad)
        d.text((x + 2, y + 2), name, fill=(240, 240, 240))
        sheet.paste(img, (x, y + title_h))
    sheet.save(path)


# ----------------------------------------------------------------- stage 2


def reconstruct(pred):
    """threshold mask -> morphology -> drop small blobs -> skeleton."""
    yy, xx = np.mgrid[-3:4, -3:4]
    disk3 = (xx * xx + yy * yy) <= 9
    m = ndi.binary_closing(pred, structure=disk3)
    m = ndi.binary_opening(m, np.ones((3, 3)))
    lab, _ = ndi.label(m)
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    m = sizes[lab] >= 400
    return m, skeletonize(m)


def skeleton_scores(skel, gt_mask, tol=5):
    """Completeness: GT within tol of skeleton. Correctness: skel within tol of GT."""
    gt_skel = skeletonize(gt_mask)
    if not skel.any():
        return dict(completeness=0.0, correctness=0.0, components=0)
    d_to_skel = ndi.distance_transform_edt(~skel)
    d_to_gt = ndi.distance_transform_edt(~gt_mask)
    completeness = float((d_to_skel[gt_skel] <= tol).mean())
    correctness = float((d_to_gt[skel] <= tol).mean())
    _, n = ndi.label(skel, structure=np.ones((3, 3)))
    return dict(completeness=round(completeness, 4),
                correctness=round(correctness, 4), components=int(n))


# ------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/chainspot-walking-path")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rgb = np.asarray(Image.open(SOURCE).convert("RGB"))
    labels = np.asarray(Image.open(LABELS_PNG))
    meta = json.loads(REGIONS_JSON.read_text())
    regions, split = meta["regions"], meta["split"]

    print("computing features...")
    feats = compute_features(rgb)
    tr_idx, tr_y = sample_split(labels, regions, split["train"])
    te_idx, te_y = sample_split(labels, regions, split["test"])
    print(f"train {len(tr_y)} px ({int(tr_y.sum())} pos), "
          f"test {len(te_y)} px ({int(te_y.sum())} pos)")

    models: list[tuple[str, str, object]] = [
        ("rule-purple-delta", "min(R-G,B-G)",
         TunedScalarRule("purple-delta", lambda f: np.minimum(
             f[..., 0] - f[..., 1], f[..., 2] - f[..., 1]))),
        ("rule-hsv-box", "hsv", HsvBoxRule()),
        ("mahalanobis", "lab", Mahalanobis("lab")),
        ("mahalanobis", "lab+d", Mahalanobis("lab+d")),
    ]
    for fs in FEATURE_SETS:
        models.append(("logreg", fs, SklearnModel(
            LogisticRegression(max_iter=2000, class_weight="balanced"), fs)))
        models.append(("linear-svm", fs, SklearnModel(
            LinearSVC(class_weight="balanced", dual="auto"), fs)))
        models.append(("dtree-d6", fs, SklearnModel(
            DecisionTreeClassifier(max_depth=6, class_weight="balanced",
                                   random_state=0), fs)))
        models.append(("rforest-60", fs, SklearnModel(
            RandomForestClassifier(60, max_depth=12, class_weight="balanced",
                                   random_state=0, n_jobs=-1), fs)))
    for fs in ("lab", "lab+d"):
        models.append(("knn-5", fs, SklearnModel(
            KNeighborsClassifier(5, n_jobs=-1), fs, max_train=10_000)))

    results = []
    masks = {}
    for name, fs, model in models:
        t0 = time.time()
        model.fit(feats, tr_idx, tr_y)
        key = f"{name}[{fs}]"
        if name == "knn-5":  # full-image kNN is too slow; score samples only
            tr_p = model.est.predict(
                feats[..., cols(FEATURE_SETS[fs])][tr_idx]).astype(bool)
            te_p = model.est.predict(
                feats[..., cols(FEATURE_SETS[fs])][te_idx]).astype(bool)
        else:
            pred = model.predict_image(feats)
            masks[key] = pred
            tr_p, te_p = pred[tr_idx], pred[te_idx]
        row = dict(model=name, features=fs,
                   train=prf(tr_y, tr_p), test=prf(te_y, te_p),
                   fit_s=round(time.time() - t0, 1))
        results.append(row)
        print(f"{key:28s} train F1 {row['train']['f1']:.3f}  "
              f"test F1 {row['test']['f1']:.3f}  "
              f"P {row['test']['precision']:.3f} R {row['test']['recall']:.3f}")

    results.sort(key=lambda r: -r["test"]["f1"])
    (out / "results.json").write_text(json.dumps(results, indent=2))
    lines = ["| model | features | train F1 | test P | test R | test F1 | TP | FP | FN |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        t = r["test"]
        lines.append(f"| {r['model']} | {r['features']} | {r['train']['f1']:.3f} "
                     f"| {t['precision']:.3f} | {t['recall']:.3f} | {t['f1']:.3f} "
                     f"| {t['tp']} | {t['fp']} | {t['fn']} |")
    (out / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))

    # Diagnostic contact sheets: one representative per model family + the
    # best overall, on the path crop and on the full image (to expose FPs in
    # UI chrome / far terrain).
    picked, seen = [], set()
    for r in results:
        if r["model"] == "knn-5":
            continue
        if r["model"] not in seen or len(picked) < 2:
            picked.append(f"{r['model']}[{r['features']}]")
            seen.add(r["model"])
    crop = (0, 980, 1290, 1660)
    contact_sheet(
        [(k, diagnostic_panel(rgb, masks[k], labels, crop, 0.5)) for k in picked],
        out / "contact-sheet-crop.png", ncols=2)
    contact_sheet(
        [(k, diagnostic_panel(rgb, masks[k], labels, None, 0.25)) for k in picked],
        out / "contact-sheet-full.png", ncols=4)

    # ------------------------------------------------------------- stage 2
    stage2 = []
    panels = []
    for key in picked[:2]:
        mask, skel = reconstruct(masks[key])
        sc = skeleton_scores(skel, labels == 1)
        stage2.append(dict(model=key, **sc))
        overlay = rgb.copy()
        overlay[mask] = overlay[mask] * 0.4 + np.array([255, 120, 0]) * 0.6
        overlay[ndi.binary_dilation(skel, np.ones((3, 3)))] = (0, 255, 255)
        img = Image.fromarray(overlay[980:1660].astype(np.uint8))
        panels.append((f"{key} skel comp={sc['completeness']:.2f} "
                       f"corr={sc['correctness']:.2f} n={sc['components']}",
                       img.resize((img.width // 2, img.height // 2))))
        print(f"stage2 {key}: {sc}")
    contact_sheet(panels, out / "stage2-reconstruction.png", ncols=1)
    (out / "stage2.json").write_text(json.dumps(stage2, indent=2))
    print(f"wrote diagnostics to {out}")


if __name__ == "__main__":
    main()
