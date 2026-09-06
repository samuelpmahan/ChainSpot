import unittest
import numpy as np
from scipy.ndimage import gaussian_filter
from render import measure

class MeasureChecks(unittest.TestCase):
    @staticmethod
    def image(lum):return np.repeat(lum[:,:,None],3,axis=2).astype(np.float32)
    def test_uniform_unknown(self):
        f=measure(self.image(np.ones((128,128))*100))
        self.assertFalse(f['span_resolved'].any())
        self.assertEqual(float(f['net_change'].max()),0)
    def test_blurred_transition_has_larger_measured_span(self):
        step=np.zeros((128,128));step[:,64:]=80
        a=measure(self.image(step));b=measure(self.image(gaussian_filter(step,3)))
        self.assertTrue(a['span_resolved'][32,32]);self.assertTrue(b['span_resolved'][32,32])
        self.assertGreater(b['positive_gradient_mass_span'][32,32],a['positive_gradient_mass_span'][32,32])
        self.assertAlmostEqual(float(a['net_change'][32,32]),float(b['net_change'][32,32]),delta=.1)
    def test_ramp_boundary_active(self):
        ramp=np.tile(np.arange(128),(128,1)).astype(float)
        f=measure(self.image(ramp))
        # Constant slope reaches the entire window: no isolated boundary endpoint.
        self.assertFalse(f['span_resolved'][32,32])
    def test_grid_and_profiles_preserve_coordinates(self):
        lum=np.tile(np.arange(128),(128,1)).astype(float)
        f=measure(self.image(lum))
        self.assertEqual(float(f['x'][32,32]),64)
        self.assertTrue(np.allclose(f['raw_profiles'][:,32,32],np.arange(52,77),atol=.01))

if __name__=='__main__':unittest.main()
