#!/usr/bin/env python3
"""Final presentation wrapper for basket_glyph_close_spike_v2.

- chooses the minimum-bottleneck badge->basket repair path, so the R# dots
  shown on a card cannot contradict the card's reported minimum gap;
- prints raw Python topology counts and compares them to Golden's committed
  8 exclusive / 3 shared / 7 split / 0 no-seed baseline before interpreting
  any repair result.
"""
from __future__ import annotations

import heapq
from collections import defaultdict

import basket_glyph_close_spike as base
import basket_glyph_close_spike_v2 as v2


def minimax_path(connections, start, goal):
    if start is None or goal is None or start == goal:
        return []
    adjacency = defaultdict(list)
    for c in connections:
        adjacency[c.a].append((c.b, c))
        adjacency[c.b].append((c.a, c))
    best = {start: 0.0}
    parent = {}
    heap = [(0.0, start)]
    while heap:
        cost, node = heapq.heappop(heap)
        if cost != best.get(node):
            continue
        if node == goal:
            break
        for nxt, edge in adjacency.get(node, []):
            candidate = max(cost, edge.gap_px)
            if candidate < best.get(nxt, float("inf")):
                best[nxt] = candidate
                parent[nxt] = (node, edge)
                heapq.heappush(heap, (candidate, nxt))
    if goal not in best:
        return list(connections)
    path = []
    cur = goal
    while cur != start:
        prev, edge = parent[cur]
        path.append(edge)
        cur = prev
    return list(reversed(path))


def parity_check():
    source = base.load_source_image(base.GOLDEN_ZIP)
    labels, _ = base.segment_ribbon_mass(source)
    badge, basket = base.build_seed_placements(labels)
    owners = defaultdict(set)
    for n, lbl in badge.items():
        if lbl is not None:
            owners[lbl].add(n)
    for n, lbl in basket.items():
        if lbl is not None:
            owners[lbl].add(n)
    counts = {"exclusive": 0, "shared": 0, "split": 0, "noSeed": 0}
    for n, *_ in base.GOLDEN_TRUTH:
        bl, kl = badge[n], basket[n]
        if bl is None or kl is None:
            counts["noSeed"] += 1
        elif bl != kl:
            counts["split"] += 1
        elif len(owners[bl]) > 1:
            counts["shared"] += 1
        else:
            counts["exclusive"] += 1
    expected = {"exclusive": 8, "shared": 3, "split": 7, "noSeed": 0}
    print(f"Python raw topology counts: {counts}")
    print(f"Committed Golden baseline: {expected}")
    print("PARITY: EXACT" if counts == expected else "PARITY: DIFFERENT — treat repair numbers as transcription-only")


v2.relevant_connections = minimax_path
parity_check()
v2.main()
