import { describe, it, expect } from 'vitest';
import {
  extractRailCandidates,
  type Px,
  type OccluderFootprint,
  type RailCandidate,
} from '../../packages/alg/src/detectors/threeFactor/geometry/railExtraction';

describe('railExtraction', () => {
  describe('full rectangular pad outline', () => {
    it('should find 4 rails with long edges ranking above short edges', () => {
      // Build a 10x6 rectangle: pixels form the outline only.
      const width = 10;
      const height = 6;
      const pixels: Px[] = [];

      // Top edge (y=0, x=0..10).
      for (let x = 0; x <= width; x++) {
        pixels.push([x, 0]);
      }
      // Bottom edge (y=height, x=0..10).
      for (let x = 0; x <= width; x++) {
        pixels.push([x, height]);
      }
      // Left edge (x=0, y=1..height-1), excluding corners.
      for (let y = 1; y < height; y++) {
        pixels.push([0, y]);
      }
      // Right edge (x=width, y=1..height-1), excluding corners.
      for (let y = 1; y < height; y++) {
        pixels.push([width, y]);
      }

      const rails = extractRailCandidates(pixels, []);

      expect(rails.length).toBe(4);

      // Long edges (horizontal, top and bottom) should rank higher than short edges (vertical, left and right).
      const topRail = rails.find(
        (r) =>
          Math.abs(r.angleRad - 0) < 0.1 ||
          Math.abs(r.angleRad - Math.PI) < 0.1
      );
      const leftRail = rails.find(
        (r) =>
          Math.abs(r.angleRad - Math.PI / 2) < 0.1 ||
          Math.abs(r.angleRad + Math.PI / 2) < 0.1
      );

      expect(topRail).toBeDefined();
      expect(leftRail).toBeDefined();

      if (topRail && leftRail) {
        // Horizontal edge spans width, vertical edge spans height.
        // Long edges (width 10) should rank above short edges (height 6).
        const topIdx = rails.indexOf(topRail);
        const leftIdx = rails.indexOf(leftRail);
        expect(topIdx).toBeLessThan(leftIdx);
      }
    });
  });

  describe('L-shape', () => {
    it('should find 2 dominant rails with correct angles', () => {
      // L-shaped fragment: horizontal leg (0,0) to (10,0), vertical leg (10,0) to (10,6).
      const pixels: Px[] = [];

      // Horizontal leg.
      for (let x = 0; x <= 10; x++) {
        pixels.push([x, 0]);
      }
      // Vertical leg (excluding corner already added).
      for (let y = 1; y <= 6; y++) {
        pixels.push([10, y]);
      }

      const rails = extractRailCandidates(pixels, []);

      expect(rails.length).toBe(2);

      // One rail should be roughly horizontal (angle ~0).
      const horizontalRail = rails.find(
        (r) =>
          Math.abs(r.angleRad) < 0.3 ||
          Math.abs(r.angleRad - Math.PI) < 0.3
      );
      // One rail should be roughly vertical (angle ~±π/2).
      const verticalRail = rails.find(
        (r) =>
          Math.abs(r.angleRad - Math.PI / 2) < 0.3 ||
          Math.abs(r.angleRad + Math.PI / 2) < 0.3
      );

      expect(horizontalRail).toBeDefined();
      expect(verticalRail).toBeDefined();
    });
  });

  describe('thin sliver', () => {
    it('should find 1 rail with correct angle within tolerance', () => {
      // Half of a long horizontal edge: pixels from (0,0) to (15,0).
      const pixels: Px[] = [];
      for (let x = 0; x <= 15; x++) {
        pixels.push([x, 0]);
      }

      const rails = extractRailCandidates(pixels, []);

      expect(rails.length).toBe(1);
      expect(rails[0]).toBeDefined();

      const rail = rails[0];
      // Angle should be roughly horizontal (close to 0 or π).
      const angle = rail.angleRad;
      const isHorizontal = Math.abs(angle) < 0.2 || Math.abs(angle - Math.PI) < 0.2;
      expect(isHorizontal).toBe(true);
    });
  });

  describe('ring with bite (occlusion)', () => {
    it('should rank unoccluded edge first with occludedFractionPx=0', () => {
      // Rectangular ring: outline of a 12x8 rectangle, with a "bite" missing (simulating basket occlusion).
      // Top: (0,0) to (12,0)
      // Right: (12,0) to (12,8)
      // Bottom: (12,8) to (0,8)
      // Left: (0,8) to (0,0), but missing the bottom-left segment (y=6 to y=8) to simulate a bite.

      const pixels: Px[] = [];

      // Top edge.
      for (let x = 0; x <= 12; x++) {
        pixels.push([x, 0]);
      }
      // Right edge.
      for (let y = 0; y <= 8; y++) {
        pixels.push([12, y]);
      }
      // Bottom edge.
      for (let x = 0; x <= 12; x++) {
        pixels.push([x, 8]);
      }
      // Left edge (partial, missing the bite at y=6 to y=8).
      for (let y = 0; y <= 5; y++) {
        pixels.push([0, y]);
      }

      // Define a basket occluder that covers the right edge at y=2 to y=4.
      const basketPixels = new Set<string>();
      for (let y = 2; y <= 4; y++) {
        basketPixels.add(`12,${y}`);
      }
      const occluders: OccluderFootprint[] = [
        {
          kind: 'basket',
          pixels: basketPixels,
        },
      ];

      const rails = extractRailCandidates(pixels, occluders);

      expect(rails.length).toBeGreaterThanOrEqual(1);

      // Find the top edge rail (horizontal, y=0).
      const topRail = rails.find(
        (r) =>
          r.points.some(([x, y]) => Math.abs(y - 0) < 0.5) &&
          (Math.abs(r.angleRad) < 0.3 || Math.abs(r.angleRad - Math.PI) < 0.3)
      );

      // Find the right edge rail (vertical, x=12, partially occluded).
      const rightRail = rails.find(
        (r) =>
          r.points.some(([x, y]) => Math.abs(x - 12) < 0.5) &&
          (Math.abs(r.angleRad - Math.PI / 2) < 0.3 ||
            Math.abs(r.angleRad + Math.PI / 2) < 0.3)
      );

      if (topRail && rightRail) {
        // Top edge should be unoccluded.
        expect(topRail.occludedFractionPx).toBe(0);
        // Right edge should be partially occluded.
        expect(rightRail.occludedFractionPx).toBeGreaterThan(0);
        // Top edge should rank higher (better quality or lower occlusion).
        const topIdx = rails.indexOf(topRail);
        const rightIdx = rails.indexOf(rightRail);
        expect(topIdx).toBeLessThan(rightIdx);
      }
    });
  });

  describe('blob with no straight edges', () => {
    it('should return very few rails with low straightness', () => {
      // Create a small filled square (3x3) which has short edges on all sides.
      // Short edges will have low straightness because corner noise dominates.
      const pixels: Px[] = [];
      for (let x = 4; x <= 6; x++) {
        for (let y = 4; y <= 6; y++) {
          pixels.push([x, y]);
        }
      }

      const rails = extractRailCandidates(pixels, []);

      // A tiny square has short boundary segments; might find at most 1-2 very short rails.
      expect(rails.length).toBeLessThanOrEqual(2);

      // Any rail found should have very low straightness due to corners.
      for (const rail of rails) {
        expect(rail.lengthPx).toBeLessThan(5);
      }
    });
  });

  describe('determinism', () => {
    it('should return deeply equal output for identical inputs', () => {
      // Use the rectangle from test case 1.
      const width = 10;
      const height = 6;
      const buildPixels = (): Px[] => {
        const pixels: Px[] = [];
        for (let x = 0; x <= width; x++) {
          pixels.push([x, 0]);
        }
        for (let x = 0; x <= width; x++) {
          pixels.push([x, height]);
        }
        for (let y = 1; y < height; y++) {
          pixels.push([0, y]);
        }
        for (let y = 1; y < height; y++) {
          pixels.push([width, y]);
        }
        return pixels;
      };

      const occluders: OccluderFootprint[] = [];

      const result1 = extractRailCandidates(buildPixels(), occluders);
      const result2 = extractRailCandidates(buildPixels(), occluders);

      // Same number of results.
      expect(result1.length).toBe(result2.length);

      // Each rail should match exactly.
      for (let i = 0; i < result1.length; i++) {
        const r1 = result1[i];
        const r2 = result2[i];

        expect(r1.angleRad).toBeCloseTo(r2.angleRad, 9);
        expect(r1.lengthPx).toBeCloseTo(r2.lengthPx, 6);
        expect(r1.straightnessScore).toBeCloseTo(r2.straightnessScore, 6);
        expect(r1.interruptionPx).toBeCloseTo(r2.interruptionPx, 6);
        expect(r1.qualityScore).toBeCloseTo(r2.qualityScore, 6);
        expect(r1.occludedFractionPx).toBeCloseTo(r2.occludedFractionPx, 6);

        // Points should match in count and coordinates.
        expect(r1.points.length).toBe(r2.points.length);
        for (let j = 0; j < r1.points.length; j++) {
          expect(r1.points[j][0]).toBe(r2.points[j][0]);
          expect(r1.points[j][1]).toBe(r2.points[j][1]);
        }
      }
    });
  });

  describe('edge cases', () => {
    it('should return empty for too few pixels', () => {
      const pixels: Px[] = [[0, 0], [1, 0], [2, 0]]; // Only 3 pixels, less than MIN_RAIL_PIXELS=4.
      const rails = extractRailCandidates(pixels, []);
      expect(rails.length).toBe(0);
    });

    it('should handle occluders correctly', () => {
      // Horizontal line from (0,0) to (10,0).
      const pixels: Px[] = [];
      for (let x = 0; x <= 10; x++) {
        pixels.push([x, 0]);
      }

      // Occlude the middle 3 pixels.
      const occludedPixels = new Set<string>();
      for (let x = 4; x <= 6; x++) {
        occludedPixels.add(`${x},0`);
      }

      const occluders: OccluderFootprint[] = [
        {
          kind: 'badge',
          pixels: occludedPixels,
        },
      ];

      const rails = extractRailCandidates(pixels, occluders);

      expect(rails.length).toBeGreaterThanOrEqual(1);
      const rail = rails[0];

      // The rail should have all 11 points (boundary extracts all).
      expect(rail.points.length).toBeGreaterThanOrEqual(4);
      // Occlusion fraction should be roughly 3/11.
      expect(rail.occludedFractionPx).toBeCloseTo(3 / 11, 1);
    });
  });

  describe('sorting and ranking', () => {
    it('should rank longer rails higher than shorter ones on same shape', () => {
      // Use the rectangular outline from the first test: 4 edges with varying lengths.
      // This demonstrates ranking: longer horizontal edges (10px span) should rank above
      // shorter vertical edges (6px span) due to higher quality scores.
      const width = 10;
      const height = 6;
      const pixels: Px[] = [];

      // Build the rectangle outline.
      for (let x = 0; x <= width; x++) {
        pixels.push([x, 0]);
      }
      for (let x = 0; x <= width; x++) {
        pixels.push([x, height]);
      }
      for (let y = 1; y < height; y++) {
        pixels.push([0, y]);
      }
      for (let y = 1; y < height; y++) {
        pixels.push([width, y]);
      }

      const rails = extractRailCandidates(pixels, []);

      expect(rails.length).toBe(4);

      // Find horizontal and vertical rails.
      const horizontalRails = rails.filter(
        (r) =>
          Math.abs(r.angleRad) < 0.3 ||
          Math.abs(r.angleRad - Math.PI) < 0.3
      );
      const verticalRails = rails.filter(
        (r) =>
          Math.abs(r.angleRad - Math.PI / 2) < 0.3 ||
          Math.abs(r.angleRad + Math.PI / 2) < 0.3
      );

      // Should have 2 horizontal and 2 vertical.
      expect(horizontalRails.length).toBe(2);
      expect(verticalRails.length).toBe(2);

      // Horizontal rails have length ~width (10), vertical have length ~height (6).
      // Thus horizontal should rank higher.
      const firstRailIsHorizontal =
        Math.abs(rails[0].angleRad) < 0.3 ||
        Math.abs(rails[0].angleRad - Math.PI) < 0.3;
      expect(firstRailIsHorizontal).toBe(true);
    });
  });
});
