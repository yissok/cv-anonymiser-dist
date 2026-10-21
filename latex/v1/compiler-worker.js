// Only static compiler assets are cached. CV source and PDFs stay in memory.
const CACHE = 'cv-anonymiser-latex-v1-r2';

async function asset(name) {
  const url = new URL(name, self.__cvAssetBase || self.location.href).href;
  let cache;
  try {
    cache = await caches.open(CACHE);
    const saved = await cache.match(url);
    if (saved) return saved.arrayBuffer();
  } catch { /* Compilation also works when persistent caching is unavailable. */ }
  let response;
  try { response = await fetch(url, { credentials: 'omit' }); }
  catch { throw new Error(`Could not download ${name}. Check your connection and try again.`); }
  if (!response.ok) throw new Error(`Could not download ${name}. Check your connection and try again.`);
  if (cache) {
    try { await cache.put(url, response.clone()); } catch { /* Storage may be full. */ }
  }
  return response.arrayBuffer();
}

async function start() {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot load the PDF compiler. Please use a current browser.');
  self.postMessage({ type: 'progress', message: 'Loading compiler and fonts (first use downloads the bundle)…' });
  const [wasm, packed, loader] = await Promise.all([
    asset('swiftlatexpdftex.wasm'), asset('tex-files.bin'), asset('swiftlatexpdftex.js'),
  ]);
  self.postMessage({ type: 'progress', message: 'Preparing compiler and fonts…' });
  const unpacked = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const bytes = new Uint8Array(unpacked);
  const manifestLength = new DataView(unpacked).getUint32(0, true);
  const start = 4 + manifestLength;
  if (start > bytes.length) throw new Error('The compiler bundle is damaged.');
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(4, start)));
  self.__cvTexFiles = Object.create(null);
  for (const [key, offset, length] of manifest) {
    if (!/^(3|10|11|26|32|33|44)\/[^/]+$/.test(key) || offset < 0 || length < 0 || start + offset + length > bytes.length) throw new Error('The compiler bundle is damaged.');
    self.__cvTexFiles[key] = bytes.subarray(start + offset, start + offset + length);
  }
  self.__cvWasm = new Uint8Array(wasm);
  const url = URL.createObjectURL(new Blob([loader], { type: 'text/javascript' }));
  try { importScripts(url); } finally { URL.revokeObjectURL(url); }
}

start().catch((error) => self.postMessage({ type: 'error', message: error.message || 'The PDF compiler could not load.' }));
