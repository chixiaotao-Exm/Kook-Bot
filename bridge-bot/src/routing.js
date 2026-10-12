import { normalizeRepositories } from './repositories.js';
import { validNotification } from './events.js';
import { createKookSender } from './kook.js';

export function createRepositoryRouter({ repositories, repositoryTokens = {}, token, channelId, fetchImpl, timeoutMs } = {}) {
  const allowed = normalizeRepositories(repositories);
  const routes = allowed.map(repository => ({ repository,
    send: createKookSender({ token: repositoryTokens[repository] || token, channelId, repository, fetchImpl, timeoutMs }) }));
  const match = notification => routes.find(route => validNotification(notification, route.repository));
  return Object.freeze({ repositories: allowed, validate: notification => Boolean(match(notification)),
    async send(notification, options) {
      const route = match(notification);
      if (!route) throw Object.assign(new Error('Notification repository is not configured'), { delivery: 'rejected' });
      return route.send(notification, options);
    } });
}
