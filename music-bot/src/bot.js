import { duration, label, log, UserError } from './util.js';

const aliases = {
  '帮助': 'help', help: 'help', '搜索': 'search', search: 'search',
  '点歌': 'play', '播放': 'play', play: 'play', '选歌': 'pick', pick: 'pick',
  '歌单': 'playlist', playlist: 'playlist', '队列': 'queue', queue: 'queue',
  '当前': 'now', now: 'now', '暂停': 'pause', pause: 'pause',
  '继续': 'resume', resume: 'resume', '切歌': 'skip', '下一首': 'skip', skip: 'skip',
  '上一首': 'previous', previous: 'previous', prev: 'previous',
  '停止': 'stop', stop: 'stop', '离开': 'stop', leave: 'stop',
  '音量': 'volume', volume: 'volume', '循环': 'loop', loop: 'loop',
  '移除': 'remove', remove: 'remove', '清空': 'clear', clear: 'clear',
  '心动': 'heart', heart: 'heart', '热歌': 'hot', hot: 'hot', '常驻': 'stay',
  '规则': 'rules', rules: 'rules', '投票切歌': 'vote', vote: 'vote',
};

export function parseCommand(content, prefix = '/') {
  const text = String(content || '').trim();
  if (!text.startsWith(prefix)) return null;
  const [name, ...rest] = text.slice(prefix.length).split(/\s+/);
  const action = aliases[name.toLowerCase()];
  return action ? { action, value: rest.join(' ').trim() } : null;
}

function humanMetadata(event) {
  const author = event?.extra?.author;
  if (author?.id !== undefined && author.id !== event.author_id) return false;
  if (author?.bot !== undefined) return author.bot === false;
  return null;
}

export class Bot {
  constructor(config, api, music, player, route = null) {
    Object.assign(this, { config, api, music, player, route });
    this.seen = new Map(); this.cooldowns = new Map(); this.searches = new Map();
    this.inbox = []; this.running = false; this.closed = false;
  }
  accept(event) {
    if (this.closed) return true;
    if (event?.channel_type !== 'GROUP' || ![1, 9].includes(event.type) || humanMetadata(event) === false ||
        event.author_id === this.selfId || !this.config.guilds.has(event.extra?.guild_id) ||
        (this.config.textChannels.size && !this.config.textChannels.has(event.target_id))) return true;
    const command = parseCommand(event.extra?.kmarkdown?.raw_content || event.content, this.config.prefix);
    if (!command || !event.msg_id || !event.author_id) return true;
    if (this.seen.has(event.msg_id)) return true;
    const now = Date.now();
    if (event.msg_timestamp && now - event.msg_timestamp > 300000) return true;
    for (const [key, time] of this.seen) if (now - time > 600000) this.seen.delete(key);
    for (const [key, time] of this.cooldowns) if (now - time > this.config.cooldownMs) this.cooldowns.delete(key);
    for (const [key, entry] of this.searches) if (now - entry.time > 300000) this.searches.delete(key);
    if (this.cooldowns.has(event.author_id)) return true;
    if (this.inbox.length >= 100) return false;
    this.cooldowns.set(event.author_id, now); this.seen.set(event.msg_id, now);
    this.inbox.push({ event, command, expectedEpoch: this.player.operationEpoch, expectedTrackEpoch: this.player.trackEpoch,
      expectedContext: this.player.context ? { ...this.player.context } : null }); void this.drain(); return true;
  }
  drain() {
    if (this.running) return this.draining;
    this.running = true;
    this.draining = this.runInbox();
    return this.draining;
  }
  async humanAuthor(event) {
    const known = humanMetadata(event);
    if (known !== null) return known;
    try {
      const author = await this.api.request('user/view', { user_id: event.author_id, guild_id: event.extra.guild_id });
      return author?.id === event.author_id && author.bot === false;
    } catch {
      log('author_identity_failed'); return false;
    }
  }
  async runInbox() {
    try {
      while (!this.closed && this.inbox.length) {
        const { event, command, expectedEpoch, expectedTrackEpoch, expectedContext } = this.inbox.shift();
        // Keep gateway admission synchronous. Unknown authors are resolved here
        // before routing, replies, provider work or playback side effects.
        if (!await this.humanAuthor(event) || this.closed) continue;
        try { await this.handle(event, command, { expectedEpoch, expectedTrackEpoch, expectedContext }); }
        catch (error) {
          log('command_failed', { action: command.action });
          try { await this.api.reply(event.target_id, error instanceof UserError ? error.message : '操作失败，请查看服务器日志或运行诊断。', event.msg_id); }
          catch { log('reply_failed'); }
        }
      }
    } finally { this.running = false; }
  }
  async voiceContext(event, allowAdmin = false) {
    const active = this.player.context;
    if (active && active.guildId !== event.extra.guild_id) throw new UserError('机器人正在另一个服务器的语音频道使用中。');
    if (allowAdmin && active && (this.config.admins.has(event.author_id) || this.player.features?.isManager(event.author_id))) return active;
    const joined = await this.api.request('channel-user/get-joined-channel', { guild_id: event.extra.guild_id, user_id: event.author_id });
    const channel = joined.items?.find((item) => item.type === 2);
    if (!channel) throw new UserError('请先进入一个语音频道，再发送播放指令。');
    if (active && active.voiceChannelId !== channel.id) throw new UserError('请进入机器人所在的语音频道后再操作。');
    return { guildId: event.extra.guild_id, voiceChannelId: channel.id, textChannelId: event.target_id };
  }
  help() {
    const p = this.config.prefix;
    return [
      '双平台音乐机器人', `${p}搜索 歌名/歌手  |  ${p}选歌 序号`,
      `${p}点歌 歌名/歌曲ID/完整链接`, `${p}歌单 歌单ID/完整链接`,
      `${p}队列 [页码]  |  ${p}当前`, `${p}暂停  |  ${p}继续  |  ${p}上一首  |  ${p}下一首`,
      `${p}音量 0-100  |  ${p}循环 关闭/单曲/队列`,
      `${p}移除 队列序号  |  ${p}清空  |  ${p}停止`,
      `${p}心动 [歌单ID]  |  ${p}热歌  |  ${p}常驻 开/关`,
      `${p}投票切歌  |  ${p}规则（开启房间规则时生效）`,
      '请先进入语音频道。搜索结果保留 5 分钟；试听或无权限歌曲会跳过。',
    ].join('\n');
  }
  async handle(event, { action, value }, { expectedEpoch = this.player.operationEpoch,
    expectedTrackEpoch = this.player.trackEpoch, expectedContext = this.player.context ? { ...this.player.context } : null } = {}) {
    // A web control can invalidate this command while routing, voice lookup,
    // or a provider request is still pending.
    if (this.route && !await this.route(event, { action, value })) return;
    const reply = (text) => this.api.reply(event.target_id, text, event.msg_id);
    const authorName = String(event.extra?.author?.nickname || event.extra?.author?.username || 'KOOK 成员').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 60);
    const cacheKey = `${event.extra.guild_id}:${event.target_id}:${event.author_id}`;
    if (action === 'help') return reply(this.help());
    if (action === 'rules') return reply(this.player.features?.rulesText() || '本房间暂未开启多人点歌规则。');
    this.player.features?.authorize(action, event.author_id);
    if (action === 'search') {
      if (!value) throw new UserError('请输入要搜索的歌名或歌手。');
      const tracks = await this.music.search(value);
      if (!tracks.length) return reply('没有搜索到歌曲。');
      this.searches.set(cacheKey, { tracks, time: Date.now() });
      return reply(tracks.map((t, i) => `${i + 1}. ${label(t)} (${duration(t.durationMs)})`).join('\n') + `\n发送 ${this.config.prefix}选歌 序号 加入队列。`);
    }
    if (['queue', 'now'].includes(action)) {
      if (this.player.context && this.player.context.guildId !== event.extra.guild_id) return reply('本服务器没有播放队列。');
      const snapshot = this.player.snapshot(); const current = snapshot.current;
      const status = { paused: '已暂停', playing: '正在播放', recovering: '正在恢复', ready: '等待播放', idle: '空闲' }[snapshot.status];
      const heading = current ? `${status}：${label(current)}\n进度：${duration(snapshot.seconds * 1000)} / ${duration(current.durationMs)}` : '当前没有正在播放的歌曲。';
      if (action === 'now') return reply(`${heading}\n音量：${this.player.volume}%`);
      const page = value ? Number(value) : 1;
      const pages = Math.max(1, Math.ceil(this.player.queue.length / 10));
      if (!Number.isInteger(page) || page < 1 || page > pages) throw new UserError(`页码范围为 1-${pages}。`);
      return reply(heading + `\n待播队列（${page}/${pages}）：\n` +
        (this.player.queue.slice((page - 1) * 10, page * 10).map((t, i) => `${(page - 1) * 10 + i + 1}. ${label(t)}`).join('\n') || '空'));
    }
    if (['play', 'pick', 'playlist', 'heart', 'hot'].includes(action)) {
      if (!value && !['heart', 'hot'].includes(action)) throw new UserError('请提供歌名、ID、完整链接或选歌序号。');
      const context = await this.voiceContext(event);
      let tracks;
      if (['heart', 'hot'].includes(action)) {
        if (this.player.capacity() < 1) throw new UserError('播放队列已满。');
        const limit = Math.min(30, this.player.capacity());
        const seed = (this.player.current?.source ?? 'netease') === 'netease' ? this.player.current?.id : undefined;
        const result = action === 'heart' ? await this.music.heart({ playlistId: value || undefined, songId: seed, limit }) : await this.music.hot(limit);
        tracks = result.tracks;
        if (result.notice) await reply(result.notice);
      } else if (action === 'pick') {
        const entry = this.searches.get(cacheKey); const index = Number(value);
        if (!entry || Date.now() - entry.time > 300000 || !Number.isInteger(index) || index < 1 || index > entry.tracks.length) {
          throw new UserError('搜索结果已过期或序号无效，请重新搜索。');
        }
        tracks = [entry.tracks[index - 1]];
      } else if (action === 'playlist') {
        const capacity = this.player.capacity();
        if (capacity < 1) throw new UserError('队列已满。');
        const parsed = this.music.parseInput ? await this.music.parseInput(value, { source: 'netease', kind: 'playlist' }) : null;
        if (parsed?.kind === 'song') throw new UserError('这是歌曲链接，请使用点歌指令。');
        tracks = await this.music.playlist(parsed?.id || value, capacity, parsed?.source || 'netease');
      } else {
        const parsed = this.music.parseInput ? await this.music.parseInput(value, { source: 'netease', kind: 'song' }) : null;
        if (parsed?.kind === 'playlist') tracks = await this.music.playlist(parsed.id, this.player.capacity(), parsed.source);
        else tracks = [await this.music.resolve(parsed?.id || value, parsed?.source || 'netease')];
      }
      tracks = tracks.map((t) => ({ ...t, requestedBy: event.author_id, requestedByName: authorName }));
      const added = await this.player.add(context, tracks, { expectedEpoch, authorize: () => {
        this.player.features?.authorize(action, event.author_id);
        return { policy: this.player.features?.policy(event.author_id) };
      } });
      return reply(tracks.length === 1 ? `已处理点歌：${label(tracks[0])}` : `已导入 ${added} 首；已按队列容量、每人上限及去重规则筛选。`);
    }
    const controlContext = await this.voiceContext(event, true);
    if (action === 'vote' || action === 'skip' && this.player.features?.rules.enabled && !this.player.features.isManager(event.author_id)) {
      const staleContext = [expectedContext, controlContext].filter(Boolean).some(context =>
        this.player.context?.guildId !== context.guildId || this.player.context?.voiceChannelId !== context.voiceChannelId);
      if (expectedEpoch !== undefined && expectedEpoch !== this.player.operationEpoch
        || expectedTrackEpoch !== undefined && expectedTrackEpoch !== this.player.trackEpoch || staleContext) {
        throw new UserError('歌曲或频道已变化，请为当前歌曲重新投票。');
      }
      const context = expectedContext || controlContext;
      return reply(await this.player.features.vote(event.author_id, { expectedEpoch, expectedTrackEpoch,
        expectedVoiceChannelId: context.voiceChannelId, expectedGuildId: context.guildId }));
    }
    let argument = value;
    if (action === 'stay') {
      if (!['开', '关', 'on', 'off'].includes(value)) throw new UserError('请使用 常驻 开 或 常驻 关。');
      argument = ['开', 'on'].includes(value);
    }
    if (action === 'volume') {
      if (!/^\d{1,3}$/.test(value) || Number(value) > 100) throw new UserError('音量必须是 0-100 的整数。');
      argument = Number(value);
    }
    if (action === 'remove') {
      if (!/^[1-9]\d*$/.test(value)) throw new UserError('请输入有效的队列序号。');
      argument = Number(value);
    }
    if (action === 'loop') {
      argument = { '关闭': 'off', '单曲': 'one', '队列': 'all', off: 'off', one: 'one', all: 'all' }[value];
      if (!argument) throw new UserError('循环模式请选择：关闭、单曲或队列。');
    }
    if (expectedEpoch !== undefined && expectedEpoch !== this.player.operationEpoch) {
      throw new UserError('播放状态已变化，请重新发送指令。');
    }
    const interrupts = ['stop', 'pause', 'resume', 'skip', 'previous', 'clear', 'seek'].includes(action);
    // Player increments manual interruptions before acquiring its lock. Match
    // that generation, and also reject external changes while waiting for it.
    const controlEpoch = expectedEpoch === undefined ? undefined : expectedEpoch + (interrupts ? 1 : 0);
    const result = await this.player.control(action, argument, { actorName: authorName, expectedEpoch: controlEpoch,
      expectedVoiceChannelId: this.player.context ? controlContext.voiceChannelId : undefined,
      authorize: () => {
        if (this.player.context && (this.player.context.guildId !== controlContext.guildId
          || this.player.context.voiceChannelId !== controlContext.voiceChannelId)) {
          throw new UserError('机器人频道已变化，请重新发送指令。');
        }
        this.player.features?.authorize(action, event.author_id);
        // A manager can be revoked while this operation waits for the player
        // lock; do not turn that queued direct skip into an unvoted skip.
        if (action === 'skip' && this.player.features?.rules.enabled && !this.player.features.isManager(event.author_id)) {
          throw new UserError('房间权限已变化，请重新发送切歌指令参与投票。');
        }
      } });
    if (interrupts && controlEpoch !== undefined) {
      // Commands received after this control remain ordered intents (e.g.
      // pause, resume). Only account for our own known increments: reset adds
      // one more for Stop. An external interruption must leave old items stale.
      const completedEpoch = controlEpoch + (action === 'stop' ? 1 : 0);
      if (this.player.operationEpoch === completedEpoch) {
        for (const pending of this.inbox) {
          if (pending.expectedEpoch >= expectedEpoch && pending.expectedEpoch <= completedEpoch) pending.expectedEpoch = completedEpoch;
        }
      }
    }
    return reply(result);
  }
  stop() { this.closed = true; this.inbox = []; return this.draining; }
}
