"use strict";
const INPUT_FILENAME = "photoshop-bridge.png";

function normalizeServer(value) {
  let base = String(value || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Enter your ComfyUI address first.");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(base)) base = "http://" + base;
  const match = /^(https?):\/\/(\[[a-f\d:]+\]|[a-z\d._-]+)(?::(\d+))?(\/[^\s?#]*)?$/i.exec(base);
  if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) {
    throw new Error("Use a ComfyUI address such as http://127.0.0.1:8188, without a workflow link, query, or #fragment.");
  }
  return match[1].toLowerCase() + "://" + match[2].toLowerCase() + (match[3] ? ":" + match[3] : "") + (match[4] || "");
}

function asciiBytes(text) {
  const data = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i);
  return data;
}

// Explicit binary multipart avoids differences between browser and UXP FormData.
function makeUpload(png, filename = INPUT_FILENAME) {
  if (!/^[a-z\d_.-]+\.png$/i.test(filename)) throw new Error("Invalid PNG upload filename.");
  const bytes = png instanceof Uint8Array ? png : new Uint8Array(png);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error("Photoshop did not produce a valid PNG image.");
  }
  const boundary = "ComfyPhotos" + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const header = asciiBytes(
    "--" + boundary + "\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ninput\r\n" +
    "--" + boundary + "\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n" +
    "--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"" + filename + "\"\r\nContent-Type: image/png\r\n\r\n"
  );
  const footer = asciiBytes("\r\n--" + boundary + "--\r\n");
  const body = new Uint8Array(header.length + bytes.length + footer.length);
  body.set(header);
  body.set(bytes, header.length);
  body.set(footer, header.length + bytes.length);
  return {body: body.buffer, contentType: "multipart/form-data; boundary=" + boundary};
}

function latestImage(history) {
  const jobs = Object.entries(history || {}).map(([id, job], index) => ({id, job, index}));
  jobs.sort((a, b) => {
    const aq = Number(a.job.prompt && a.job.prompt[0]);
    const bq = Number(b.job.prompt && b.job.prompt[0]);
    return (Number.isFinite(bq) ? bq : b.index) - (Number.isFinite(aq) ? aq : a.index);
  });
  for (const {id, job} of jobs) {
    const saved = [];
    const status = job.status || {};
    const workflowIncomplete = status.completed === false || Boolean(status.status_str && status.status_str !== "success");
    for (const [nodeId, output] of Object.entries(job.outputs || {})) {
      for (const image of (output && Array.isArray(output.images) ? output.images : [])) {
        // A written output is usable even if another workflow branch later fails or is stopped.
        // Never guess among temporary previews, masks, or input images.
        if (!image || image.type !== "output" || typeof image.filename !== "string" || !/\.(png|jpe?g|webp|tiff?)$/i.test(image.filename)) continue;
        if (/^[\\/]|^[a-z]:/i.test(image.filename) || image.filename.split(/[\\/]/).includes("..")) continue;
        saved.push({...image, subfolder: image.subfolder || "", promptId: id, nodeId, workflowIncomplete});
      }
    }
    if (saved.length) return saved[saved.length - 1];
  }
  throw new Error("No saved image found in recent ComfyUI runs. Connect Save Image to the image you want and run that branch, then click Get Result.");
}

function imageQuery(image) {
  return ["filename", "subfolder", "type"].map(key => key + "=" + encodeURIComponent(image[key] || "")).join("&");
}

function localResultName(filename) {
  const name = String(filename).split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, "_");
  return "ComfyUI-" + Date.now() + "-" + name.slice(-140);
}

module.exports = {INPUT_FILENAME, normalizeServer, makeUpload, latestImage, imageQuery, localResultName};