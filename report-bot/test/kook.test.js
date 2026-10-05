import test from 'node:test';
import assert from 'node:assert/strict';
import {createSender}from'../src/kook.js';
import {CHANNEL_ID}from'../src/domain.js';
test('fixed KOOK destination, plain text and limited callback values are enforced',async()=>{
 const calls=[];const send=createSender('private-token',async(url,opts)=>{calls.push({url,opts});return Response.json({code:0,data:{msg_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}})});
 assert.equal(await send({text:'(met)all(met)',buttons:[{label:'确认举报',value:'report:confirm:12345678-1234-1234-1234-123456789012'}]}),'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
 const payload=JSON.parse(calls[0].opts.body);assert.equal(payload.target_id,CHANNEL_ID);assert.equal(JSON.parse(payload.content)[0].modules[1].text.type,'plain-text');
 await assert.rejects(send({channelId:'12345',text:'wrong'}));await assert.rejects(send({text:'x'.repeat(2001)}));await assert.rejects(send({text:'x',buttons:[{label:'任意',value:'https://evil.test'}]}));
 assert.equal(calls.length,1);
});
test('failed or ambiguous message delivery is not retried or reported as sent',async()=>{
 let calls=0;const send=createSender('private-token',async()=>{calls++;return Response.json({code:403,message:'private-token'})});
 await assert.rejects(send({text:'test'}),e=>e.message==='KOOK delivery unconfirmed');assert.equal(calls,1);
 const abort=new AbortController();abort.abort();await assert.rejects(send({text:'test'},{signal:abort.signal}));assert.equal(calls,1);
});
