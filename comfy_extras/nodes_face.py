"""Face swap and Person swap (video): node definitions only.

Both run on Sailor's runner (families face-swap and person-swap-video, fal).
The InsightFace / inswapper implementation was removed: its models are
licensed for non-commercial research only
(docs/superpowers/specs/2026-09-26-non-commercial-face-models-replacement-design.md).
"""
from __future__ import annotations

from typing_extensions import override

from comfy_api.latest import ComfyExtension, IO


class FaceSwapNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FaceSwap",
            display_name="Face swap",
            description="Put the face from one photo into another picture, with Easel. About $0.05 a picture. "
                        "Please don't use on real people without their consent, or on minors.",
            category="image",
            inputs=[
                IO.Image.Input("source_face", tooltip="A photo of the face to use. A clear, well-lit face works best."),
                IO.Image.Input("target_frames", tooltip="The picture to put the face in."),
                IO.Combo.Input("gender", options=["", "male", "female", "non-binary"], default="",
                               tooltip="The face's gender. Easel needs it to fit the face well."),
                IO.Combo.Input("keep_hair_from", options=["target", "face"], default="target",
                               tooltip="Whose hair to keep: the picture's or the face photo's."),
            ],
            outputs=[IO.Image.Output(display_name="image")],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.05}'),
        )

    @classmethod
    def execute(cls, source_face, target_frames, gender, keep_hair_from) -> IO.NodeOutput:
        if target_frames.shape[0] > 1:
            raise RuntimeError("Face swap takes one picture. For video, use Person swap (video).")
        raise RuntimeError("Face swap runs on Sailor's runner. Switch on the face-swap family.")


class FaceExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [FaceSwapNode]


async def comfy_entrypoint() -> FaceExtension:
    return FaceExtension()
