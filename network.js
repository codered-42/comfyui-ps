"use strict";

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || "GET", url);
    xhr.responseType = options.binary ? "arraybuffer" : "text";
    xhr.timeout = options.timeout || 60000;
    for (const [key, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(key, value);
    xhr.onerror = () => reject(new Error("Cannot reach ComfyUI. Check that it is running and the address is correct."));
    xhr.ontimeout = () => reject(new Error("ComfyUI did not respond within 60 seconds. Check the server and try again."));
    xhr.onabort = () => reject(new Error("The image transfer was cancelled."));
    xhr.onload = () => {
      const status = Number(xhr.status);
      if (status < 200 || status >= 300) {
        const error = new Error(status === 413 ? "This image exceeds ComfyUI's upload size limit." : "ComfyUI returned HTTP " + status + ". Check the server address and its console.");
        error.status = status;
        reject(error);
        return;
      }
      if (options.binary) {
        if (!xhr.response || !xhr.response.byteLength) reject(new Error("ComfyUI returned an empty image."));
        else resolve(xhr.response);
        return;
      }
      try { resolve(JSON.parse(xhr.responseText)); }
      catch (_) { reject(new Error("The server did not return ComfyUI data. Check its address.")); }
    };
    xhr.send(options.body || null);
  });
}

module.exports = {request};