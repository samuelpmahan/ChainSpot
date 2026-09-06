import sys
sys.path.insert(0, 'bend-follower/lib')
from tracker import bilinear_sample, localize_bend

def test_bilinear_subpixel():
    assert abs(bilinear_sample([[0.0,1.0],[2.0,3.0]], .5, .5)-1.5) < 1e-9

def test_bend_piecewise_fit():
    pts=[(float(i),0.0) for i in range(7)]+[(6.0+j*.7,j*.7) for j in range(1,8)]
    out=localize_bend(pts,min_segment=3,min_angle_change=.3)
    assert out.status == 'FOUND'

def test_straight_is_unknown():
    assert localize_bend([(float(i),.05*i) for i in range(14)],min_segment=3).status == 'UNKNOWN'

def test_multiscale_broad_reversal_is_unknown():
    from tracker import multiscale_edge_support
    # Narrow bright line: positive small-delta derivative, broad sampling reverses.
    def sample(x,y): return 10.0 if 0.0 < x < 1.0 else (-5.0 if x > 2.0 else 0.0)
    assert multiscale_edge_support(sample,(0.0,0.0),(1.0,0.0),(0.5,3.0)) != multiscale_edge_support(sample,(0.0,0.0),(1.0,0.0),(0.5,3.0))
