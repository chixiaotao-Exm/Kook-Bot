import http from 'node:http';

const OPERATIONS = new Set(['create_job', 'list_files', 'read_file', 'search_code', 'write_file', 'replace_text',
  'get_diff', 'run_checks', 'cancel_operation', 'job_status', 'publish']);
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const MAX_BODY = 512 * 1024, MAX_RESPONSE = 256 * 1024;

export class BrokerClientError extends Error {
  constructor(code) { super('代码工具请求失败。'); this.name = 'BrokerClientError'; this.code = code; }
}

export class CodeBrokerClient {
  constructor({ socketPath = '/run/kook-code-agent/broker.sock', requestImpl = http.request } = {}) {
    if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.length > 200
      || /[\r\n\x00]/.test(socketPath) || typeof requestImpl !== 'function') throw new BrokerClientError('CONFIG');
    this.socketPath = socketPath; this.requestImpl = requestImpl;
  }

  request(operation, jobId, args = {}, { signal } = {}) {
    if (!OPERATIONS.has(operation) || (operation === 'create_job' ? jobId !== null : typeof jobId !== 'string' || !UUID.test(jobId))
      || !args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(new BrokerClientError('TOOL_INVALID'));
    let body;
    try { body = JSON.stringify({ operation, jobId, args }); } catch { return Promise.reject(new BrokerClientError('TOOL_INVALID')); }
    if (Buffer.byteLength(body) > MAX_BODY) return Promise.reject(new BrokerClientError('TOOL_INVALID'));
    if (signal?.aborted) return Promise.reject(new BrokerClientError('CANCELLED'));
    const timeoutMs = operation === 'run_checks' ? 210000 : ['create_job', 'publish'].includes(operation) ? 120000 : 30000;
    return new Promise((resolve, reject) => {
      let timer, request, finished = false;
      const settle = (error, result) => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { request?.destroy(); reject(error); } else resolve(result);
      };
      const abort = () => settle(new BrokerClientError('CANCELLED'));
      try {
        request = this.requestImpl({ socketPath: this.socketPath, path: '/rpc', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
          const chunks = []; let bytes = 0;
          if (Number(response.headers?.['content-length']) > MAX_RESPONSE) { response.destroy(); settle(new BrokerClientError('BROKER_FAILED')); return; }
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE) { response.destroy(); settle(new BrokerClientError('BROKER_FAILED')); return; }
            chunks.push(Buffer.from(chunk));
          });
          response.on('error', () => settle(new BrokerClientError('BROKER_FAILED')));
          response.on('close', () => settle(new BrokerClientError('BROKER_FAILED')));
          response.on('end', () => {
            let value;
            try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
            catch { settle(new BrokerClientError('BROKER_FAILED')); return; }
            if (value?.ok === true && response.statusCode === 200) settle(null, value.data);
            else {
              const code = typeof value?.error?.code === 'string' && /^[A-Z_]{1,48}$/.test(value.error.code) ? value.error.code : 'BROKER_FAILED';
              settle(new BrokerClientError(code));
            }
          });
        });
        request.on('error', () => settle(new BrokerClientError('BROKER_FAILED')));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => settle(new BrokerClientError('TIMEOUT')), timeoutMs);
        request.end(body);
      } catch { settle(new BrokerClientError('BROKER_FAILED')); }
    });
  }
}
