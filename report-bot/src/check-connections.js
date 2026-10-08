// Read-only connectivity check: never submits a PUBG report or creates an OCR job.
import {CHANNEL_ID} from './domain.js';
const token=process.env.KOOK_TOKEN?.trim();
if(!token)throw Error('KOOK token missing');
if(!/^\d{5,30}$/.test(process.env.KOOK_CHANNEL_ID?.trim()||'')||/^0+$/.test(CHANNEL_ID))throw Error('KOOK_CHANNEL_ID is required');
for(const route of ['user/me','channel/view?target_id='+CHANNEL_ID]){
 const r=await fetch('https://www.kookapp.cn/api/v3/'+route,{headers:{Authorization:'Bot '+token},redirect:'error',signal:AbortSignal.timeout(12000)});
 const j=await r.json();if(!r.ok||j.code!==0)throw Error('KOOK connection check failed');
 console.log(JSON.stringify({check:route.split('?')[0],ok:true,...(route.startsWith('channel')?{channelMatches:j.data?.id===CHANNEL_ID,channelType:j.data?.type}:{bot:j.data?.bot})}));
}
const r=await fetch('https://support.pubg.com/api/v2/help_center/sessions.json',{redirect:'error',signal:AbortSignal.timeout(15000)});
let valid=false;try{valid=Boolean((await r.json())?.current_session?.csrf_token)}catch{}
console.log(JSON.stringify({check:'pubg_session',httpStatus:r.status,tokenAvailable:valid,reportSubmitted:false}));
