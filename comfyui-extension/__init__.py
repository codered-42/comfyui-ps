import time
import uuid
from collections import OrderedDict
from pathlib import Path, PureWindowsPath

from aiohttp import web

import folder_paths
from server import PromptServer

NODE_CLASS_MAPPINGS = {}
WEB_DIRECTORY = "./web"
PREFIX = "/photoshop-bridge"
REQUEST_TIMEOUT = 120


def image_reference(value):
    if not isinstance(value, dict):
        raise ValueError("Choose an image first.")
    filename = value.get("filename")
    subfolder = value.get("subfolder", "")
    kind = value.get("type")
    if kind not in {"input", "output", "temp"} or not isinstance(filename, str) or not isinstance(subfolder, str):
        raise ValueError("Invalid ComfyUI image reference.")
    if not filename or Path(filename).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}:
        raise ValueError("Choose a still image, not a video.")
    for part in (filename, subfolder):
        windows = PureWindowsPath(part)
        if Path(part).is_absolute() or windows.drive or windows.root or ".." in part.replace("\\", "/").split("/"):
            raise ValueError("Image paths must stay inside ComfyUI's image folders.")
    root = Path(folder_paths.get_directory_by_type(kind)).resolve()
    target = (root / subfolder / filename).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise ValueError("This image is no longer available in ComfyUI.")
    return {"filename": filename, "subfolder": subfolder, "type": kind}


class BridgeState:
    def __init__(self):
        self.requests = OrderedDict()
        self.last_poll = 0

    def expire(self):
        now = time.monotonic()
        for key, item in list(self.requests.items()):
            age = now - item["created"]
            if age > REQUEST_TIMEOUT and item["status"] in {"pending", "processing"}:
                item.update(status="error", error="Photoshop did not finish the transfer. Open its ComfyUI Photos panel and try again.")
            if age > REQUEST_TIMEOUT * 2:
                del self.requests[key]

    def create(self, kind, image=None):
        self.expire()
        if kind not in {"send", "send-layer", "receive"}:
            raise ValueError("Unknown Photoshop action.")
        if time.monotonic() - self.last_poll > 15:
            raise RuntimeError("Open the ComfyUI Photos panel in Photoshop, then try again.")
        if sum(item["status"] in {"pending", "processing"} for item in self.requests.values()) >= 20:
            raise RuntimeError("Photoshop has several transfers waiting. Let them finish first.")
        key = uuid.uuid4().hex
        item = {"id": key, "kind": kind, "status": "pending", "created": time.monotonic()}
        if kind in {"send", "send-layer"}:
            item["image"] = image_reference(image)
        else:
            item["filename"] = "photoshop-" + key + ".png"
        self.requests[key] = item
        return item

    def next(self):
        self.expire()
        self.last_poll = time.monotonic()
        for item in self.requests.values():
            if item["status"] == "pending":
                item.update(status="processing", claim=uuid.uuid4().hex)
                return {key: value for key, value in item.items() if key != "created"}
        return None

    def result(self, key, payload):
        self.expire()
        item = self.requests.get(key)
        if item is None:
            raise KeyError(key)
        if item["status"] != "processing" or payload.get("claim") != item.get("claim"):
            raise ValueError("This transfer is no longer active.")
        error = payload.get("error")
        if error:
            item.update(status="error", error=str(error)[:600])
        else:
            if item["kind"] == "receive":
                image = image_reference(payload.get("image"))
                if image != {"filename": item["filename"], "subfolder": "", "type": "input"}:
                    raise ValueError("Photoshop returned an unexpected input image.")
                item["image"] = image
            item["status"] = "done"
        return item

    def public(self, key):
        self.expire()
        item = self.requests.get(key)
        if item is None:
            raise KeyError(key)
        return {name: item[name] for name in ("id", "kind", "status", "image", "error") if name in item}


state = BridgeState()
routes = PromptServer.instance.routes


async def read_payload(request):
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="Expected JSON data.")
    if not isinstance(payload, dict):
        raise web.HTTPBadRequest(text="Expected a JSON object.")
    return payload


@routes.get(PREFIX + "/status")
async def bridge_status(request):
    connected = bool(state.last_poll) and time.monotonic() - state.last_poll <= 15
    return web.json_response({"version": "0.3.0", "photoshop_connected": connected}, headers={"Cache-Control": "no-store"})


@routes.get(PREFIX + "/next")
async def next_request(request):
    return web.json_response({"request": state.next()}, headers={"Cache-Control": "no-store"})


@routes.post(PREFIX + "/requests")
async def create_request(request):
    payload = await read_payload(request)
    try:
        item = state.create(payload.get("kind"), payload.get("image"))
        return web.json_response(state.public(item["id"]))
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except RuntimeError as error:
        return web.json_response({"error": str(error)}, status=503)


@routes.get(PREFIX + "/requests/{key}")
async def request_status(request):
    try:
        return web.json_response(state.public(request.match_info["key"]), headers={"Cache-Control": "no-store"})
    except KeyError:
        return web.json_response({"error": "This transfer expired. Try again."}, status=404)


@routes.post(PREFIX + "/requests/{key}/result")
async def complete_request(request):
    payload = await read_payload(request)
    try:
        item = state.result(request.match_info["key"], payload)
        return web.json_response(state.public(item["id"]))
    except KeyError:
        return web.json_response({"error": "This transfer expired. Try again."}, status=404)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=409)


@routes.post(PREFIX + "/requests/{key}/cancel")
async def cancel_request(request):
    item = state.requests.get(request.match_info["key"])
    if item and item["status"] in {"pending", "processing"}:
        item.update(status="error", error="Transfer cancelled. Try again when Photoshop is ready.")
    return web.json_response({"cancelled": True})
