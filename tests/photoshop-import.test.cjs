const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../photoshop.js"), "utf8");
const png = fs.readFileSync(path.join(__dirname, "../icon.png"));

function harness({documents = 1, sourceLayers = 1, failAt} = {}) {
  const originals = Array.from({length: documents}, (_, i) => ({
    id: i + 1, name: "Original " + i + ".psd", layers: [{name: "Existing " + i}],
    async closeWithoutSaving() { throw new Error("Must never close an original document"); },
    async mergeVisibleLayers() { throw new Error("Must never merge an original document"); }
  }));
  const target = originals.at(-1);
  const app = {documents: [...originals], activeDocument: target};
  const registered = [], files = [];
  let opened, merged = false, closed = false;
  const incoming = {id: 99, layers: Array.from({length: sourceLayers}, () => ({})), activeLayers: [{
    async duplicate(destination) {
      assert.equal(destination, target);
      if (failAt === "duplicate") throw new Error("Cannot import this image");
      const layer = {name: "Incoming", width: 48, height: 48, async bringToFront() {
        assert.equal(app.activeDocument, target);
        destination.layers = [layer, ...destination.layers.filter(item => item !== layer)];
      }};
      destination.layers.push(layer);
      return layer;
    }
  }], async mergeVisibleLayers() {merged = true;}, async closeWithoutSaving() {
    closed = true;
    app.documents = app.documents.filter(doc => doc !== incoming);
    app.activeDocument = app.documents.at(-1);
  }};
  app.open = async file => {
    if (failAt === "open") throw new Error("Cannot open this image");
    opened = file;
    app.documents.push(incoming);
    app.activeDocument = incoming;
    return incoming;
  };
  const storage = {formats: {binary: "binary"}, localFileSystem: {async getTemporaryFolder() {
    return {async createFile(name, options) {
      const file = {name, options, deleted: false, async write(bytes) {
        if (failAt === "write") throw new Error("Cannot write this image");
        assert.equal(bytes, png);
      }, async delete() {this.deleted = true;}};
      files.push(file);
      return file;
    }};
  }}};
  const module = {exports: {}};
  vm.runInNewContext(source, {
    module, Date,
    require(name) {
      if (name === "photoshop") return {app, constants: {}, core: {async executeAsModal(fn) {
        if (failAt === "modal") throw new Error("Photoshop is busy");
        return fn({hostControl: {registerAutoCloseDocument(id) {registered.push(id);}}});
      }}};
      if (name === "uxp") return {storage};
      if (name === "./core.js") return require("../core.js");
      throw new Error(name);
    }
  });
  return {openResult: module.exports.openResult, app, target, originals, incoming, registered, files,
    get opened() {return opened;}, get merged() {return merged;}, get closed() {return closed;}};
}

test("normal send opens a separate document and keeps its backing file", async () => {
  const h = harness();
  assert.equal(await h.openResult(png, "normal.png"), h.incoming);
  assert.equal(h.app.documents.length, 2);
  assert.equal(h.app.activeDocument, h.incoming);
  assert.deepEqual(h.target.layers.map(layer => layer.name), ["Existing 0"]);
  assert.equal(h.files[0].deleted, false);
  assert.equal(h.closed, false);
});

test("new-layer send with no document open falls back to a new document", async () => {
  const h = harness({documents: 0});
  assert.equal(await h.openResult(png, "first.png", true), h.incoming);
  assert.equal(h.app.documents.length, 1);
  assert.equal(h.app.activeDocument, h.incoming);
  assert.equal(h.files[0].deleted, false);
  assert.deepEqual(h.registered, []);
});

test("new-layer send targets the active document, preserves other layers and closes only its temporary source", async () => {
  const h = harness({documents: 2});
  assert.equal(await h.openResult(png, "generated.png", true), h.target);
  assert.deepEqual(h.app.documents, h.originals);
  assert.equal(h.app.activeDocument, h.target);
  assert.deepEqual(h.originals[0].layers.map(layer => layer.name), ["Existing 0"]);
  assert.deepEqual(h.target.layers.map(layer => layer.name), ["generated.png", "Existing 1"]);
  assert.equal(h.target.layers[0].width, 48);
  assert.equal(h.closed, true);
  assert.equal(h.files[0].deleted, true);
  assert.deepEqual(h.registered, [h.incoming.id]);
});

test("a layered incoming file is merged only in the temporary source document", async () => {
  const h = harness({sourceLayers: 2});
  await h.openResult(png, "incoming.tif", true);
  assert.equal(h.merged, true);
  assert.equal(h.target.layers.length, 2);
  assert.equal(h.closed, true);
});

test("failed layer import restores the active document and removes the temporary source", async () => {
  const h = harness({failAt: "duplicate"});
  await assert.rejects(h.openResult(png, "bad.png", true), /Cannot import/);
  assert.equal(h.app.activeDocument, h.target);
  assert.deepEqual(h.app.documents, h.originals);
  assert.deepEqual(h.target.layers.map(layer => layer.name), ["Existing 0"]);
  assert.equal(h.closed, true);
  assert.equal(h.files[0].deleted, true);
});

for (const failAt of ["write", "open", "modal"]) {
  test("failure during " + failAt + " leaves existing documents intact and removes its import file", async () => {
    const h = harness({failAt});
    await assert.rejects(h.openResult(png, "bad.png", true));
    assert.equal(h.app.activeDocument, h.target);
    assert.deepEqual(h.app.documents, h.originals);
    assert.deepEqual(h.target.layers.map(layer => layer.name), ["Existing 0"]);
    assert.equal(h.files[0].deleted, true);
  });
}
