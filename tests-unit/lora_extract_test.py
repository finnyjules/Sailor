"""Weights extraction from a Replicate trained_model.tar (scripts/lora_extract_safetensors.py)."""
import importlib.util
import io
import os
import tarfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "lora_extract_safetensors", os.path.join(ROOT, "scripts", "lora_extract_safetensors.py")
)
lx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lx)


def build_tar(path, entries):
    """entries: [(name, bytes)] — written in order, nested names make folders."""
    with tarfile.open(path, "w") as tar:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


def test_pick_member_prefers_lora_safetensors():
    assert lx.pick_member([
        "output/config.yaml",
        "output/extra.safetensors",
        "output/flux_train_replicate/lora.safetensors",
    ]) == "output/flux_train_replicate/lora.safetensors"


def test_pick_member_falls_back_to_any_safetensors():
    assert lx.pick_member(["a/config.yaml", "a/weights.safetensors"]) == "a/weights.safetensors"


def test_pick_member_returns_none_without_one():
    assert lx.pick_member(["a/config.yaml", "a/captions/0001.txt"]) is None


def test_extracts_the_nested_safetensors(tmp_path, capsys):
    # The real shape: a config beside the weights, both under a folder.
    tar_path = str(tmp_path / "trained_model.tar")
    weights = b"\x93safetensors-bytes" * 64
    build_tar(tar_path, [
        ("output/flux_train_replicate/config.yaml", b"lr: 0.0004\n"),
        ("output/flux_train_replicate/lora.safetensors", weights),
    ])
    out_path = str(tmp_path / "lora.safetensors")

    assert lx.main(["lora_extract_safetensors.py", tar_path, out_path]) == 0
    capsys.readouterr()
    name, size = lx.extract(tar_path, out_path)
    assert name == "output/flux_train_replicate/lora.safetensors"
    assert size == len(weights)
    with open(out_path, "rb") as f:
        assert f.read() == weights


def test_reports_a_tar_without_weights(tmp_path, capsys):
    tar_path = str(tmp_path / "empty.tar")
    build_tar(tar_path, [("output/config.yaml", b"x")])
    out_path = str(tmp_path / "lora.safetensors")

    assert lx.main(["lora_extract_safetensors.py", tar_path, out_path]) == 1
    assert "No .safetensors member" in capsys.readouterr().err


def test_prints_ok_line_with_member_and_size(tmp_path, capsys):
    tar_path = str(tmp_path / "trained_model.tar")
    weights = b"w" * 1234
    build_tar(tar_path, [("out/lora.safetensors", weights)])
    out_path = str(tmp_path / "lora.safetensors")

    assert lx.main(["lora_extract_safetensors.py", tar_path, out_path]) == 0
    assert capsys.readouterr().out.strip() == "OK:out/lora.safetensors:1234"


def test_bad_tar_exits_one(tmp_path, capsys):
    bad = tmp_path / "not-a-tar.tar"
    bad.write_bytes(b"definitely not a tar archive")

    assert lx.main(["lora_extract_safetensors.py", str(bad), str(tmp_path / "o")]) == 1
    assert capsys.readouterr().err.strip() != ""


if __name__ == "__main__":
    pytest.main([__file__])
