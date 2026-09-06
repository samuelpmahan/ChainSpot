import unittest

from ternary_methods import method_a, method_b, rgb_distance, rgb_variance


class TernaryMethodTests(unittest.TestCase):
    def test_rgb_helpers(self):
        self.assertEqual(rgb_distance((0, 0, 0), (3, 4, 0)), 5.0)
        self.assertAlmostEqual(rgb_variance([(0, 0, 0), (2, 2, 2)]), 1.0)

    def test_channelwise_median_and_reference_selector(self):
        terrain = [(10, 10, 10)] * 3
        live = [(200, 20, 20), (20, 200, 20), (20, 20, 200)]
        result = method_a(terrain + [(20, 20, 200)] * 3 + terrain, center=4,
                          expected_offsets=(-1, 1), transverse_samples=live,
                          predrop_samples=[(20, 200, 20)], terrain_samples=terrain,
                          reference_selector="predrop")
        self.assertEqual(result["source"], "predrop")
        self.assertEqual(result["predrop_reference"], (20.0, 200.0, 20.0))

    def test_method_a_ribbon_and_edge(self):
        terrain = [(10, 10, 10)] * 3
        ribbon = [(200, 0, 0)] * 3
        result = method_a(terrain + ribbon + terrain, center=4, expected_offsets=(-1, 1),
                          transverse_samples=ribbon, terrain_samples=terrain)
        self.assertEqual(result["classification"], "RIBBON")
        result = method_a(terrain + ribbon + terrain, center=4, expected_offsets=(-4, 1),
                          transverse_samples=ribbon, terrain_samples=terrain)
        self.assertEqual(result["classification"], "EDGE")

    def test_method_b_fits_edges(self):
        profile = [(5, 5, 5)] * 3 + [(180, 20, 20)] * 4 + [(5, 5, 5)] * 3
        result = method_b(profile, contrast=10)
        self.assertEqual(result["classification"], "RIBBON")
        self.assertEqual(result["edges"], (3, 7))

    def test_method_b_uniform_is_unknown(self):
        result = method_b([(8, 8, 8)] * 8, contrast=2)
        self.assertEqual(result["classification"], "UNKNOWN")

    def test_method_b_rejects_monotonic_terrain_gradient(self):
        profile = [(float(i), float(i), float(i)) for i in range(14)]
        result = method_b(profile, contrast=0.1)
        self.assertEqual(result["classification"], "UNKNOWN")
        self.assertEqual(result["quality"], "gradient_failure")

    def test_method_b_can_fit_strip_away_from_profile_center(self):
        # The conventional center (index 6) is terrain; the ribbon is wholly
        # to its left.  Fitting must not force an edge to contain offset zero.
        profile = [(5, 5, 5)] * 3 + [(180, 20, 20)] * 4 + [(5, 5, 5)] * 9
        result = method_b(profile, contrast=10)
        self.assertEqual(result["classification"], "RIBBON")
        self.assertEqual(result["edges"], (3, 7))


if __name__ == "__main__":
    unittest.main()
