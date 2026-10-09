const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../comfyui-extension/web/photoshop.js"), "utf8").trimStart().replace(/^import .*;\r?\n/gm, "");

function harness() {
  const calls = [], toasts = [], draws = [];
  let extension, contextListener, serial = 0;
  const results = new Map();
  class Image {
    constructor(filename) { this.src = "http://localhost:8188/view?filename=" + filename + "&type=temp"; this.naturalWidth=32; this.naturalHeight=24; }
  }
  const context = {
    app: {canvas:{getNodeMenuOptions(node){return [{content:"Load Image"}, ...extension.getNodeMenuItems(node)];}},registerExtension(value) {extension=value;},extensionManager:{toast:{add(value){toasts.push(value);}}}},
    api: {async fetchApi(route, options={}) {
      calls.push({route,options});
      if (route === "/upload/image") return {ok:true,json:async()=>({name:"custom-preview.png",type:"temp",subfolder:""})};
      if (route === "/photoshop-bridge/requests") {
        const body=JSON.parse(options.body);const id=String(++serial);
        results.set(id,{status:"done",image:body.kind==="receive"?{filename:"photoshop-"+id+".png",subfolder:"",type:"input"}:body.image});
        return {ok:true,json:async()=>({id})};
      }
      return {ok:true,json:async()=>results.get(route.split("/").pop())};
    }},
    window:{location:{href:"http://localhost:8188/",origin:"http://localhost:8188"}},
    document:{addEventListener(type,listener){if(type==="contextmenu")contextListener=listener;},createElement(){return {width:0,height:0,getContext(){return {drawImage(image){draws.push(image);}};},toBlob(callback){callback(new Blob(["pixels"],{type:"image/png"}));}};}},
    HTMLImageElement:Image, URL, AbortSignal, Blob, FormData, crypto:require("node:crypto").webcrypto, Date,
    setTimeout(callback){queueMicrotask(callback);},console
  };
  vm.runInNewContext(source,context);
  extension.beforeRegisterNodeDef(null,{name:"LoadImage",input:{required:{image:[[],{image_upload:true}]}}});
  extension.setup();
  return {extension,calls,toasts,draws,Image,contextMenu(target){contextListener({target});}};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const lastRequest = h => JSON.parse(h.calls.filter(call=>call.route==="/photoshop-bridge/requests").at(-1).options.body);

test("sends the exact clicked thumbnail instead of a different preview", async()=>{
  const h=harness();const images=[new h.Image("first.png"),new h.Image("second.png")];
  h.contextMenu(images[1]);
  const menu=h.extension.getNodeMenuItems({imgs:images,imageIndex:0});
  menu.find(item=>item.content==="Send to Photoshop").callback();await flush();
  assert.equal(lastRequest(h).image.filename,"second.png");
  assert.equal(h.toasts.at(-1).severity,"success");
});

test("uses the enlarged image instead of a stale grid hover index", async()=>{
  const h=harness();const menu=h.extension.getNodeMenuItems({imgs:[new h.Image("large.png"),new h.Image("hover.png")],imageIndex:0,overIndex:1});
  menu[0].callback();await flush();assert.equal(lastRequest(h).image.filename,"large.png");
});

test("uses the hovered batch thumbnail when no image is enlarged", async()=>{
  const h=harness();const menu=h.extension.getNodeMenuItems({imgs:[new h.Image("first.png"),new h.Image("hover.png")],imageIndex:null,overIndex:1});
  menu[0].callback();await flush();assert.equal(lastRequest(h).image.filename,"hover.png");
});

test("offers an explicit image submenu when a batch has no selected thumbnail", async()=>{
  const h=harness();const menu=h.extension.getNodeMenuItems({imgs:[new h.Image("first.png"),new h.Image("chosen.png")]});
  assert.equal(menu[0].submenu.options.length,2);menu[0].submenu.options[1].callback();await flush();assert.equal(lastRequest(h).image.filename,"chosen.png");
});

test("custom preview routes are copied from the exact displayed image", async()=>{
  const h=harness();const image=new h.Image("x.png");image.src="blob:custom-preview";
  h.extension.getNodeMenuItems({imgs:[image]})[0].callback();await flush();
  assert.equal(h.draws[0],image);assert.equal(lastRequest(h).image.filename,"custom-preview.png");
});

test("receiving changes only the clicked node and preserves another node's image", async()=>{
  const h=harness();const callbacks=[];const graph={setDirtyCanvas(){},change(){}};
  const first={name:"image",value:"first-original.png",options:{values:[]},callback(value){callbacks.push(value);}};
  const second={name:"image",value:"second-original.png",options:{values:[]},callback(value){callbacks.push(value);}};
  const a={comfyClass:"LoadImage",widgets:[first],graph};const b={comfyClass:"LoadImage",widgets:[second],graph};
  h.extension.getNodeMenuItems(a).find(item=>item.content==="Receive Photoshop image").callback();await flush();
  assert.equal(first.value,"photoshop-1.png");assert.equal(second.value,"second-original.png");
  h.extension.getNodeMenuItems(b).find(item=>item.content==="Receive Photoshop image").callback();await flush();
  assert.equal(first.value,"photoshop-1.png");assert.equal(second.value,"photoshop-2.png");
  assert.deepEqual(callbacks,["photoshop-1.png","photoshop-2.png"]);
});

test("a removed target node is not changed after the transfer finishes", async()=>{
  const h=harness();const widget={name:"image",value:"original.png",options:{values:[]}};
  const node={comfyClass:"LoadImage",widgets:[widget],graph:{setDirtyCanvas(){}}};
  h.extension.getNodeMenuItems(node)[0].callback();node.graph=null;await flush();
  assert.equal(widget.value,"original.png");assert.equal(h.toasts.at(-1).severity,"error");
});

test("an output or bridge node with an unrelated image widget is not treated as a receiver",()=>{
  const h=harness();const menu=h.extension.getNodeMenuItems({comfyClass:"PreviewBridge",widgets:[{name:"image",options:{values:[]}}],imgs:[new h.Image("bridge.png")]});
  assert.equal(menu.length,2);assert.equal(menu[0].content,"Send to Photoshop");assert.equal(menu[1].content,"Send to Photoshop as New Layer");
});

test("new-layer send preserves the exact clicked image and requests the layer action", async()=>{
  const h=harness();const images=[new h.Image("first.png"),new h.Image("layer.png")];
  h.contextMenu(images[1]);
  const menu=h.extension.getNodeMenuItems({imgs:images,imageIndex:0});
  menu.find(item=>item.content==="Send to Photoshop as New Layer").callback();await flush();
  assert.equal(lastRequest(h).kind,"send-layer");
  assert.equal(lastRequest(h).image.filename,"layer.png");
  assert.equal(h.toasts.at(-1).severity,"success");
});

test("new-layer batch submenu sends the chosen image without changing the original send mode", async()=>{
  const h=harness();const menu=h.extension.getNodeMenuItems({imgs:[new h.Image("first.png"),new h.Image("layer.png")]});
  const layerMenu=menu.find(item=>item.content==="Send to Photoshop as New Layer");
  layerMenu.submenu.options[1].callback();await flush();
  assert.equal(lastRequest(h).kind,"send-layer");assert.equal(lastRequest(h).image.filename,"layer.png");
  menu.find(item=>item.content==="Send to Photoshop").submenu.options[0].callback();await flush();
  assert.equal(lastRequest(h).kind,"send");assert.equal(lastRequest(h).image.filename,"first.png");
});
