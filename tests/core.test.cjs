const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeServer, makeUpload, latestImage, imageQuery, localResultName} = require('../core.js');
const image = (filename, type='output', subfolder='') => ({filename, type, subfolder});
const job = (number, images, status='success') => ({prompt:[number],status:{completed:true,status_str:status},outputs:{'9':{images}}});

test('accepts ComfyUI addresses and preserves reverse-proxy paths', () => {
  assert.equal(normalizeServer(' 127.0.0.1:8188/ '), 'http://127.0.0.1:8188');
  assert.equal(normalizeServer('HTTPS://HOST.EXAMPLE/comfy/'), 'https://host.example/comfy');
  assert.equal(normalizeServer('http://[::1]:8188/'), 'http://[::1]:8188');
  for (const address of ['', 'file:///tmp', 'http://user:password@host', 'http://host:65536', 'http://host/#workflow', 'http://host/?file=x']) assert.throws(() => normalizeServer(address));
});

test('multipart upload preserves every binary byte and requests a stable input filename', async () => {
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,255,128,13,10,0]);
  const upload = makeUpload(png);
  const form = await new Response(upload.body, {headers:{'Content-Type':upload.contentType}}).formData();
  assert.equal(form.get('type'), 'input');
  assert.equal(form.get('overwrite'), 'true');
  const file = form.get('image');
  assert.equal(file.name, 'photoshop-bridge.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
  assert.throws(() => makeUpload(new Uint8Array(12)), /valid PNG/);
});

test('chooses the newest saved result even when history keys are out of order', () => {
  const selected = latestImage({newer:job(20,[image('new.png')]),older:job(2,[image('old.png')])});
  assert.equal(selected.filename, 'new.png');
  assert.equal(selected.promptId, 'newer');
  assert.equal(selected.workflowIncomplete, false);
});

test('imports a written Save Image from a run interrupted in another branch instead of an old preview', () => {
  const oldRun=job(21,[image('ComfyUI_temp_mhnkh_00003_.png','temp')]);
  const stoppedRun={prompt:[34],status:{completed:false,status_str:'error',messages:[['execution_interrupted',{node_id:'3599:3589',node_type:'KSampler'}]]},outputs:{'3075':{images:[image('preview.png','temp')]},'3651':{images:[image('test_123_00001_.png')]},'3077:1880':{images:[image('unrelated.png','temp')]}}};
  const result=latestImage({stopped:stoppedRun,old:oldRun});
  assert.equal(result.filename,'test_123_00001_.png');
  assert.equal(result.promptId,'stopped');
  assert.equal(result.nodeId,'3651');
  assert.equal(result.workflowIncomplete,true);
});

test('also accepts a written image when another node fails after saving', () => {
  const failed=job(30,[image('already_saved.png')],'error');
  failed.status.completed=false;
  assert.equal(latestImage({failed,older:job(29,[image('older.png')])}).filename,'already_saved.png');
});

test('a stopped run without saved output does not replace the last saved image with a preview', () => {
  const stopped=job(31,[image('partial_preview.png','temp')],'error');
  stopped.status.completed=false;
  assert.equal(latestImage({stopped,good:job(29,[image('finished.png')])}).filename,'finished.png');
});

test('ignores all previews even when the newer run succeeded', () => {
  const history={newer:job(40,[image('mask.png','temp'),image('preview.png','temp')]),saved:job(39,[image('saved.png')])};
  assert.equal(latestImage(history).filename,'saved.png');
});

test('requires a saved output instead of silently importing an arbitrary preview', () => {
  assert.throws(() => latestImage({last:job(4,[image('preview.png','temp')])}), /No saved image.*Save Image/);
});

test('ignores videos, input images, and absolute custom-node filenames', () => {
  assert.equal(latestImage({last:job(4,[image('C:\\temp\\bad.png'),image('../bad.png'),image('clip.mp4'),image('source.png','input'),image('good.png')])}).filename,'good.png');
  assert.throws(() => latestImage({last:job(4,[image('clip.mp4')])}), /No saved image/);
});

test('returns the last saved image when the workflow produces a batch', () => {
  assert.equal(latestImage({last:job(4,[image('batch_1.png'),image('batch_2.png')])}).filename,'batch_2.png');
});

test('encodes filenames and folders without corrupting URL query parameters', () => {
  const selected = image('a & b.png','output','folder / test');
  const query=new URLSearchParams(imageQuery(selected));
  assert.equal(query.get('filename'),selected.filename);
  assert.equal(query.get('subfolder'),selected.subfolder);
  assert.equal(query.get('type'),'output');
  assert.match(localResultName('..\\odd:file?.png'),/^ComfyUI-\d+-odd_file_\.png$/);
});
