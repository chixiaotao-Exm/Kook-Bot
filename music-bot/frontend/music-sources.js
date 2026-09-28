export const sourceNames = Object.freeze({ netease: '网易云音乐', qq: 'QQ音乐', qishui: '汽水音乐' });
export const sourceIds = Object.freeze(Object.keys(sourceNames));
export const normalizeSource = (source) => sourceIds.includes(source) ? source : 'netease';
export const sourceName = (source) => sourceNames[normalizeSource(source)];
export const defaultSources = () => sourceIds.map((id) => ({ id, name: sourceNames[id], enabled: id !== 'qishui' }));

// A missing optional bridge must stay disabled until the server advertises it.
export function sourceDescriptors(values) {
  return sourceIds.map((id) => {
    const item = Array.isArray(values) ? values.find((value) => value?.id === id) : null;
    return { id, name: sourceNames[id], enabled: item?.enabled === true, capabilities: item?.capabilities || {} };
  });
}

export function sourceSupports(sources, id, capability) {
  const source = sources.find((item) => item.id === id);
  if (!source?.enabled) return false;
  if (source.capabilities?.[capability] !== undefined) return source.capabilities[capability] === true;
  return !(id === 'qishui' && ['login', 'heart', 'mine'].includes(capability));
}
