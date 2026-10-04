// Server build: talk to the Express API. The prototype build swaps this file for an in-browser SQLite backend.
window.DermAPI = async function (method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
};
window.DermAPI.ready = Promise.resolve();
