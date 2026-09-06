import json
from pathlib import Path

from PIL import Image

from render_trace import format_trace, render_trace, validate_trace


def test_trace_render_maps_each_row_and_highlights_h18(tmp_path: Path):
    source = tmp_path / "source.png"
    output = tmp_path / "overlay.png"
    Image.new("RGB", (240, 180), "#20252d").save(source)
    trace = {
        "runId": "run-1", "imageId": "image-1", "paramsHash": "p",
        "featureId": "ternary", "traceHash": "t",
        "rays": [{"id": "H18", "points": [[10, 20], [160, 20]]},
                 {"id": "H1", "points": [[10, 50], [160, 50]]}],
        "spatialRows": [
            {"rowId": "H18/80", "rayId": "H18", "distancePx": 80,
             "center": {"x": 80, "y": 20}, "state": "accepted",
             "rawValues": {"left": 4}, "reason": "edge", "samples": [{"x": 80, "y": 22, "state": "accepted"}],
             "segments": [{"points": [[78, 18], [82, 18]]}]},
            {"rowId": "H1/5", "rayId": "H1", "distancePx": 5,
             "center": {"x": 15, "y": 50}, "verdict": "rejected", "raw": {"left": 0}, "reason": "flat"},
        ],
    }
    manifest = render_trace(trace, source, output)
    assert output.exists()
    assert set(manifest["objects"]) == {"H18/80", "H1/5"}
    assert manifest["objects"]["H18/80"]["highlight"] == "H18-distance"
    assert manifest["metadata"]["traceHash"] == "t"
    assert len(manifest["legend"]) == 4
    # List-form ray records must be accepted and drawn before row overlays.
    assert Image.open(output).getpixel((85, 20)) != (32, 37, 45, 255)


def test_formatter_preserves_identity_rows_values_and_reasons():
    trace = {"runId": "r", "imageId": "i", "paramsHash": "p", "featureId": "f", "traceHash": "h",
             "rows": [{"rowId": "H2/10", "verdict": "pass", "rawValues": {"score": 1}, "reason": "strong"}]}
    text = format_trace(trace)
    assert "TRACE runId=r imageId=i paramsHash=p featureId=f traceHash=h" in text
    assert 'ROW H2/10 verdict=pass raw={"score":1} reason="strong"' in text


def test_duplicate_row_ids_rejected():
    try:
        validate_trace({"rows": [{"rowId": "x"}, {"rowId": "x"}]})
    except ValueError as exc:
        assert "duplicate" in str(exc)
    else:
        raise AssertionError("duplicate IDs should fail")
