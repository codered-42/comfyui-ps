const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const core = require("../core.js");
const png = fs.readFileSync(path.join(__dirname, "../icon.png"));
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(commands, exportError, missingIds = []) {
  const elements = new Map(), calls = [], uploads = [], opened = [], completed = [];
  let setup;
  function element(id) {
    if (!elements.has(id)) elements.set(id,{value:"",textContent:"",className:"",disabled:false,addEventListener(){}});
    return elements.get(id);
  }
  const storage = {localFileSystem:{async getDataFolder(){return {async getEntry(){throw new Error("No settings");},async createFile(){return {async write(){}};}};}}};
  async function request(url, options={}) {
    calls.push({url,options});
    if (url.endsWith("/photoshop-bridge/next")) return {request:commands.shift() || null};
    if (url.endsWith("/result")) {completed.push(JSON.parse(options.body));return {status:"done"};}
    if (/\/photoshop-bridge\/requests\//.test(url)) {
      if (missingIds.includes(url.split("/").pop())) { const error=new Error("Request no longer exists");error.status=404;throw error; }
      return {status:"processing"};
    }
    if (url.includes("/view?")) return png.buffer.slice(png.byteOffset,png.byteOffset+png.byteLength);
    if (url.endsWith("/upload/image")) {
      const form=await new Response(options.body,{headers:options.headers}).formData();
      const file=form.get("image");uploads.push({filename:file.name,bytes:Buffer.from(await file.arrayBuffer())});
      return {name:file.name,subfolder:"",type:"input"};
    }
    throw new Error("Unexpected route: "+url);
  }
  const context = {document:{getElementById:element},console:{error(){}},setInterval(){},Date,JSON,encodeURIComponent,
    require(name){
      if(name==="uxp")return {entrypoints:{setup(value){setup=value;}},storage};
      if(name==="./core.js")return core;
      if(name==="./network.js")return {request};
      if(name==="./photoshop.js")return {async exportCanvas(){if(exportError)throw new Error(exportError);return {bytes:png,documentName:"Active document.psd",width:48,height:48};},async openResult(bytes,filename,asLayer){opened.push({bytes,filename,asLayer});}};
      throw new Error(name);
    }
  };
  vm.runInNewContext(source,context);
  return {elements,calls,uploads,opened,completed,async show(){setup.panels["comfyui-ps-panel"].show();await flush();},async poll(){await context.comfyuiPhotos.pollMenus();},hide(){setup.panels["comfyui-ps-panel"].hide();}};
}

test("right-click send opens precisely the requested preview without consulting history",async()=>{
  const h=harness([{id:"chosen",kind:"send",claim:"token",image:{filename:"clicked-preview.png",subfolder:"PreviewBridge",type:"temp"}}]);
  await h.show();
  assert.equal(h.opened[0].filename,"clicked-preview.png");
  const query=new URL(h.calls.find(call=>call.url.includes("/view?")).url).searchParams;
  assert.equal(query.get("subfolder"),"PreviewBridge");assert.equal(query.get("type"),"temp");
  assert.equal(h.calls.some(call=>call.url.includes("/history")),false);
  assert.equal(h.completed[0].claim,"token");
});

test("two receiver actions upload separate PNG snapshots and acknowledge their exact filenames",async()=>{
  const h=harness([{id:"a",kind:"receive",claim:"a-token",filename:"photoshop-a.png"},{id:"b",kind:"receive",claim:"b-token",filename:"photoshop-b.png"}]);
  await h.show();await h.poll();
  assert.deepEqual(h.uploads.map(value=>value.filename),["photoshop-a.png","photoshop-b.png"]);
  for(const upload of h.uploads)assert.ok(upload.bytes.equals(png));
  assert.deepEqual(h.completed.map(value=>value.image.filename),["photoshop-a.png","photoshop-b.png"]);
  assert.equal(h.opened.length,0);
});

test("Photoshop export errors are reported to the requesting menu and controls recover",async()=>{
  const h=harness([{id:"a",kind:"receive",claim:"token",filename:"photoshop-a.png"}],"Open an image in Photoshop first.");
  await h.show();
  assert.equal(h.completed[0].error,"Open an image in Photoshop first.");
  assert.equal(h.elements.get("status").className,"status error");
  assert.equal(h.elements.get("send-image").disabled,false);
});

test("a hidden panel does not accept new menu transfers",async()=>{
  const h=harness([]);await h.show();h.hide();
  const before=h.calls.length;await h.poll();assert.equal(h.calls.length,before);
});

test("a request lost during a ComfyUI restart does not block later menu transfers",async()=>{
  const image={filename:"fresh.png",type:"temp",subfolder:""};
  const h=harness([{id:"lost",kind:"send",claim:"old",image},{id:"fresh",kind:"send",claim:"new",image}],undefined,["lost"]);
  await h.show();assert.equal(h.opened.length,0);
  await h.show();assert.equal(h.opened.length,1);assert.equal(h.completed[0].claim,"new");
});

test("new-layer menu requests use the selected image and enable layer import",async()=>{
  const image={filename:"layer-preview.png",subfolder:"chosen",type:"temp"};
  const h=harness([{id:"layer",kind:"send-layer",claim:"token",image}]);
  await h.show();
  assert.equal(h.opened[0].filename,"layer-preview.png");assert.equal(h.opened[0].asLayer,true);
  assert.equal(h.completed[0].claim,"token");assert.equal(h.completed[0].error,undefined);
  const query=new URL(h.calls.find(call=>call.url.includes("/view?")).url).searchParams;
  assert.equal(query.get("subfolder"),"chosen");
  assert.equal(h.calls.some(call=>call.url.includes("/history")),false);
});

test("original send requests continue to open separate documents",async()=>{
  const h=harness([{id:"send",kind:"send",claim:"token",image:{filename:"separate.png",type:"temp"}}]);
  await h.show();assert.equal(h.opened[0].asLayer,false);
});
