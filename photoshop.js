"use strict";
const {app, core, constants} = require("photoshop");
const {storage} = require("uxp");
const {localResultName} = require("./core.js");

async function exportCanvas() {
  if (!app.documents.length) throw new Error("Open an image in Photoshop first.");
  const folder = await storage.localFileSystem.getTemporaryFolder();
  const file = await folder.createFile("photoshop-send-" + Date.now() + ".png", {overwrite: true});
  try {
    const exported = await core.executeAsModal(async () => {
      if (!app.documents.length) throw new Error("Open an image in Photoshop first.");
      const source = app.activeDocument;
      // Save As Copy writes the visible canvas without flattening/editing the source PSD.
      await source.saveAs.png(file, {method: constants.PNGMethod.QUICK, compression: 6, interlaced: false}, true);
      return {documentName: source.name, width: Number(source.width), height: Number(source.height)};
    }, {commandName: "Send image to ComfyUI"});
    return {...exported, bytes: await file.read({format: storage.formats.binary})};
  } finally {
    await file.delete().catch(() => {});
  }
}

async function openResult(bytes, filename, asLayer = false) {
  const folder = await storage.localFileSystem.getTemporaryFolder();
  const file = await folder.createFile(localResultName(filename), {overwrite: false});
  let keepFile = false;
  try {
    await file.write(bytes, {format: storage.formats.binary});
    return await core.executeAsModal(async context => {
      // Capture the destination before opening the incoming image changes focus.
      const target = asLayer && app.documents.length ? app.activeDocument : null;
      const source = await app.open(file);
      if (!target) {
        keepFile = true;
        return source;
      }
      context.hostControl.registerAutoCloseDocument(source.id);
      try {
        if (source.layers.length > 1) await source.mergeVisibleLayers();
        const layer = await source.activeLayers[0].duplicate(target);
        app.activeDocument = target;
        layer.name = filename.split(/[\\/]/).pop();
        await layer.bringToFront();
        return target;
      } finally {
        await source.closeWithoutSaving();
        app.activeDocument = target;
      }
    }, {commandName: asLayer ? "Receive ComfyUI image as new layer" : "Get ComfyUI result"});
  } finally {
    // A new document owns its file; a copied layer no longer needs the import file.
    if (!keepFile) await file.delete().catch(() => {});
  }
}

module.exports = {exportCanvas, openResult};