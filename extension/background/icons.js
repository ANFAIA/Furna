/**
 * Rasterizes `icons/furna.svg` to the four toolbar-icon sizes at runtime and
 * hands them to `chrome.action.setIcon`, instead of shipping pre-made PNGs.
 *
 * No image-generation tool is available in the environment this was built in
 * and no ready-made PNGs existed to draw on — `furna.svg` did. A service
 * worker has `OffscreenCanvas` and `createImageBitmap` (both spec'd for
 * exactly this kind of off-DOM rendering work), so the existing asset
 * becomes real icons with no new binary files and no hand-rolled PNG encoder.
 * A manifest-declared static `default_icon` remains the more conventional
 * choice and is a reasonable follow-up; this unblocks a fully-scripted,
 * buildless V1 in the meantime.
 */

const SIZES = [16, 32, 48, 128];

export async function setActionIcon() {
  const svgUrl = chrome.runtime.getURL("icons/furna.svg");
  const svgText = await (await fetch(svgUrl)).text();
  const blob = new Blob([svgText], { type: "image/svg+xml" });

  const imageData = {};
  for (const size of SIZES) {
    // `createImageBitmap`'s resize options rasterize directly at the target
    // size — no manual canvas scaling step needed.
    const bitmap = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size });
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    imageData[size] = ctx.getImageData(0, 0, size, size);
    bitmap.close();
  }

  await chrome.action.setIcon({ imageData });
}
