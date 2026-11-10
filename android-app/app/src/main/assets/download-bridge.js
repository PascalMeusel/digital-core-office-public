(function installDcoDownloads() {
  if (window.DcoNativeDownloads || !window.DigitalCoreOfficeDownloads) return;
  const bridge = window.DigitalCoreOfficeDownloads;
  const pending = new Map();
  const maximum = 20 * 1024 * 1024;
  let busy = false;
  bridge.onmessage = event => {
    try {
      const result = JSON.parse(event.data);
      const callback = pending.get(result.requestId);
      if (!callback) return;
      pending.delete(result.requestId);
      clearTimeout(callback.timer);
      result.error ? callback.reject(new Error(result.error)) : callback.resolve(result.value);
    } catch (_) {}
  };
  function request(action, payload) {
    return new Promise((resolve, reject) => {
      const random = new Uint32Array(4); crypto.getRandomValues(random);
      const requestId = 'download-' + Array.from(random, value => value.toString(16)).join('-');
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Export timed out. Please try again.')); }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      bridge.postMessage(JSON.stringify({ action, requestId, ...payload }));
    });
  }
  function chunkBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }
  async function capture(url, name, mime) {
    if (busy) { alert('An export is already in progress.'); return; }
    if (!url.startsWith('blob:') && !url.startsWith('data:')) return;
    busy = true;
    let exportId;
    try {
      if (url.startsWith('data:') && url.length > maximum * 1.4 + 4096) throw new Error('This export exceeds 20 MB. Download it in a desktop browser.');
      // Fetch immediately, while the originating page still owns the blob URL.
      const response = await fetch(url);
      const blob = await response.blob();
      if (blob.size > maximum) throw new Error('This export exceeds 20 MB. Download it in a desktop browser.');
      const type = mime || blob.type || 'application/octet-stream';
      const extension = type.includes('csv') ? '.csv' : type.includes('calendar') ? '.ics' : type.includes('json') ? '.json' : type.includes('pdf') ? '.pdf' : '.bin';
      exportId = await request('startExport', { name: name || 'digital-core-office-export' + extension, mime: type, size: blob.size });
      let sequence = 0;
      for (let offset = 0; offset < blob.size; offset += 192 * 1024) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + 192 * 1024).arrayBuffer());
        await request('appendExport', { exportId, sequence: sequence++, chunk: chunkBase64(bytes) });
      }
      await request('finishExport', { exportId });
    } catch (error) {
      if (exportId) request('cancelExport', { exportId }).catch(() => {});
      alert(error instanceof Error ? error.message : 'Export failed. Please try again.');
    } finally { busy = false; }
  }
  window.DcoNativeDownloads = { capture };
  document.addEventListener('click', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || (!anchor.href.startsWith('blob:') && !anchor.href.startsWith('data:'))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void capture(anchor.href, anchor.download || '', '');
  }, true);
})();
