import {CHANNEL_ID} from './domain.js';
export function createSender(token,fetchImpl=fetch){
 if(typeof token!=='string'||!token.trim()||/[\s\x00-\x1f\x7f]/.test(token))throw Error('Invalid KOOK token');
 return async({channelId=CHANNEL_ID,text,buttons=[]},{signal}={})=>{
  if(channelId!==CHANNEL_ID||typeof text!=='string'||!text.trim()||text.length>2000||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))throw Error('Invalid message');
  if(!Array.isArray(buttons)||buttons.length>3||buttons.some(b=>!['确认举报','确认预览','修改昵称','取消'].includes(b.label)||!/^report:(confirm|cancel|edit):[a-f0-9-]{36}$/.test(b.value)))throw Error('Invalid buttons');
  signal?.throwIfAborted();const controller=new AbortController();const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let timer,rejectAbort;const stopped=new Promise((_,reject)=>{rejectAbort=()=>reject(Error('KOOK delivery unconfirmed'));combined.addEventListener('abort',rejectAbort,{once:true});timer=setTimeout(()=>controller.abort(),10000)});
  const operation=async()=>{
   const modules=[{type:'header',text:{type:'plain-text',content:'PUBG 举报助手'}},{type:'section',text:{type:'plain-text',content:text}}];
   if(buttons.length)modules.push({type:'action-group',elements:buttons.map(b=>({type:'button',theme:b.value.includes(':confirm:')?'warning':'secondary',click:'return-val',value:b.value,text:{type:'plain-text',content:b.label}}))});
   const response=await fetchImpl('https://www.kookapp.cn/api/v3/message/create',{method:'POST',redirect:'error',signal:combined,
    headers:{Authorization:`Bot ${token}`,'Content-Type':'application/json'},body:JSON.stringify({type:10,target_id:CHANNEL_ID,content:JSON.stringify([{type:'card',theme:'secondary',size:'lg',modules}])})});
   if(!response.ok)throw Error('KOOK delivery unconfirmed');
   if(Number(response.headers.get('content-length'))>32768){void response.body?.cancel();throw Error('KOOK response too large')}
   const reader=response.body.getReader();let size=0;const chunks=[];
   try{for(;;){combined.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768)throw Error('KOOK response too large');chunks.push(value)}}finally{void reader.cancel().catch(()=>{})}
   const result=JSON.parse(Buffer.concat(chunks).toString());
   if(result.code!==0||typeof result.data?.msg_id!=='string'||!/^[a-f0-9-]{16,100}$/i.test(result.data.msg_id))throw Error('KOOK delivery unconfirmed');return result.data.msg_id;
  };
  try{return await Promise.race([operation(),stopped])}catch{throw Error('KOOK delivery unconfirmed')}
  finally{clearTimeout(timer);combined.removeEventListener('abort',rejectAbort);controller.abort()}
 };
}
