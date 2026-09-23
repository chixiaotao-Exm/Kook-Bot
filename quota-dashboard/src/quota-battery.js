const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const percent = value => value > 0 && value < .01 ? '<0.01' : value < 100 && value > 99.99 ? '>99.99'
  : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);

// A battery shows remaining quota. Only exact zero/full values use empty/full
// cells; the percentage retains precision when ten visual cells cannot.
export function quotaBattery(metric) {
  const used = valid(metric?.usedPercent) ? metric.usedPercent
    : valid(metric?.remainingPercent) && metric.remainingPercent <= 100 ? 100 - metric.remainingPercent : null;
  if (used === null) return null;
  const remaining = Math.max(0, 100 - used);
  const filled = remaining === 0 ? 0 : remaining === 100 ? 10 : Math.max(1, Math.min(9, Math.round(remaining / 10)));
  const level = remaining <= 30 ? 'low' : remaining <= 50 ? 'warning' : 'normal';
  const icon = level === 'low' ? '🪫' : '🔋';
  return { used, remaining, filled, level, usedText: percent(used), remainingText: percent(remaining),
    text: `${icon} [${'■'.repeat(filled)}${'□'.repeat(10 - filled)}]▏` };
}
