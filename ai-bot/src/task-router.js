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
  constructor({ discussion, code = null, thread = null, isReady = () => true, operatorIds = new Set() }) {
    this.discussion = discussion; this.code = code; this.isReady = isReady;
    this.thread = thread;
    this.operators = new Set(operatorIds); this.lastMode = 'discussion';
  }
  mode() {
    if (this.code?.snapshot().active) return 'code';
    if (this.discussion.snapshot().active) return 'discussion';
    return this.thread?.context()?.mode || this.lastMode;
  }
  snapshot() { const mode = this.mode(); return { ...(mode === 'code' && this.code ? this.code.snapshot() : this.discussion.snapshot()), mode,
    threadId: this.thread?.snapshot().threadId || null, anchorMessageId: this.thread?.snapshot().anchorMessageId || null }; }
  contextOptions(options, context) {
    if (!context) return options;
    const history = context.messages.map(item => ({ ...item }));
    const original = { role: 'user', content: `本话题最初的问题：${context.topic}` };
    while (history.length >= 16 || history.reduce((size, item) => size + item.content.length, original.content.length) > 24000) history.shift();
    history.unshift(original);
    return { ...options, threadId: context.id, threadContext: history, replyMessageId: context.anchorMessageId };
  }
  async start(options) {
    if (!this.isReady()) return { accepted: false, reason: 'NOT_READY' };
    const intent = codeTaskIntent(options.topic);
    if (intent.requested && !intent.allowed) return { accepted: false, reason: 'REPOSITORY_NOT_ALLOWED' };
    const codeMode = intent.requested || this.thread?.context()?.mode === 'code';
    if (!codeMode) {
      if (this.code?.snapshot().active) return { accepted: false, reason: 'BUSY' };
      if (this.discussion.snapshot().active) return { accepted: false, reason: 'BUSY' };
      const context = await this.thread?.accept({ text: options.topic, receiptId: options.receiptId, replyMessageId: options.replyMessageId, mode: 'discussion' });
      this.lastMode = 'discussion'; return this.discussion.start(this.contextOptions({ ...options, topic: context?.topic || options.topic }, context));
    }
    if (!this.code) return { accepted: false, reason: 'CODE_DISABLED' };
    if (!this.operators.has(options.userId)) return { accepted: false, reason: 'NOT_AUTHORIZED' };
    if (this.code.snapshot().active) return { accepted: false, reason: 'BUSY' };
    if (this.discussion.snapshot().active) await this.discussion.stop();
    await this.thread?.accept({ text: options.topic, receiptId: options.receiptId, replyMessageId: options.replyMessageId, mode: 'code' });
    const context = await this.thread?.setMode('code');
    this.lastMode = 'code'; return { ...await this.code.start(this.contextOptions(options, context)), mode: 'code', taskStarted: true };
  }
  async contribute(options) {
    if (this.code?.snapshot().active) {
      if (!this.operators.has(options.userId)) return { accepted: false, reason: 'NOT_AUTHORIZED' };
      const result = await this.code.contribute(this.contextOptions(options, this.thread?.context()));
      if (result.accepted) await this.thread?.accept({ text: options.text, receiptId: options.receiptId, replyMessageId: options.replyMessageId });
      return { ...result, mode: 'code' };
    }
    const intent = codeTaskIntent(options.text);
    if (intent.requested) return this.start({ ...options, topic: options.text });
    const result = await this.discussion.contribute(this.contextOptions(options, this.thread?.context()));
    if (result.accepted) await this.thread?.accept({ text: options.text, receiptId: options.receiptId, replyMessageId: options.replyMessageId });
    return result;
  }
  async pause(options) {
    if (this.mode() === 'code' && this.code) return { ...await this.code.pause(options), mode: 'code' };
    return this.discussion.pause(options);
  }
  async resume(options) {
    if (!this.code?.snapshot().active && !this.discussion.snapshot().active && this.thread?.context()) {
      if (!options?.receiptId) return { resumed: false, reason: 'NOT_READY' };
      const result = await this.start({ ...options, topic: '继续当前话题，结合前面的要求和结果推进。' });
      return result.accepted ? { resumed: true, mode: result.mode || this.mode() } : { resumed: false, reason: result.reason };
    }
    if (this.mode() === 'code' && this.code) return { ...await this.code.resume(options), mode: 'code' };
    return this.discussion.resume(options);
  }
  async stop(options) {
    if (this.mode() === 'code' && this.code) return { ...await this.code.stop(options), mode: 'code' };
    return this.discussion.stop(options);
  }
  async newTopic(options) {
    if (this.mode() === 'code' && this.code && !this.operators.has(options.userId)) return { accepted: false, reason: 'NOT_AUTHORIZED' };
    if (this.code?.snapshot().active) {
      const result = await this.code.stop(options);
      if (result.reason === 'NOT_AUTHORIZED') return { accepted: false, reason: result.reason };
      const deadline = Date.now() + 3000;
      while (this.code.snapshot().active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (this.code.snapshot().active) return { accepted: false, reason: 'BUSY' };
    }
    if (this.discussion.snapshot().active) await this.discussion.stop();
    if (!this.thread) return { accepted: false, reason: 'NOT_READY' };
    await this.thread.reset(); this.lastMode = 'discussion';
    if (options.topic) return { ...await this.start(options), newTopic: true };
    return { accepted: true, newTopic: true, cleared: true };
  }
}
