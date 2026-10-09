import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PREFIX = "/photoshop-bridge";
const PHOTOSHOP_MENU = Symbol("ComfyUIPhotos.menu");
let contextImage = null;
const receiverInputs = new Map();

function notify(message, error = false) {
  app.extensionManager.toast.add({severity: error ? "error" : "success", summary: "Photoshop", detail: message, life: error ? 8000 : 3500});
}

async function json(route, body) {
  const response = await api.fetchApi(PREFIX + route, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : {"Content-Type": "application/json"},
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Photoshop transfer failed (HTTP " + response.status + ").");
  return data;
}

async function transfer(kind, image) {
  const created = await json("/requests", {kind, image});
  const deadline = Date.now() + 90000;
  try {
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const result = await json("/requests/" + created.id);
      if (result.status === "error") throw new Error(result.error);
      if (result.status === "done") return result;
    }
    throw new Error("Photoshop did not respond. Open its ComfyUI Photos panel and try again.");
  } catch (error) {
    await json("/requests/" + created.id + "/cancel", {}).catch(() => {});
    throw error;
  }
}

function selectedImage(node) {
  const images = node.imgs || [];
  if (contextImage && Date.now() - contextImage.time < 1500) {
    const matched = images.find(img => img.src === contextImage.src);
    if (matched) return matched;
  }
  // The enlarged image wins over a stale hover index from the thumbnail grid.
  if (Number.isInteger(node.imageIndex) && images[node.imageIndex]) return images[node.imageIndex];
  if (Number.isInteger(node.overIndex) && images[node.overIndex]) return images[node.overIndex];
  return images.length === 1 ? images[0] : null;
}

async function imageReference(image) {
  const src = image.currentSrc || image.src;
  const url = new URL(src, window.location.href);
  if (url.origin === window.location.origin && /\/view$/.test(url.pathname)) {
    const filename = url.searchParams.get("filename");
    const type = url.searchParams.get("type") || "output";
    if (filename && ["input", "output", "temp"].includes(type) && !/^[\\/]|^[a-z]:/i.test(filename)) {
      return {filename, subfolder: url.searchParams.get("subfolder") || "", type};
    }
  }
  // Custom nodes may use blob URLs or their own preview routes. Copy the displayed pixels.
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  if (!canvas.width || !canvas.height) throw new Error("Wait for this image to finish loading.");
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("This custom preview cannot be copied as an image.");
  const form = new FormData();
  form.append("image", blob, "comfy-to-photoshop-" + crypto.randomUUID() + ".png");
  form.append("type", "temp");
  const response = await api.fetchApi("/upload/image", {method: "POST", body: form});
  if (!response.ok) throw new Error("Could not prepare the custom preview for Photoshop.");
  const result = await response.json();
  return {filename: result.name, subfolder: result.subfolder || "", type: result.type};
}

async function sendImage(image, asLayer = false) {
  try {
    await transfer(asLayer ? "send-layer" : "send", await imageReference(image));
    notify(asLayer ? "Sent to Photoshop as a new layer, or a new document if none was open." : "Opened the selected image in Photoshop.");
  } catch (error) { notify(error.message || String(error), true); }
}

function imageWidget(node) {
  const input = receiverInputs.get(node.comfyClass || node.type);
  return input ? node.widgets?.find(widget => widget.name === input && widget.options && "values" in widget.options) : null;
}

async function receiveImage(node, widget) {
  try {
    const graph = node.graph;
    const result = await transfer("receive");
    if (!graph || node.graph !== graph || !node.widgets?.includes(widget)) throw new Error("The target node was removed before the transfer finished.");
    const image = result.image;
    const value = (image.subfolder ? image.subfolder + "/" : "") + image.filename;
    const values = typeof widget.options.values === "function" ? widget.options.values() : widget.options.values;
    if (Array.isArray(values) && !values.includes(value)) values.push(value);
    widget.value = value;
    widget.callback?.(value);
    node.graph.setDirtyCanvas(true, true);
    node.graph.change?.();
    notify("Received Photoshop's active image into this node.");
  } catch (error) { notify(error.message || String(error), true); }
}

app.registerExtension({
  name: "ComfyUIPhotos.ContextMenus",
  setup() {
    // The extension hook appends items. Reorder this canvas's completed node menu.
    const getNodeMenuOptions = app.canvas.getNodeMenuOptions;
    Object.defineProperty(app.canvas, "getNodeMenuOptions", {
      configurable: true,
      writable: true,
      value(...args) {
        const options = getNodeMenuOptions.apply(this, args);
        const photoshop = options.filter(option => option?.[PHOTOSHOP_MENU]);
        if (!photoshop.length) return options;
        return [...photoshop, null, ...options.filter(option => !option?.[PHOTOSHOP_MENU])];
      }
    });
    document.addEventListener("contextmenu", event => {
      const target = event.target;
      const image = target instanceof HTMLImageElement ? target : target.closest?.(".image-preview")?.querySelector("img");
      contextImage = image ? {src: image.currentSrc || image.src, time: Date.now()} : null;
    }, true);
  },
  beforeRegisterNodeDef(_nodeType, nodeData) {
    const inputs = {...nodeData.input?.required, ...nodeData.input?.optional};
    const input = Object.entries(inputs).find(([, spec]) => spec[1]?.image_upload && !spec[1]?.allow_batch);
    if (input) receiverInputs.set(nodeData.name, input[0]);
  },
  getNodeMenuItems(node) {
    const options = [];
    const widget = imageWidget(node);
    if (widget) options.push({content: "Receive Photoshop image", callback: () => { void receiveImage(node, widget); }});
    const images = node.imgs || [];
    if (images.length) {
      const image = selectedImage(node);
      for (const asLayer of [false, true]) {
        const content = asLayer ? "Send to Photoshop as New Layer" : "Send to Photoshop";
        if (image) options.push({content, callback: () => { void sendImage(image, asLayer); }});
        else options.push({content, submenu: {options: images.map((img, index) => ({content: "Image " + (index + 1), callback: () => { void sendImage(img, asLayer); }}))}});
      }
    }
    for (const option of options) option[PHOTOSHOP_MENU] = true;
    return options;
  }
});
