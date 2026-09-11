#!/usr/bin/env python3
"""Lift the trained LoRA weights out of a Replicate `trained_model.tar`.

Usage: lora_extract_safetensors.py <tar_path> <out_path>

A flux-trainer tar looks like:

    output/flux_train_replicate/
    output/flux_train_replicate/config.yaml
    output/flux_train_replicate/captions/0001.txt   (…one per training image)
    output/flux_train_replicate/lora.safetensors    (~330 MB)

so the weights are a nested member, not a top-level one. We pick the first
member whose name ends in `.safetensors`, preferring one whose basename is
exactly `lora.safetensors` (what every run of that trainer produces) over any
other — a tar that also ships, say, an optimiser shard must still give us the
LoRA. The file is streamed member → out_path, never read into memory: at a
third of a gigabyte a buffer would be silly.

Prints `OK:<member name>:<bytes>` on success. On failure: one line on stderr,
exit 1.
"""
import shutil
import sys
import tarfile


def pick_member(names):
    """First `.safetensors` member, `lora.safetensors` winning over the rest.

    Mirrored in TypeScript by pickSafetensorsMember() in
    frontend/server/utils/loraFalWeights.ts — keep the two in step.
    """
    candidates = [n for n in names if n.lower().endswith(".safetensors")]
    if not candidates:
        return None
    for n in candidates:
        if n.rsplit("/", 1)[-1].lower() == "lora.safetensors":
            return n
    return candidates[0]


def extract(tar_path, out_path):
    with tarfile.open(tar_path, "r:*") as tar:
        members = [m for m in tar.getmembers() if m.isfile()]
        name = pick_member([m.name for m in members])
        if name is None:
            return None, 0
        member = next(m for m in members if m.name == name)
        src = tar.extractfile(member)
        if src is None:
            return None, 0
        with src, open(out_path, "wb") as dst:
            shutil.copyfileobj(src, dst, length=1 << 20)
        return member.name, member.size


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: lora_extract_safetensors.py <tar_path> <out_path>\n")
        return 2
    tar_path, out_path = argv[1], argv[2]
    try:
        name, size = extract(tar_path, out_path)
    except Exception as e:  # noqa: BLE001 — the caller only ever sees one line
        sys.stderr.write("Could not read the trained-model tar: %s\n" % e)
        return 1
    if name is None:
        sys.stderr.write("No .safetensors member in %s\n" % tar_path)
        return 1
    sys.stdout.write("OK:%s:%d\n" % (name, size))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
