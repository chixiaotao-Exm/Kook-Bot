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
    throw Error('The reporter TXT file is invalid or exceeds 1 MiB.');
  const profiles = [], accounts = new Map();
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^SteamID64[ \t]+(?:PUBG游戏昵称|PUBG[ \t]+nickname)$/i.test(line)) continue;
    const fields = line.split(/[ \t]+/);
    const [steam, nickname] = fields;
    const profile = { email, steam, nickname, language, category: CATEGORY };
    try {
      if (fields.length !== 2 || /[\u0000-\u0008\u000a-\u001f\u007f\uFFFD]/.test(line)) throw Error();
      validateProfile(profile);
    } catch { throw Error(`Invalid reporter TXT line ${index + 1} or shared settings. Use SteamID64<TAB>PUBG nickname and configure the shared email and language.`); }
    const previous = accounts.get(steam);
    if (previous) {
      if (profileKey(previous) !== profileKey(profile))
        throw Error(`Reporter TXT line ${index + 1} conflicts with an earlier entry for the same Steam ID.`);
      continue;
    }
    accounts.set(steam, profile); profiles.push(Object.freeze(profile));
  }
  if (!profiles.length) throw Error('The reporter TXT file contains no valid accounts.');
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
      if (error.code !== 'ENOENT' || !allowLegacy) throw Error('Cannot read the reporter TXT file. Check its path and permissions.');
    }
    if (legacyFile && (!email?.trim() || !language?.trim() || contents === undefined)) {
      try {
        legacy = JSON.parse(await readFile(legacyFile, 'utf8'));
        validateProfile(legacy);
      } catch (error) {
        if (error.code !== 'ENOENT') throw Error('Invalid legacy reporter profile. Check the shared email and language settings.');
      }
    }
    const settings = { email: email?.trim() || legacy.email, language: language?.trim() || legacy.language || 'english' };
    if (contents === undefined) {
      try { contents = formatReporter({ ...legacy, ...settings }); }
      catch { throw Error('No valid reporter TXT file or legacy reporter profile was found.'); }
    }
    return parseReporters(contents, settings);
  };
}
