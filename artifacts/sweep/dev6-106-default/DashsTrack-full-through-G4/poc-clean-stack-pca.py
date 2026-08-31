from __future__ import annotations

import json
import time
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import TwoSlopeNorm
from scipy.ndimage import distance_transform_edt
from sklearn.decomposition import PCA


RUN_DIR = Path(__file__).resolve().parent
RENDER_DIR = RUN_DIR / "renders" / "run"
CROPS_PATH = RENDER_DIR / "poc.clean-stack-plus-5.crops.rgba.bin"
FAMILY_PATH = RENDER_DIR / "poc.clean-stack-plus-5.family.bin"
OUT_PNG = RENDER_DIR / "poc.clean-stack-pca.png"
OUT_JSON = RENDER_DIR / "poc.clean-stack-pca.receipt.json"
N, H, W = 16, 82, 56


total_start = time.perf_counter()
load_start = time.perf_counter()
rgba = np.fromfile(CROPS_PATH, dtype=np.uint8).reshape(N, H, W, 4)
family = np.fromfile(FAMILY_PATH, dtype=np.uint8).reshape(H, W)
load_ms = (time.perf_counter() - load_start) * 1000

factor_start = time.perf_counter()
# Exact grayscale used by the current pathfinding samplers: arithmetic RGB mean.
gray = rgba[..., :3].mean(axis=3).astype(np.float64)
core = family > 0
unclaimed = ~core
distance = distance_transform_edt(unclaimed)

# CourseResidual frame: remove one scalar background level per crop using the
# outermost frame, which is five pixels beyond the learned B/W shell.
border = np.zeros((H, W), dtype=bool)
border[[0, -1], :] = True
border[:, [0, -1]] = True
border_gray = np.median(gray[:, border], axis=1)
residual = gray - border_gray[:, None, None]
X = residual[:, unclaimed]

# Keep the shared mean direction instead of centering it away. This SVD factor
# asks whether all baskets carry one common residual image. Centered PCA below
# then shows what remains variable after that common structure is removed.
u, singular, vt = np.linalg.svd(X, full_matrices=False)
shared_energy = singular**2 / np.sum(singular**2)
shared_scores = u[:, 0] * singular[0]
shared_factor = vt[0].copy()
if np.median(shared_scores) < 0:
    shared_scores *= -1
    shared_factor *= -1

pca = PCA().fit(X)
centered_components = pca.components_[:3]
centered_evr = pca.explained_variance_ratio_
mean_residual = X.mean(axis=0)

def project(values: np.ndarray) -> np.ndarray:
    image = np.full((H, W), np.nan, dtype=np.float64)
    image[unclaimed] = values
    return image

mean_image = project(mean_residual)
shared_image = project(shared_factor)
centered_images = [project(component) for component in centered_components]

near_2 = unclaimed & (distance <= 2)
far_4 = distance >= 4
shared_energy_image = np.nan_to_num(shared_image) ** 2
shared_near_fraction = float(shared_energy_image[near_2].sum() / shared_energy_image.sum())
near_area_fraction = float(near_2.sum() / unclaimed.sum())
near_enrichment = shared_near_fraction / near_area_fraction
centered_far_fractions = []
for image in centered_images:
    energy = np.nan_to_num(image) ** 2
    centered_far_fractions.append(float(energy[far_4].sum() / energy.sum()))

same_sign = int(max(np.count_nonzero(shared_scores > 0), np.count_nonzero(shared_scores < 0)))
factor_ms = (time.perf_counter() - factor_start) * 1000

render_start = time.perf_counter()
plt.rcParams.update({
    "font.size": 11,
    "axes.titlesize": 13,
    "axes.titleweight": "bold",
    "figure.facecolor": "#10151f",
    "axes.facecolor": "#10151f",
    "text.color": "#e6edf7",
    "axes.labelcolor": "#cbd5e1",
    "xtick.color": "#cbd5e1",
    "ytick.color": "#cbd5e1",
    "axes.edgecolor": "#536074",
})

fig = plt.figure(figsize=(16, 8))
grid = fig.add_gridspec(
    2,
    5,
    height_ratios=[3.8, 1.4],
    left=0.027,
    right=0.985,
    bottom=0.06,
    top=0.84,
    wspace=0.05,
    hspace=0.25,
)
fig.suptitle("PCA demolition test — gray pixels outside pure B/W basket ownership", fontsize=22, fontweight="bold", y=0.975)
fig.text(
    0.5,
    0.925,
    "16 exact inside-edge alignments · pathfinder gray = (R+G+B)/3 · each crop minus its outer-border median · no truth",
    ha="center",
    color="#b8c3d6",
    fontsize=12,
)

image_specs = [
    (mean_image, "Shared mean residual", "repeatable signal before PCA"),
    (shared_image, "Shared factor 1", f"uncentered SVD · {shared_energy[0]*100:.1f}% total energy"),
    (centered_images[0], "Centered PC1", f"{centered_evr[0]*100:.1f}% remaining variance"),
    (centered_images[1], "Centered PC2", f"{centered_evr[1]*100:.1f}% remaining variance"),
    (centered_images[2], "Centered PC3", f"{centered_evr[2]*100:.1f}% remaining variance"),
]

for col, (image, title, subtitle) in enumerate(image_specs):
    ax = fig.add_subplot(grid[0, col])
    finite = np.abs(image[np.isfinite(image)])
    limit = float(np.percentile(finite, 99)) if finite.size else 1.0
    if limit == 0:
        limit = 1.0
    ax.imshow(image, cmap="coolwarm", norm=TwoSlopeNorm(vmin=-limit, vcenter=0, vmax=limit), interpolation="nearest")
    ax.contour(core.astype(float), levels=[0.5], colors=["#00e5ff"], linewidths=1.3)
    ax.set_title(f"{title}\n{subtitle}", pad=10)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.text(
        0.02,
        0.02,
        "cyan = 2,145 known B/W pixels",
        transform=ax.transAxes,
        color="#d8e2f0",
        fontsize=9,
        bbox={"facecolor": "#10151fcc", "edgecolor": "none", "pad": 2},
    )

ax_energy = fig.add_subplot(grid[1, 0:2])
bars = np.arange(1, 9)
ax_energy.bar(bars, shared_energy[:8] * 100, color="#4aa3ff")
ax_energy.set_title("Uncentered factor energy")
ax_energy.set_xlabel("Factor")
ax_energy.set_ylabel("Total residual energy (%)")
ax_energy.set_xticks(bars)
ax_energy.grid(axis="y", alpha=0.2)
ax_energy.text(1, shared_energy[0] * 100 + 2, f"{shared_energy[0]*100:.1f}%", ha="center", color="#e6edf7")

ax_scores = fig.add_subplot(grid[1, 2:4])
ax_scores.bar(np.arange(1, N + 1), shared_scores, color="#57c785")
ax_scores.axhline(0, color="#8c98aa", linewidth=1)
ax_scores.set_title(f"All {same_sign}/16 baskets load with the same sign")
ax_scores.set_xlabel("Clean basket sample")
ax_scores.set_ylabel("Shared-factor score")
ax_scores.set_xticks(np.arange(1, N + 1))
ax_scores.grid(axis="y", alpha=0.2)

ax_summary = fig.add_subplot(grid[1, 4])
ax_summary.axis("off")
summary_lines = [
    "What survived",
    f"2,145  pure B/W pixels",
    f"2,447  geometrically unclaimed in +5 frame",
    "≈232   prior repeatable fringe estimate",
    "",
    f"{shared_energy[0]*100:.1f}%  energy in one shared factor",
    f"{shared_near_fraction*100:.1f}%  of shared energy within 2px",
    f"{near_area_fraction*100:.1f}%  of unclaimed area within 2px",
    f"{near_enrichment:.2f}×  boundary-energy enrichment",
    "",
    "Centered variation moves outward:",
    f"PC1/2/3 far-field energy",
    f"{centered_far_fractions[0]*100:.0f}% / {centered_far_fractions[1]*100:.0f}% / {centered_far_fractions[2]*100:.0f}%",
]
ax_summary.text(
    0,
    1,
    "\n".join(summary_lines),
    va="top",
    ha="left",
    family="monospace",
    fontsize=11,
    linespacing=1.35,
    color="#e6edf7",
)

fig.savefig(OUT_PNG, dpi=120, facecolor=fig.get_facecolor())
plt.close(fig)
render_ms = (time.perf_counter() - render_start) * 1000
total_ms = (time.perf_counter() - total_start) * 1000

receipt = {
    "schema": "chainspot-clean-stack-pca-poc@1",
    "hypothesis": "all repeatable pixels outside modal pure B/W ownership are basket-rendering influence until falsified",
    "observable": "pathfinder gray arithmetic RGB mean",
    "frame": "exact inside-edge alignment -> +5px crop -> outer-border-median course residual",
    "counts": {
        "samples": N,
        "pureBwPixels": int(core.sum()),
        "unclaimedFramePixels": int(unclaimed.sum()),
        "priorRepeatableFringeEstimate": 232,
    },
    "factorization": {
        "sharedFactorEnergyFraction": float(shared_energy[0]),
        "sameSignSamples": same_sign,
        "sharedEnergyWithin2PxFraction": shared_near_fraction,
        "unclaimedAreaWithin2PxFraction": near_area_fraction,
        "boundaryEnergyEnrichment": near_enrichment,
        "centeredExplainedVarianceFirst3": [float(x) for x in centered_evr[:3]],
        "centeredFarFieldEnergyFirst3": centered_far_fractions,
    },
    "timingsMs": {
        "loadAlignedCacheMs": round(load_ms, 3),
        "factorizationMs": round(factor_ms, 3),
        "renderMs": round(render_ms, 3),
        "observedTotalMs": round(total_ms, 3),
    },
    "outputs": {"visualRender": str(OUT_PNG)},
}
OUT_JSON.write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
