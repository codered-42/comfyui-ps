# ComfyUI Photos context menus

Companion to the native **ComfyUI Photos** Photoshop panel. It adds image transfer actions to existing ComfyUI nodes; no workflow nodes or Python packages need installing.

## Use

Photoshop actions appear together at the top of the node's right-click menu, above Load Image and other node actions.

1. Restart ComfyUI after installing this folder under `custom_nodes` and refresh the browser with Ctrl+F5.
2. Save your work and restart Photoshop after updating its plugin. Open **Plugins > ComfyUI Photos** and leave the panel visible. Wait for **ComfyUI right-click menus: connected**.
3. Right-click a displayed image and choose **Send to Photoshop**. It opens that exact image as a new Photoshop document. Preview Image, Save Image, Load Image, and Preview Bridge images can be sent.
4. Choose **Send to Photoshop as New Layer** to add the image above the layers in the active Photoshop document. It opens a new document if none is open. The imported layer keeps its pixel size; the existing canvas is not resized.
5. Right-click a **Load Image** node and choose **Receive Photoshop image**. The panel captures Photoshop's active document and selects a new input PNG in that specific node automatically.

Every receive creates a separate PNG snapshot. Receiving into another node does not overwrite a file already used by the first node. Save the workflow as usual to retain its chosen input filenames.

For batches, the clicked thumbnail or enlarged image is used. If neither is selected, both send actions offer an image-number submenu. No workflow execution or Save Image node is required to send an already displayed preview.

## Limits

- Photoshop and its ComfyUI Photos panel must be open. This extension works through that panel, not through Creative Cloud or a separate browser helper.
- Standard image previews and custom nodes exposing `node.imgs` are supported. Custom preview routes and blob images are copied as PNG when the browser allows reading their pixels. Nodes using a private image viewer without the normal image list need a specific adapter. Videos are not transferred.
- Receiver menus appear on nodes declaring a single-image upload input, including the standard Load Image node. Image inputs converted into sockets must be changed back to a filename widget before receiving.
- The Photoshop panel's manual **Send Image** button still updates `photoshop-bridge.png`; use the right-click receiver action for independent node inputs.
- Pending actions expire, and errors appear in ComfyUI. A workflow is never queued by these menu actions.

## Implementation

The extension uses ComfyUI's official [getNodeMenuItems hook](https://github.com/Comfy-Org/ComfyUI_frontend/blob/v1.42.10/src/types/comfy.ts) and registers local HTTP routes in its existing server. The Photoshop panel checks for requests while visible. It downloads a chosen image, or uploads a unique PNG snapshot and returns its filename to the requesting node. There are no additional dependencies or helper processes.
