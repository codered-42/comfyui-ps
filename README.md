# ComfyUI Photos

A native Photoshop panel and a ComfyUI companion extension for sending individual images between the two applications.

## Features

- **Send to Photoshop:** opens the exact image selected in ComfyUI as a new document.
- **Send to Photoshop as New Layer:** adds the image above the existing layers in Photoshop's active document. Opens a new document if none is open.
- **Receive Photoshop image:** captures Photoshop's visible canvas into the selected ComfyUI Load Image node. Each receive creates a separate input PNG, so other nodes keep their own images.
- Photoshop actions appear together at the top of ComfyUI's node context menu.
- The Photoshop panel also provides manual **Send Image** and **Get Result** buttons.

Existing Photoshop layers are preserved. Imports as layers keep their pixel size and do not resize the canvas. No workflow execution or Save Image node is required to transfer an image already displayed in ComfyUI.

## Requirements

- Photoshop 25 or later; tested with Photoshop 27.9.1 on Windows.
- ComfyUI with a frontend supporting the `getNodeMenuItems` extension hook; tested with ComfyUI 0.37.0 and frontend 1.42.10.
- Photoshop and ComfyUI must both be running. Keep the ComfyUI Photos panel visible for context-menu transfers.

The panel uses Photoshop's native UXP APIs. No separate browser bridge or runtime Node.js service is required.

## Installation

### Photoshop panel

The following manual setup was tested on Windows:

1. Enable **Developer Mode** in Photoshop under **Edit > Preferences > Plugins**.
2. Save your documents and close Photoshop.
3. Copy this project into Photoshop's `Plug-ins` directory as a folder named `comfyui-ps`. Keep `manifest.json` directly inside that folder.
4. Restart Photoshop and open **Plugins > ComfyUI Photos**.

For Photoshop 2026 installed in its default Windows location, the plugin folder is:

```text
C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\comfyui-ps\
```

The file `manifest.json` must be inside `comfyui-ps`, not inside another nested project folder.

### ComfyUI companion

1. Copy the `comfyui-extension` directory into your ComfyUI installation's `custom_nodes` directory.
2. Rename the copied directory to `comfyui-photoshop-bridge`.
3. Restart ComfyUI and refresh its browser page with **Ctrl+F5**.

The result should be:

```text
ComfyUI/
  custom_nodes/
    comfyui-photoshop-bridge/
      __init__.py
      web/
        photoshop.js
```

No additional Python packages are required beyond ComfyUI's existing dependencies.

## Use

1. Open the **ComfyUI Photos** Photoshop panel.
2. The ComfyUI address defaults to `http://127.0.0.1:8188/`. A blank field also uses this address. Enter another address only if your server is elsewhere.
3. Wait for **ComfyUI right-click menus: connected**.
4. In ComfyUI, right-click a displayed image and choose **Send to Photoshop** or **Send to Photoshop as New Layer**.
5. To send in the other direction, right-click a **Load Image** node and choose **Receive Photoshop image**.

For image batches, the clicked thumbnail or enlarged image is used. If neither is selected, the send actions offer an image-number submenu. Preview Image, Save Image, Load Image, and custom nodes exposing the normal ComfyUI image list are supported. Custom viewers without that image list may require an adapter. Videos are not transferred.

Save new Photoshop documents with **Save As** to keep them. Photoshop exports use a lossless PNG copy of the full visible canvas at its current size. For document modes that cannot be saved as PNG, convert a copy to RGB before sending.

See [the companion README](comfyui-extension/README.md) for more detail.

## Manual panel buttons

- **Send Image** exports the Photoshop canvas to ComfyUI as `photoshop-bridge.png`. Choose that file in a Load Image node. Each manual send overwrites the same file.
- **Get Result** opens a saved image from the newest of the last 50 workflow history entries containing saved images. It ignores temporary previews. If a run saves an image and another branch later fails or stops, that saved image remains usable.

For predictable manual result selection, use one Save Image output. With multiple saved outputs, Get Result uses the last image in the returned output list. Use context-menu transfers to choose a specific image.

## Development

The panel uses plain HTML, CSS, and CommonJS JavaScript. There are no runtime npm dependencies. Restart Photoshop after changing panel files. For changes to the companion's browser script, refresh ComfyUI with **Ctrl+F5**; Python changes require a ComfyUI restart.

Run the JavaScript checks with Node.js:

```sh
node --test tests/core.test.cjs tests/menus.test.cjs tests/panel-bridge.test.cjs tests/photoshop-import.test.cjs
```

Run the Python route checks using an environment with `aiohttp`, such as your ComfyUI environment:

```sh
python -B -m unittest discover -s tests -p test_bridge_routes.py
```

The checks use mocked Photoshop APIs and isolated temporary image folders. They do not execute workflows or modify open Photoshop documents.

Local settings, environment files, caches, logs, and generated image folders are excluded from Git.
