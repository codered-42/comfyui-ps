import importlib.util
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

PROJECT = Path(__file__).resolve().parents[1]


class BridgeRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.folders = {kind: Path(self.directory.name) / kind for kind in ("input", "output", "temp")}
        for folder in self.folders.values():
            folder.mkdir()
        (self.folders["temp"] / "chosen.png").write_bytes((PROJECT / "icon.png").read_bytes())
        dependencies = {
            "folder_paths": types.SimpleNamespace(get_directory_by_type=lambda kind: str(self.folders[kind])),
            "server": types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=web.RouteTableDef()))),
        }
        previous = {name: sys.modules.get(name) for name in dependencies}
        sys.modules.update(dependencies)
        try:
            spec = importlib.util.spec_from_file_location("photoshop_bridge_test", PROJECT / "comfyui-extension" / "__init__.py")
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)
        finally:
            for name, old in previous.items():
                if old is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = old
        app = web.Application()
        app.add_routes(self.module.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.directory.cleanup()

    async def online(self):
        await self.client.get("/photoshop-bridge/next")

    async def create(self, kind, image=None):
        response = await self.client.post("/photoshop-bridge/requests", json={"kind": kind, "image": image})
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    async def next(self):
        return (await (await self.client.get("/photoshop-bridge/next")).json())["request"]

    async def test_status_check_does_not_claim_requests_or_pretend_photoshop_is_online(self):
        response = await self.client.get("/photoshop-bridge/status")
        self.assertFalse((await response.json())["photoshop_connected"])
        self.assertEqual(self.module.state.last_poll, 0)
        await self.online()
        created = await self.create("receive")
        await self.client.get("/photoshop-bridge/status")
        self.assertEqual(self.module.state.public(created["id"])["status"], "pending")

    async def test_requires_an_open_photoshop_panel(self):
        response = await self.client.post("/photoshop-bridge/requests", json={"kind": "receive"})
        self.assertEqual(response.status, 503)
        self.assertIn("Open", (await response.json())["error"])

    async def test_sends_exact_chosen_preview_and_delivers_only_once(self):
        await self.online()
        reference = {"filename": "chosen.png", "subfolder": "", "type": "temp"}
        created = await self.create("send", reference)
        command = await self.next()
        self.assertEqual(command["image"], reference)
        self.assertEqual(command["id"], created["id"])
        self.assertIsNone(await self.next())
        response = await self.client.post("/photoshop-bridge/requests/" + command["id"] + "/result", json={"claim": command["claim"]})
        self.assertEqual((await response.json())["status"], "done")

    async def test_new_layer_action_is_delivered_with_the_exact_image_and_completed(self):
        await self.online()
        reference = {"filename": "chosen.png", "subfolder": "", "type": "temp"}
        created = await self.create("send-layer", reference)
        command = await self.next()
        self.assertEqual(command["kind"], "send-layer")
        self.assertEqual(command["image"], reference)
        self.assertNotIn("filename", command)
        response = await self.client.post("/photoshop-bridge/requests/" + command["id"] + "/result", json={"claim": command["claim"]})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["status"], "done")
        self.assertEqual(self.module.state.public(created["id"])["kind"], "send-layer")

    async def test_new_layer_action_rejects_missing_image_and_unsafe_paths(self):
        await self.online()
        for image in (None, {"filename": "../chosen.png", "type": "temp"}):
            response = await self.client.post("/photoshop-bridge/requests", json={"kind": "send-layer", "image": image})
            self.assertEqual(response.status, 400)

    async def test_receivers_get_distinct_files_and_keep_their_own_results(self):
        await self.online()
        first = await self.create("receive")
        second = await self.create("receive")
        first_command = await self.next()
        second_command = await self.next()
        self.assertNotEqual(first_command["filename"], second_command["filename"])
        for command in (first_command, second_command):
            image = {"filename": command["filename"], "subfolder": "", "type": "input"}
            (self.folders["input"] / image["filename"]).write_bytes(b"snapshot")
            response = await self.client.post("/photoshop-bridge/requests/" + command["id"] + "/result", json={"claim": command["claim"], "image": image})
            self.assertEqual(response.status, 200, await response.text())
            self.assertEqual((await response.json())["image"], image)
        first_result = await (await self.client.get("/photoshop-bridge/requests/" + first["id"])).json()
        second_result = await (await self.client.get("/photoshop-bridge/requests/" + second["id"])).json()
        self.assertNotEqual(first_result["image"]["filename"], second_result["image"]["filename"])
        self.assertNotIn("claim", first_result)

    async def test_rejects_completion_from_wrong_claim(self):
        await self.online()
        await self.create("send", {"filename": "chosen.png", "type": "temp"})
        command = await self.next()
        response = await self.client.post("/photoshop-bridge/requests/" + command["id"] + "/result", json={"claim": "wrong"})
        self.assertEqual(response.status, 409)

    async def test_receiver_cannot_return_a_different_nodes_file(self):
        await self.online()
        await self.create("receive")
        command = await self.next()
        (self.folders["input"] / "other.png").write_bytes(b"other")
        response = await self.client.post("/photoshop-bridge/requests/" + command["id"] + "/result", json={"claim": command["claim"], "image": {"filename": "other.png", "type": "input"}})
        self.assertEqual(response.status, 409)

    async def test_errors_from_photoshop_reach_the_requesting_menu(self):
        await self.online()
        await self.create("receive")
        command = await self.next()
        response = await self.client.post("/photoshop-bridge/requests/" + command["id"] + "/result", json={"claim": command["claim"], "error": "Open an image in Photoshop first."})
        result = await response.json()
        self.assertEqual(result["status"], "error")
        self.assertIn("Open an image", result["error"])

    async def test_cancelled_requests_are_not_delivered_later(self):
        await self.online()
        created = await self.create("receive")
        await self.client.post("/photoshop-bridge/requests/" + created["id"] + "/cancel", json={})
        self.assertIsNone(await self.next())

    async def test_expired_requests_are_not_delivered_later(self):
        await self.online()
        created = await self.create("receive")
        self.module.state.requests[created["id"]]["created"] = time.monotonic() - 121
        self.assertIsNone(await self.next())
        result = await (await self.client.get("/photoshop-bridge/requests/" + created["id"])).json()
        self.assertEqual(result["status"], "error")

    async def test_rejects_paths_outside_comfy_image_folders(self):
        await self.online()
        for filename in ("../chosen.png", "C:\\private\\chosen.png", "/private/chosen.png", "chosen.mp4"):
            response = await self.client.post("/photoshop-bridge/requests", json={"kind": "send", "image": {"filename": filename, "type": "temp"}})
            self.assertEqual(response.status, 400)
        response = await self.client.post("/photoshop-bridge/requests", json={"kind": "send", "image": {"filename": "chosen.png", "subfolder": "..", "type": "temp"}})
        self.assertEqual(response.status, 400)


if __name__ == "__main__":
    unittest.main()
