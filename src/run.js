import {createClient} from '@supabase/supabase-js';
import sharp from 'sharp';

const required=(key)=>{const v=process.env[key];if(!v)throw new Error(`Missing ${key}`);return v};
const supabase=createClient(required('SUPABASE_URL'),required('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
const LIVE=process.env.PUBLISH_ENABLED==='true';
const GRAPH_VERSION=process.env.META_GRAPH_VERSION||'v24.0'; // pin a supported version for your app
const graphBase=(process.env.META_GRAPH_BASE||'https://graph.facebook.com')+'/'+GRAPH_VERSION;
const token=()=>required('INSTAGRAM_ACCESS_TOKEN');
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const split=(s,max=22)=>{const words=String(s||'').split(/\s+/),lines=[''];for(const w of words){const last=lines.length-1;if((lines[last]+' '+w).trim().length>max&&lines[last])lines.push(w);else lines[last]=(lines[last]+' '+w).trim()}return lines.slice(0,5)};

function renderSvg(job,theme){
 const story=job.media_kind==='STORY', W=1080,H=story?1920:1350;
 const bg=/^#[0-9a-fA-F]{6}$/.test(theme?.bg)?theme.bg:'#151026',accent=/^#[0-9a-fA-F]{6}$/.test(theme?.accent)?theme.accent:'#b273ff';
 const titleLines=split(job.headline,story?18:20),lineHeight=story?135:113,fontSize=story?110:91,startY=story?620:425;
 const title=titleLines.map((line,i)=>`<text x="80" y="${startY+i*lineHeight}" font-size="${fontSize}" font-weight="900" fill="white">${esc(line)}</text>`).join('');
 const subY=startY+titleLines.length*lineHeight+100;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
 <rect width="100%" height="100%" fill="${bg}"/>
 <circle cx="1000" cy="180" r="390" fill="${accent}" opacity="0.22"/>
 <circle cx="60" cy="${H-80}" r="310" fill="${accent}" opacity="0.15"/>
 <rect x="80" y="${story?400:225}" width="160" height="12" rx="6" fill="${accent}"/>
 ${title}
 <text x="80" y="${subY}" font-size="44" font-weight="600" fill="${accent}">${esc((job.subhead||'').slice(0,38))}</text>
 <rect x="80" y="${H-260}" width="920" height="3" fill="${accent}" opacity="0.6"/>
 <text x="80" y="${H-192}" font-size="36" fill="white">EVENTO · SCOPRI I DETTAGLI NEL PROFILO</text>
 </svg>`;
}
async function meta(path,fields,method='POST'){
 const url=new URL(graphBase+'/'+path.replace(/^\//,''));
 const body=new URLSearchParams({...fields,access_token:token()});
 const res=await fetch(method==='GET'?`${url}?${body}`:url,{method, ...(method==='GET'?{}:{body})});
 const json=await res.json();if(!res.ok||json.error)throw new Error(`Meta HTTP ${res.status}: ${JSON.stringify(json.error||json)}`);return json;
}
const persist=async(id,patch)=>{const {error}=await supabase.from('publication_jobs').update(patch).eq('id',id);if(error)throw error};
async function publish(job,account,assetUrl){
 // See Meta Content Publishing: create container, poll status, publish. One IG account token per deployment.
 if(account.ig_user_id!==required('INSTAGRAM_IG_USER_ID'))throw Error('Account ID mismatch: configure a separate deployment/token for each account');
 const params=job.media_kind==='STORY'?{media_type:'STORIES',image_url:assetUrl}:{image_url:assetUrl,caption:job.caption||job.headline};
 let cid=job.container_id;
 if(!cid){cid=(await meta(`${account.ig_user_id}/media`,params)).id;await persist(job.id,{container_id:cid})}
 for(let i=0;i<10;i++){
  const status=await meta(cid,{fields:'status_code'},'GET');
  if(status.status_code==='FINISHED')break;
  if(['ERROR','EXPIRED'].includes(status.status_code))throw Error(`Container: ${status.status_code}`);
  if(i===9)throw Error('Container still processing; retry next execution');
  await new Promise(r=>setTimeout(r,3000));
 }
 const r=await meta(`${account.ig_user_id}/media_publish`,{creation_id:cid});
 return r.id;
}
async function planEventJobs(){
 const {data:events,error}=await supabase.from('events').select('*,social_accounts(*)').eq('enabled',true).gte('starts_at',new Date().toISOString()).lte('starts_at',new Date(Date.now()+32*86400000).toISOString());
 if(error)throw error;
 for(const event of events||[]){
  if(!event.social_accounts?.enabled)continue;
  const when=new Date(event.starts_at),details=[event.venue,event.price_text].filter(Boolean).join(' · ');
  const scripts=[
   {days:7,kind:'POST',title:event.title,caption:`${event.title}\n${when.toLocaleString('it-IT',{timeZone:'Europe/Rome',dateStyle:'full',timeStyle:'short'})}\n${details}\n${event.details||''}`},
   {days:3,kind:'STORY',title:'MANCANO 3 GIORNI',caption:null},
   {days:1,kind:'STORY',title:'CI SIAMO QUASI!',caption:null},
   {days:0,kind:'STORY',title:'OGGI SI GIOCA!',caption:null}
  ];
  for(const v of scripts){
   const scheduled=new Date(when.getTime()-(v.days*24+(v.days===0?8:0))*3600000);
   if(scheduled.getTime()<Date.now()-3*3600000)continue; // don't create stale reminders
   const {error:e}=await supabase.from('publication_jobs').upsert({account_id:event.account_id,event_id:event.id,media_kind:v.kind,scheduled_at:scheduled.toISOString(),headline:v.title,subhead:details.slice(0,38),caption:v.caption},{onConflict:'account_id,event_id,media_kind,scheduled_at',ignoreDuplicates:true});
   if(e)throw e;
  }
 }
}
async function run(){
 await planEventJobs();
 const now=new Date().toISOString();
 const {data:jobs,error}=await supabase.from('publication_jobs').select('*,social_accounts(*)').eq('status','queued').lte('scheduled_at',now).order('scheduled_at',{ascending:true}).limit(5);
 if(error)throw error;
 for(const job of jobs||[]){
  try{
   // Atomic claim: avoids two workers processing the same queued item.
   const {data:claimed,error:claimErr}=await supabase.from('publication_jobs').update({status:'rendering',locked_at:now,attempts:job.attempts+1}).eq('id',job.id).eq('status','queued').select('id');
   if(claimErr)throw claimErr;if(!claimed?.length)continue;
   const account=job.social_accounts;if(!account?.enabled)throw Error('Account disabled');
   const jpg=await sharp(Buffer.from(renderSvg(job,account.theme))).jpeg({quality:91}).toBuffer();
   const path=`${account.id}/${job.id}.jpg`;
   const {error:uploadErr}=await supabase.storage.from('instagram-public').upload(path,jpg,{contentType:'image/jpeg',upsert:true});
   if(uploadErr)throw uploadErr;
   const {data:{publicUrl}}=supabase.storage.from('instagram-public').getPublicUrl(path);
   if(!LIVE){await persist(job.id,{status:'ready',asset_path:path,last_error:null});console.log('DRY RUN',job.id,publicUrl);continue}
   await persist(job.id,{status:'publishing',asset_path:path});
   const published=await publish(job,account,publicUrl);
   await persist(job.id,{status:'published',instagram_media_id:published,last_error:null});
   console.log('PUBLISHED',job.id,published);
  }catch(err){console.error('JOB FAILED',job.id,err);await persist(job.id,{status:job.container_id?'needs_review':'failed',last_error:String(err).slice(0,1200)}).catch(console.error)}
 }
}
run().catch(e=>{console.error(e);process.exitCode=1});
