"use strict";
const {entrypoints, storage} = require("uxp");
const {INPUT_FILENAME, normalizeServer, makeUpload, latestImage, imageQuery} = require("./core.js");
const {request} = require("./network.js");
const {exportCanvas, openResult} = require("./photoshop.js");
const DEFAULT_SERVER = "http://127.0.0.1:8188/";
let busy = false, initialized = false, settingsReady;
let panelVisible = false, pollingMenus = false, nextMenuPoll = 0, pendingMenuJob = null;

function status(message, error = false) {
  const element = document.getElementById("status");
  element.textContent = message;
  element.className = error ? "status error" : "status";
}

async function loadSettings() {
  let server = DEFAULT_SERVER;
  try {
    const folder = await storage.localFileSystem.getDataFolder();
    const settings = JSON.parse(await (await folder.getEntry("settings.json")).read());
    server = normalizeServer(settings.server);
  } catch (_) { /* Missing/invalid settings use the local ComfyUI address. */ }
  document.getElementById("server-url").value = server;
}

async function serverAddress() {
  await settingsReady;
  const input = document.getElementById("server-url");
  const server = normalizeServer(input.value.trim() || DEFAULT_SERVER);
  input.value = server;
  const folder = await storage.localFileSystem.getDataFolder();
  const settings = await folder.createFile("settings.json", {overwrite: true});
  await settings.write(JSON.stringify({server}));
  return server;
}

async function run(operation) {
  if (busy) return;
  busy = true;
  for (const id of ["server-url", "send-image", "get-result"]) document.getElementById(id).disabled = true;
  try { return await operation(); }
  catch (error) {
    status(error.message || String(error), true);
    console.error("ComfyUI Photos:", error.message || String(error));
    return null;
  } finally {
    busy = false;
    for (const id of ["server-url", "send-image", "get-result"]) document.getElementById(id).disabled = false;
  }
}

async function sendImage() {
  return run(async () => {
    const server = await serverAddress();
    status("Checking ComfyUI...");
    await request(server + "/system_stats");
    status("Preparing the current Photoshop canvas...");
    const image = await exportCanvas();
    const upload = makeUpload(image.bytes);
    status("Sending " + image.width + " x " + image.height + " image...");
    const result = await request(server + "/upload/image", {method: "POST", headers: {"Content-Type": upload.contentType}, body: upload.body});
    if (result.name !== INPUT_FILENAME || result.type !== "input" || result.subfolder) throw new Error("ComfyUI saved the upload under an unexpected name. Expected " + INPUT_FILENAME + ".");
    status("Sent " + INPUT_FILENAME + "\n" + image.width + " x " + image.height + " pixels. Run your workflow in ComfyUI, then click Get Result.");
    return result;
  });
}

async function getResult() {
  return run(async () => {
    const server = await serverAddress();
    status("Looking for the latest saved image...");
    const history = await request(server + "/history?max_items=50");
    const image = latestImage(history);
    status("Downloading " + image.filename + "...");
    const bytes = await request(server + "/view?" + imageQuery(image), {binary: true});
    status("Opening the result in Photoshop...");
    await openResult(bytes, image.filename);
    status("Opened " + image.filename + " as a new document." + (image.workflowIncomplete ? "\nThis image was saved before the rest of the workflow stopped." : ""));
    return image;
  });
}

function menuStatus(message) {
  document.getElementById("menu-status").textContent = message;
}

async function handleMenuRequest(server, job) {
  const resultUrl = server + "/photoshop-bridge/requests/" + encodeURIComponent(job.id) + "/result";
  let result = {claim: job.claim};
  let message;
  try {
    if (job.kind === "send" || job.kind === "send-layer") {
      const asLayer = job.kind === "send-layer";
      status(asLayer ? "Adding the selected ComfyUI image to Photoshop..." : "Opening the image selected in ComfyUI...");
      const bytes = await request(server + "/view?" + imageQuery(job.image), {binary: true});
      await openResult(bytes, job.image.filename, asLayer);
      message = asLayer ? "Received the selected image. Added a new layer, or opened a document if none was open." : "Opened the image you selected in ComfyUI.";
    } else if (job.kind === "receive") {
      status("Sending the active document to your selected Load Image node...");
      const image = await exportCanvas();
      const upload = makeUpload(image.bytes, job.filename);
      const uploaded = await request(server + "/upload/image", {method: "POST", headers: {"Content-Type": upload.contentType}, body: upload.body});
      if (uploaded.name !== job.filename || uploaded.type !== "input" || uploaded.subfolder) throw new Error("ComfyUI saved the input under an unexpected name.");
      result.image = {filename: uploaded.name, subfolder: "", type: "input"};
      message = "Sent " + image.documentName + " to the Load Image node you selected.";
    } else throw new Error("Unknown ComfyUI menu action.");
  } catch (error) {
    await request(resultUrl, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({claim: job.claim, error: error.message || String(error)})}).catch(() => {});
    throw error;
  }
  await request(resultUrl, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(result)});
  status(message);
}

async function pollMenus() {
  if (!panelVisible || pollingMenus || busy || Date.now() < nextMenuPoll) return;
  pollingMenus = true;
  try {
    await settingsReady;
    if (!pendingMenuJob) {
      const server = normalizeServer(document.getElementById("server-url").value.trim() || DEFAULT_SERVER);
      const next = await request(server + "/photoshop-bridge/next", {timeout: 5000});
      menuStatus("ComfyUI right-click menus: connected");
      if (next.request) pendingMenuJob = {server, job: next.request};
    }
    if (pendingMenuJob) {
      const current = pendingMenuJob;
      const state = await request(current.server + "/photoshop-bridge/requests/" + encodeURIComponent(current.job.id), {timeout: 5000});
      if (state.status !== "processing") { pendingMenuJob = null; return; }
      if (busy || !panelVisible) return;
      pendingMenuJob = null;
      await run(() => handleMenuRequest(current.server, current.job));
    }
  } catch (error) {
    if (error.status === 404) pendingMenuJob = null;
    menuStatus("ComfyUI right-click menus: waiting for ComfyUI");
    nextMenuPoll = Date.now() + 10000;
  } finally { pollingMenus = false; }
}

function initialize() {
  if (initialized) return;
  initialized = true;
  document.getElementById("server-url").value = DEFAULT_SERVER;
  document.getElementById("send-image").addEventListener("click", sendImage);
  document.getElementById("get-result").addEventListener("click", getResult);
  settingsReady = loadSettings();
  document.getElementById("server-url").addEventListener("change", () => { nextMenuPoll = 0; });
  setInterval(pollMenus, 1000);
}

entrypoints.setup({plugin: {create: initialize}, panels: {"comfyui-ps-panel": {show() {
  initialize();
  const input = document.getElementById("server-url");
  if (!input.value.trim()) input.value = DEFAULT_SERVER;
  panelVisible = true;
  nextMenuPoll = 0;
  void pollMenus();
}, hide() { panelVisible = false; }}}});
initialize();
// Also available to the Photoshop developer console for live diagnosis.
globalThis.comfyuiPhotos = {sendImage, getResult, pollMenus};