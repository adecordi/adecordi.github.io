// Worker che codifica in PNG le pagine da stampare, fuori dal thread principale.
self.onmessage = async (e) => {
  const { id, bitmap } = e.data;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);
    self.postMessage({ id, blob: await canvas.convertToBlob({ type: "image/png" }) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
