"""Sailor Bridge — data directory for the Sailor wrapper.

The postMessage bridge (js/bridge.js, injected into ComfyUI's own frontend) is
gone: the Sailor app runs its Vue canvas and queues prompts on /prompt directly,
so there is no engine iframe to inject into. This package stays because
comfy_extras/nodes_timeline.py reads and writes scene_defaults/ and
scene_thumbnails/ under it. It registers no nodes and serves no web directory.
"""

NODE_CLASS_MAPPINGS = {}
