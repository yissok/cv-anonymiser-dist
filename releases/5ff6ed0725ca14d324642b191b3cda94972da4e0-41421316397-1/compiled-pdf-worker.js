// No PDF is uploaded or persisted. Read bytes from the tab that compiled them,
// so worker suspension cannot discard an open preview's document.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type === 'compiled-pdf-owner') event.ports[0]?.postMessage(event.source.id);
});
self.addEventListener('fetch', (event) => {
  const root = new URL('compiled-pdfs/', self.location.href);
  const url = new URL(event.request.url);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return;
  event.respondWith((async () => {
    const [owner, id] = url.pathname.slice(root.pathname.length).split('/');
    const client = owner && await self.clients.get(owner);
    if (!client || !id) return unavailable();
    const document = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); resolve(null); }, 5000);
      channel.port1.onmessage = (message) => { clearTimeout(timeout); channel.port1.close(); resolve(message.data); };
      client.postMessage({ type: 'read-compiled-pdf', id }, [channel.port2]);
    });
    if (!document?.blob || typeof document.filename !== 'string') return unavailable();
    const encoded = encodeURIComponent(document.filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const fallback = document.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return new Response(event.request.method === 'HEAD' ? null : document.blob, { headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(document.blob.size),
      'Content-Disposition': `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  })());
});
function unavailable() {
  return new Response('This PDF preview is no longer available. Compile the document again in the app.', { status: 410, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain;charset=utf-8' } });
}
