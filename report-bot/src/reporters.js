import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CATEGORY, validateProfile } from './protocol.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export const mailboxHash = email => digest(email.trim().toLowerCase());
export const reporterId = profile => digest(profile.steam);
const profileKey = profile => JSON.stringify([profile.email, profile.steam, profile.nickname, profile.language, profile.category]);
export const reportersSnapshot = profiles => digest(JSON.stringify(profiles.map(profileKey)));

/** UTF-8 TXT: SteamID64<TAB>nickname. Email and language are shared configuration. */
export function parseReporters(text, { email, language = 'english' } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024)
    throw Error('举报人 TXT 无效或超过 1 MiB。');
  const profiles = [], accounts = new Map();
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^SteamID64[ \t]+PUBG游戏昵称$/i.test(line)) continue;
    const fields = line.split(/[ \t]+/);
    const [steam, nickname] = fields;
    const profile = { email, steam, nickname, language, category: CATEGORY };
    try {
      if (fields.length !== 2 || /[\u0000-\u0008\u000a-\u001f\u007f\uFFFD]/.test(line)) throw Error();
      validateProfile(profile);
    } catch { throw Error(`举报人 TXT 第 ${index + 1} 行或固定配置无效，请使用：SteamID64<TAB>PUBG游戏昵称，并配置固定邮箱和语言。`); }
    const previous = accounts.get(steam);
    if (previous) {
      if (profileKey(previous) !== profileKey(profile))
        throw Error(`举报人 TXT 第 ${index + 1} 行与前面的同一 Steam ID 资料冲突。`);
      continue;
    }
    accounts.set(steam, profile); profiles.push(Object.freeze(profile));
  }
  if (!profiles.length) throw Error('举报人 TXT 没有有效账号。');
  return Object.freeze(profiles);
}

export function formatReporter(profile) {
  validateProfile(profile);
  const line = [profile.steam, profile.nickname].join('\t');
  parseReporters(line, profile);
  return line;
}

/** Reload on each preview/confirmation. Explicit TXT paths never fall back to legacy JSON. */
export function createReportersReader({ file, legacyFile, email, language, allowLegacy = false } = {}) {
  return async function readReporters() {
    let contents, legacy = {};
    try { contents = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT' || !allowLegacy) throw Error('无法读取举报人 TXT，请检查文件路径和权限。');
    }
    if (legacyFile && (!email?.trim() || !language?.trim() || contents === undefined)) {
      try {
        legacy = JSON.parse(await readFile(legacyFile, 'utf8'));
        validateProfile(legacy);
      } catch (error) {
        if (error.code !== 'ENOENT') throw Error('旧版举报人资料无效，请检查固定邮箱和语言配置。');
      }
    }
    const settings = { email: email?.trim() || legacy.email, language: language?.trim() || legacy.language || 'english' };
    if (contents === undefined) {
      try { contents = formatReporter({ ...legacy, ...settings }); }
      catch { throw Error('未找到有效的举报人 TXT 或旧版举报人资料。'); }
    }
    return parseReporters(contents, settings);
  };
}
