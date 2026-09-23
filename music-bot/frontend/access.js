/** Keep access capabilities out of page URLs, storage, and share links. */
export function takeAccessToken() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('admin') || params.get('invite');
  if (token) history.replaceState(null, '', location.pathname + location.search);
  return token || null;
}
