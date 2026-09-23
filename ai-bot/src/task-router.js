const REPOSITORY = 'chixiaotao-Exm/Kook-Bot';

export function codeTaskIntent(text) {
  if (typeof text !== 'string') return { requested: false, allowed: false };
  const urls = [...text.matchAll(/https?:\/\/github\.com\/([^\s/#?()[\]<>]+)\/([^\s/#?()[\]<>]+)/gi)];
  if (urls.length) return { requested: true, allowed: urls.every(match =>
    `${match[1]}/${match[2].replace(/\.git$/i, '')}`.toLowerCase() === REPOSITORY.toLowerCase()) };
  const requested = /^\s*代码任务[：:\s]/u.test(text)
    || /(?:检查|审查|修复|修改|重构|读取|阅读|读|分析|扫描|测试|实现|优化).{0,24}(?:Kook-Bot|本项目|这个项目|这个仓库|项目源码|项目代码)/iu.test(text)
    || /(?:Kook-Bot|本项目|这个仓库|项目源码).{0,24}(?:检查|审查|修复|修改|重构|测试)/iu.test(text);
  return { requested, allowed: requested };
}

export class TaskRouter {
  constructor({ discussion, code = null, isReady = () => true, operatorIds = new Set() }) {
    this.discussion = discussion; this.code = code; this.isReady = isReady;
    this.operators = new Set(operatorIds); this.lastMode = 'discussion';
  }
  mode() {
    if (this.code?.snapshot().active) return 'code';
    if (this.discussion.snapshot().active) return 'discussion';
    return this.lastMode;
  }
  snapshot() { const mode = this.mode(); return { ...(mode === 'code' && this.code ? this.code.snapshot() : this.discussion.snapshot()), mode }; }
  async start(options) {
    if (!this.isReady()) return { accepted: false, reason: 'NOT_READY' };
    const intent = codeTaskIntent(options.topic);
    if (!intent.requested) {
      if (this.code?.snapshot().active) return { accepted: false, reason: 'BUSY' };
      this.lastMode = 'discussion'; return this.discussion.start(options);
    }
    if (!intent.allowed) return { accepted: false, reason: 'REPOSITORY_NOT_ALLOWED' };
    if (!this.code) return { accepted: false, reason: 'CODE_DISABLED' };
    if (!this.operators.has(options.userId)) return { accepted: false, reason: 'NOT_AUTHORIZED' };
    if (this.discussion.snapshot().active) await this.discussion.stop();
    this.lastMode = 'code'; return { ...await this.code.start(options), mode: 'code', taskStarted: true };
  }
  async contribute(options) {
    if (this.code?.snapshot().active) return { ...await this.code.contribute(options), mode: 'code' };
    const intent = codeTaskIntent(options.text);
    if (intent.requested) return this.start({ ...options, topic: options.text });
    return this.discussion.contribute(options);
  }
  async pause(options) {
    if (this.mode() === 'code' && this.code) return { ...await this.code.pause(options), mode: 'code' };
    return this.discussion.pause(options);
  }
  async resume(options) {
    if (this.mode() === 'code' && this.code) return { ...await this.code.resume(options), mode: 'code' };
    return this.discussion.resume(options);
  }
  async stop(options) {
    if (this.mode() === 'code' && this.code) return { ...await this.code.stop(options), mode: 'code' };
    return this.discussion.stop(options);
  }
}
