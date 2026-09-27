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
                IO.Combo.Input("gender", options=["Not chosen", "Male", "Female", "Non-binary"], default="Not chosen",
                               tooltip="The face's gender. Easel needs it to fit the face well."),
                IO.Combo.Input("keep_hair_from", options=["The picture", "The face photo"], default="The picture",
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


class PersonSwapVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="PersonSwapVideo",
            display_name="Person swap (video)",
            description="Replace the person in a video with the person in a photo, with Pixverse. "
                        "Swaps the whole person, not only the face. $0.15–0.20 up to 5 s, doubled up to 10 s. "
                        "Please don't use on real people without their consent, or on minors.",
            category="video",
            inputs=[
                IO.String.Input("video_url", default="", tooltip="A video uploaded to Sailor, up to 10 seconds."),
                IO.Image.Input("image", tooltip="A photo of the person to put in the video."),
                IO.Combo.Input("resolution", options=["360p", "540p", "720p"], default="720p"),
            ],
            outputs=[IO.Video.Output()],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"range_usd","min_usd":0.15,"max_usd":0.40}'),
        )

    @classmethod
    def execute(cls, video_url, image, resolution) -> IO.NodeOutput:
        raise RuntimeError("Person swap (video) runs on Sailor's runner. Switch on the person-swap-video family.")


class FaceExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [FaceSwapNode, PersonSwapVideoNode]


async def comfy_entrypoint() -> FaceExtension:
    return FaceExtension()
