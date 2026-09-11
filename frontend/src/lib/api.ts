export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401 && !path.includes('/auth/')) {
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}
