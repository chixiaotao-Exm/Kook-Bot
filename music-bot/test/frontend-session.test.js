import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionApi } from '../frontend/session.js';

const response = (status, body) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('parallel expired requests share one renewal and late old 401 uses renewed session', async () => {
  let csrf = 'old', renewalCount = 0;
  const renew = deferred(), late = deferred(), sent = [], entered = deferred();
  const fetcher = async (route, options) => {
    sent.push({ route, token: options.headers['X-CSRF-Token'] });
    if (route === '/api/session') { renewalCount++; entered.resolve(); await renew.promise; return response(200, { authenticated:true, csrf:'new' }); }
    if (options.headers['X-CSRF-Token'] === 'old') {
      if (route === '/api/late') await late.promise;
      return response(401, { error:'expired' });
    }
    return response(200, { ok:true });
  };
  const api = createSessionApi({ getCsrf:()=>csrf, setCsrf:(value)=>{csrf=value;}, requiresPassword:()=>false, onUnauthorized:()=>assert.fail('unexpected login'), fetcher });
  const first = api('/first', {}), second = api('/second', {}), delayed = api('/late', {});
  await entered.promise;
  const during = api('/during', {});
  renew.resolve(); await Promise.all([first,second,during]); late.resolve(); await delayed;
  assert.equal(renewalCount,1);
  assert.equal(sent.find((entry)=>entry.route==='/api/during').token,'new');
  assert.equal(sent.filter((entry)=>entry.route==='/api/late').at(-1).token,'new');
});

test('a CSRF 403 is not replayed as a queue mutation', async () => {
  let requests = 0;
  const api = createSessionApi({ getCsrf:()=> 'valid', setCsrf:()=>{}, requiresPassword:()=>false, onUnauthorized:()=>{}, fetcher:async()=> { requests++; return response(403,{error:'forbidden',code:'CSRF'}); } });
  await assert.rejects(api('/play', { input:'1' }), (error)=> error.status===403 && error.code==='CSRF');
  assert.equal(requests,1);
});

test('failed renewal rejects pending operations without submitting them', async () => {
  let csrf='old', first=true, submitted=0;
  const started=deferred(), finish=deferred();
  const api=createSessionApi({getCsrf:()=>csrf,setCsrf:(v)=>{csrf=v;},requiresPassword:()=>false,onUnauthorized:()=>{},fetcher:async(route)=>{
    if(route==='/api/session'){started.resolve();await finish.promise;return response(503,{error:'offline'});}
    submitted++; if(first){first=false;return response(401,{error:'expired'});} return response(200,{ok:true});
  }});
  const firstRequest=api('/state').catch((error)=>error);
  await started.promise;const pending=api('/play',{}).catch((error)=>error);finish.resolve();
  const errors=await Promise.all([firstRequest,pending]);assert.ok(errors.every((error)=>error.message==='offline'));assert.equal(submitted,1);
});
