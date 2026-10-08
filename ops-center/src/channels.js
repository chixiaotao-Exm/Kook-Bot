const ID = /^\d{5,30}$/;
const CATEGORIES = ['infra', 'web'];

/** Capture configured destinations once; messages cannot override them. */
export function configuredChannels(value, { required = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== CATEGORIES.length
    || CATEGORIES.some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'string')) {
    throw Error('Invalid KOOK channel configuration');
  }
  const channels = Object.fromEntries(CATEGORIES.map(key => [key, value[key].trim()]));
  if (!required && CATEGORIES.every(key => channels[key] === '')) return Object.freeze(channels);
  if (CATEGORIES.some(key => !ID.test(channels[key])) || channels.infra === channels.web) {
    throw Error('Invalid KOOK channel configuration');
  }
  return Object.freeze(channels);
}
