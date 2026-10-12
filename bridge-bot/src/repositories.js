/** Normalize trusted configuration once; payloads cannot add repositories. */
export function normalizeRepositories(value) {
  const values = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(values) || values.length === 0) throw new Error('Invalid repositories');
  const result = [], seen = new Set();
  for (const item of values) {
    const repository = typeof item === 'string' ? item.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
      || ['.', '..'].includes(repository.split('/')[1])) throw new Error('Invalid repository');
    const key = repository.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(repository); }
  }
  return Object.freeze(result);
}
