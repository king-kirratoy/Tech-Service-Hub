// ═══════════ STATE ═══════════
let histRaw=[],actRaw=[],catStats={},actTix=[],closedTix=[],roster=[];
let selTech=null,charts={};
let isCommander=false;
let loggedInAgent=null;

// ═══════════ AUTH & PROXY ═══════════
const PROXY_BASE="https://service-hub-launcher.onrender.com";
let _sb=null; // Supabase client — initialized after config fetch

async function _initSupabase(){
  if(!window.supabase)return;
  try{
    const r=await fetch(PROXY_BASE+"/api/config");
    if(!r.ok)return;
    const cfg=await r.json();
    if(cfg.supabase_url&&cfg.supabase_anon_key){
      _sb=window.supabase.createClient(cfg.supabase_url,cfg.supabase_anon_key);
    }
  }catch(e){console.warn("Supabase config fetch failed, using legacy auth:",e)}
}
// Fire immediately — awaited before first auth use in boot sequence
const _sbReady=_initSupabase();

// authToken is a login-state flag only ("1" = logged in, "" = logged out).
// The actual JWT lives in an HttpOnly cookie set by the backend.
let authToken="";

function authH(){return{"Content-Type":"application/json"}}

async function refreshTokenIfNeeded(){
  if(!authToken)return;
  try{
    const r=await fetch(PROXY_BASE+"/api/refresh",{method:"POST",credentials:"include",headers:authH()});
    if(r.status===401){authToken="";loggedInAgent=null;isCommander=false;stopAutoRefresh();applyLoginState()}
  }catch(e){console.error("Token refresh error:",e)}
}

async function supaLogin(agentName,password){
  try{
    const r=await fetch(PROXY_BASE+"/api/login",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({agent_name:agentName,password})});
    if(!r.ok){const err=await r.json().catch(()=>({}));return{error:err.error||"Login failed"}}
    const d=await r.json();
    // Tokens are now in HttpOnly cookies set by the server.
    // Just record login state and return metadata.
    authToken="1";
    return{agent_name:d.agent_name,role:d.role};
  }catch(e){console.error("Login error:",e);return{error:"Cannot reach server"}}
}

async function fetchRetry(url,opts={},retries=3,delay=1500){
  opts={credentials:"include",...opts};
  for(let i=0;i<=retries;i++){
    try{const r=await fetch(url,opts);if(r.ok)return r;if(r.status===401)return r;if(i<retries)await new Promise(ok=>setTimeout(ok,delay*(i+1)))}catch(e){if(i===retries)throw e;await new Promise(ok=>setTimeout(ok,delay*(i+1)))}
  }
  return null;
}

async function loadRobotConfig(agentName){
  try{const r=await fetchRetry(PROXY_BASE+"/api/robot?agent="+encodeURIComponent(agentName),{headers:authH()});if(!r||!r.ok)return null;return await r.json()}catch(e){console.error("Robot load error:",e);return null}
}

async function saveRobotConfig(agentName,config){
  try{const r=await fetch(PROXY_BASE+"/api/robot",{method:"POST",credentials:"include",headers:authH(),body:JSON.stringify(config)});return r.ok}catch(e){console.error("Robot save error:",e);return false}
}

async function loadAllRobots(){
  try{const r=await fetchRetry(PROXY_BASE+"/api/robots",{headers:authH()});if(!r||!r.ok)return[];return await r.json()}catch(e){console.error("Robots load error:",e);return[]}
}

async function loadCommanderAgents(){
  try{const r=await fetchRetry(PROXY_BASE+"/api/commanders",{headers:authH()});if(!r||!r.ok)return[];return await r.json()}catch(e){console.error("Commanders load error:",e);return[]}
}

// ═══════════ OVERRIDE PERSISTENCE ═══════════
const OVR_KEY="servicehub_overrides";
function loadOverrides(){try{return JSON.parse(localStorage.getItem(OVR_KEY)||"{}")}catch(e){return{}}}
function saveOverrides(ovr){try{localStorage.setItem(OVR_KEY,JSON.stringify(ovr))}catch(e){}}
function setOverride(id,data){const ovr=loadOverrides();ovr[id]={...ovr[id],...data,ts:Date.now()};saveOverrides(ovr);pushTicketOverride(id,ovr[id]);}
function clearOverride(id){const ovr=loadOverrides();delete ovr[id];saveOverrides(ovr);deleteTicketOverride(id);}
function clearAllOverrides(){localStorage.removeItem(OVR_KEY)}
async function loadTicketOverrides(){
  try{
    const r=await fetchRetry(PROXY_BASE+"/api/ticket-overrides",{headers:authH()});
    if(!r||!r.ok)return;
    const rows=await r.json();
    if(!Array.isArray(rows))return;
    const ovr={};
    rows.forEach(row=>{ovr[row.ticket_id]={dayIdx:row.day_idx,startHour:row.start_hour,est:row.est,ts:row.updated_at?new Date(row.updated_at).getTime():Date.now()}});
    saveOverrides(ovr);
  }catch(e){console.error("Ticket overrides load error:",e)}
}
async function pushTicketOverride(id,data){
  try{
    const body={ticket_id:id};
    if(data.dayIdx!=null)body.day_idx=data.dayIdx;
    if(data.startHour!=null)body.start_hour=data.startHour;
    if(data.est!=null)body.est=data.est;
    await fetchRetry(PROXY_BASE+"/api/ticket-overrides",{method:"POST",headers:authH(),body:JSON.stringify(body)});
  }catch(e){console.error("Override push error:",e)}
}
async function deleteTicketOverride(id){
  try{await fetchRetry(PROXY_BASE+"/api/ticket-overrides/"+encodeURIComponent(id),{method:"DELETE",headers:authH()});}catch(e){console.error("Override delete error:",e)}
}
function applyOverrides(){
  const ovr=loadOverrides();
  // Remove overrides for tickets that no longer exist
  const activeIds=new Set(actTix.map(t=>t.id));
  let changed=false;
  Object.keys(ovr).forEach(id=>{if(!activeIds.has(id)){delete ovr[id];changed=true}});
  if(changed)saveOverrides(ovr);
  // Apply overrides to active tickets
  actTix.forEach(tk=>{
    const o=ovr[tk.id];
    if(!o)return;
    if(o.est!=null){tk.est=o.est;tk.manualEst=true}
    if(o.startHour!=null)tk.startHour=o.startHour;
    if(o.dayIdx!=null)tk.dayIdx=o.dayIdx;
  });
}
// Category-only baselines (15,886 closed tickets, 3-month median, snapped to 0.25h)
const BL_CAT={"Client>Business Meeting":0.25,"Client>Consulting/Research":0.25,"Client>Infrastructure":0.25,"Client>MSP Offboarding":0.25,"Client>MSP Onboarding":19.25,"Client>Purchase Request":0.25,"Client>Renewal":0.25,"Client>Service Documentation":0.25,"Data Analytics>Access/Removal":0.75,"End User>Access Change":0.25,"End User>Account Info Update":0.25,"End User>Account Login Issue":0.25,"End User>Admin Permissions":0.25,"End User>Archive Mailbox":0.25,"End User>Automatic Reply":0.25,"End User>Calendar":0.25,"End User>Computer Setup":0.5,"End User>Email Alias":0.25,"End User>Email Contacts":0.25,"End User>Email Delivery Issue":0.25,"End User>Email Forwarding":0.25,"End User>Email Recovery":0.25,"End User>Email Rule":0.25,"End User>Email Signature":0.25,"End User>Faxing Issue":0.75,"End User>File Access Issue":0.25,"End User>File Recovery":0.25,"End User>File Relocation":0.25,"End User>File Share":0.25,"End User>General Inquiry":0.25,"End User>Group Management":0.25,"End User>Inactive Account Removal":0.5,"End User>International Travel":0.5,"End User>License Change":0.25,"End User>Mailbox Access":0.25,"End User>Mailbox Capacity":0.5,"End User>Mapped Drive Issue":0.25,"End User>Mobile Phone Setup":0.25,"End User>Name Change":0.5,"End User>New User Setup":0.5,"End User>Password Reset":0.25,"End User>SharePoint Access":0.25,"End User>Shared Mailbox":0.25,"End User>Training":0.25,"End User>User Termination":0.5,"End User>Windows Settings":0.25,"Hardware>Asset Shipping & Receiving":0.25,"Hardware>Audio Issue":0.25,"Hardware>Cable/Adapter":0.75,"Hardware>Charger":0.5,"Hardware>Conference Room Equipment":0.5,"Hardware>Desk Phone":0.5,"Hardware>Desktop":0.25,"Hardware>Disk Usage":0.5,"Hardware>Docking Station":0.25,"Hardware>Driver/Firmware Update":0.25,"Hardware>Firewall":0.5,"Hardware>Headset/Headphone":0.25,"Hardware>Inventory":0.5,"Hardware>Laptop":0.5,"Hardware>Microphone":0.25,"Hardware>Mobile Hotspot":0.5,"Hardware>Mobile Phone":0.75,"Hardware>Monitor":0.25,"Hardware>Mouse/Keyboard":0.25,"Hardware>NAS/SAN":0.75,"Hardware>Office Move/Setup":1,"Hardware>PC Performance Issue":0.5,"Hardware>Power Strip/Surge Protector":0.25,"Hardware>Printer/Scanner":0.25,"Hardware>Recycling":2.5,"Hardware>Server":0.25,"Hardware>Signature Pad":0.25,"Hardware>Switch":4.0,"Hardware>Tablet":1.25,"Hardware>Time Clock":1.0,"Hardware>UPS/APC":0.25,"Hardware>Webcam":0.25,"Hardware>Wireless Access Point":0.5,"Hardware>iPad":0.25,"Network>DHCP/IP Management":0.5,"Network>DNS/Domain Management":0.5,"Network>Firewall Configuration":0.5,"Network>ISP/LTE":0.75,"Network>Meraki Licensing":0.25,"Network>Network Connectivity":0.5,"Network>Phone System":0.25,"Network>Power Outage":0.25,"Network>Security Camera/Door Access":0.75,"Network>Switch Configuration":0.75,"Network>VLAN Configuration":0.75,"Network>VPN":0.25,"Network>Website Access":0.25,"Network>Wireless Configuration":0.5,"Security>Account Compromise":0.5,"Security>Avanan":0.25,"Security>Certificate":0.25,"Security>Compliance/Audit":0.5,"Security>Conditional Access":0.25,"Security>Encryption":0.25,"Security>External Sharing/Access":0.5,"Security>Forensic Analysis":0.25,"Security>Huntress":0.25,"Security>MFA/2FA":0.25,"Security>Phishing/Spam":0.25,"Security>Proofpoint":0.25,"Security>Restore Request":0.25,"Security>SPF/DKIM/DMARC":1.5,"Security>Suspicious Activity":0.25,"Security>Threatlocker":0.25,"Security>Virus/Malware":0.25,"Software>Adobe":0.25,"Software>Applied Epic":0.25,"Software>AutoCAD":0.25,"Software>Bluebeam":0.25,"Software>CCH ProSystem/Axcess":0.5,"Software>Caseware":0.5,"Software>Citrix/VDI":0.25,"Software>Cloud Drive Mapper (CDM)":0.25,"Software>Datto":0.5,"Software>Dialpad":0.25,"Software>Egnyte":0.25,"Software>Google Chrome":0.25,"Software>Google Workspace":0.5,"Software>Halo":0.5,"Software>Locator":0.5,"Software>McLeod":0.5,"Software>Microsoft 365 Apps Install":0.5,"Software>Microsoft Azure/Entra":0.25,"Software>Microsoft Excel":0.25,"Software>Microsoft OneDrive":0.5,"Software>Microsoft OneNote":0.25,"Software>Microsoft Outlook":0.25,"Software>Microsoft Power Automate":0.25,"Software>Microsoft Power BI":0.25,"Software>Microsoft PowerPoint":0.25,"Software>Microsoft SharePoint":0.5,"Software>Microsoft Teams":0.25,"Software>Microsoft Word":0.5,"Software>Milestone XProtect":1.0,"Software>Nitro":0.25,"Software>Other Application":0.25,"Software>PerfectLaw/AIM":0.25,"Software>Printix":0.5,"Software>QuickBooks":0.5,"Software>RDP":0.25,"Software>SMTP2GO":0.5,"Software>Sage":0.5,"Software>Smokeball":0.25,"Software>Software Removal":0.5,"Software>Splashtop":0.25,"Software>Threadworks":0.25,"Software>Web Browser":0.25,"Software>Windows OS":0.5,"Software>Zee Drive":0.25,"Software>Zoom":0.25,"Software>macOS":1.0,"Triage>Call Transfer":0.25,"Triage>Co-Managed":0.5,"Triage>Merged":0.5,"Uncategorized":1.25};
// Type+Category blended estimates (tiered: 100% combo @≥30, 70/15/15 @10-29, 40/30/30 @<10)
const BL_COMBO={"License Change|End User>License Change":0.25,"New User Setup|End User>New User Setup":0.5,"New User Setup|End User>Access Change":0.25,"User Termination|End User>User Termination":0.5,"User Termination|End User>Email Forwarding":0.25,"User Termination|End User>Access Change":0.25,"User Termination|End User>Mailbox Access":0.25,"User Termination|End User>License Change":0.25,"User Termination|End User>Automatic Reply":0.25,"User Termination|End User>Inactive Account Removal":0.25,"Avanan|Security>Restore Request":0.25,"NOC|Software>Datto":0.5,"Project Task|":3,"Quick Time|":0.5,"Request|End User>Group Management":0.25,"Request|End User>Shared Mailbox":0.25,"Request|End User>Mailbox Access":0.25,"Request|Security>Threatlocker":0.25,"Request|End User>General Inquiry":0.25,"Request|End User>License Change":0.25,"Request|Security>MFA/2FA":0.25,"Request|End User>Admin Permissions":0.25,"Request|End User>Access Change":0.25,"Request|End User>Email Alias":0.25,"Request|Hardware>Printer/Scanner":0.25,"Request|End User>Computer Setup":0.5,"Request|End User>New User Setup":0.5,"Request|Network>VPN":0.25,"Request|Software>Other Application":0.25,"Request|Software>Adobe":0.5,"Request|End User>File Share":0.25,"Request|End User>File Access Issue":0.5,"Request|End User>Name Change":0.5,"Request|Software>QuickBooks":0.5,"Request|End User>Calendar":0.25,"Request|Network>DNS/Domain Management":0.5,"Request|Software>Microsoft Outlook":0.25,"Request|Software>Microsoft SharePoint":0.5,"Request|End User>Mobile Phone Setup":0.25,"Request|Software>Sage":0.5,"Request|Software>Windows OS":0.5,"Request|Software>RDP":0.25,"Request|End User>Password Reset":0.25,"Request|End User>Archive Mailbox":0.25,"Request|Software>Microsoft Teams":0.25,"Request|Network>ISP/LTE":1.5,"Request|End User>User Termination":0.5,"Request|Software>Citrix/VDI":0.5,"Request|Software>Microsoft Azure/Entra":0.5,"Request|Hardware>Office Move/Setup":1,"Request|Software>CCH ProSystem/Axcess":0.5,"Request|Client>Consulting/Research":0.25,"Request|Client>Infrastructure":0.25,"Request|Client>Purchase Request":0.25,"Request|Hardware>Laptop":0.5,"Request|Software>Datto":0.5,"Request|End User>Mapped Drive Issue":0.25,"Request|End User>Email Forwarding":0.25,"Request|End User>SharePoint Access":0.25,"Request|Software>Microsoft OneDrive":0.25,"Request|End User>Account Info Update":0.25,"Request|Software>Bluebeam":0.25,"Request|Security>Compliance/Audit":0.5,"Request|Security>SPF/DKIM/DMARC":0.75,"Request|Hardware>Disk Usage":0.5,"Request|Hardware>Server":0.5,"Request|Client>Service Documentation":0.25,"Request|End User>File Relocation":0.25,"Request|End User>Windows Settings":0.25,"Request|End User>Email Signature":0.25,"Request|End User>Email Delivery Issue":0.25,"Request|End User>Automatic Reply":0.25,"Request|Software>Microsoft Excel":0.25,"Request|Software>Microsoft OneNote":0.25,"Request|Software>Microsoft Power BI":0.25,"Request|Hardware>Driver/Firmware Update":0.25,"Request|Client>Renewal":0.25,"Request|Hardware>Docking Station":0.25,"Request|Software>Software Removal":0.25,"Request|Security>Avanan":0.25,"Request|Network>DHCP/IP Management":0.5,"Request|Software>Splashtop":0.25,"Request|End User>Email Rule":0.25,"Request|End User>Mailbox Capacity":0.5,"Request|Software>SMTP2GO":0.5,"Request|Network>Phone System":0.25,"Request|Software>Microsoft 365 Apps Install":0.25,"Request|Software>Zoom":0.25,"Request|Network>Wireless Configuration":0.5,"Request|End User>Inactive Account Removal":0.5,"Request|Security>Phishing/Spam":0.25,"Request|Client>Business Meeting":0.5,"Service|End User>Account Login Issue":0.25,"Service|End User>Password Reset":0.25,"Service|Software>Other Application":0.25,"Service|Hardware>Printer/Scanner":0.5,"Service|End User>Email Delivery Issue":0.25,"Service|Software>Microsoft Outlook":0.25,"Service|Software>Citrix/VDI":0.25,"Service|Security>MFA/2FA":0.25,"Service|Security>Threatlocker":0.25,"Service|Software>Adobe":0.25,"Service|Network>VPN":0.25,"Service|Hardware>Server":0.25,"Service|Software>Microsoft Teams":0.25,"Service|Network>Network Connectivity":0.5,"Service|End User>Windows Settings":0.25,"Service|Hardware>PC Performance Issue":0.5,"Service|End User>File Access Issue":0.25,"Service|End User>Mapped Drive Issue":0.25,"Service|End User>General Inquiry":0.25,"Service|Software>Microsoft OneDrive":0.5,"Service|Software>Microsoft Excel":0.25,"Service|Software>QuickBooks":0.5,"Service|Software>RDP":0.25,"Service|Network>Website Access":0.25,"Service|Software>Web Browser":0.25,"Service|End User>Computer Setup":0.5,"Service|Software>Sage":0.5,"Service|End User>Email Signature":0.25,"Service|End User>New User Setup":0.25,"Service|Hardware>Monitor":0.25,"Service|Hardware>Mouse/Keyboard":0.25,"Service|Hardware>Docking Station":0.5,"Service|Software>Windows OS":0.5,"Service|End User>Calendar":0.25,"Service|Security>Virus/Malware":0.25,"Service|Software>CCH ProSystem/Axcess":0.5,"Service|Software>Microsoft SharePoint":0.25,"Service|Hardware>Desktop":0.25,"Service|Software>Microsoft Word":0.5,"Service|Security>Encryption":0.25,"Service|Software>Bluebeam":0.25,"Service|Security>Suspicious Activity":0.25,"Service|End User>Mailbox Access":0.5,"Service|End User>Access Change":0.25,"Service|End User>Mobile Phone Setup":0.25,"Service|Hardware>Headset/Headphone":0.25,"Service|Software>Applied Epic":0.25,"Service|Security>Account Compromise":0.5,"Service|Software>Caseware":0.5,"Service|Software>Zoom":0.25,"Service|Network>Phone System":0.25,"Service|Hardware>Disk Usage":0.5,"Service|Hardware>Driver/Firmware Update":0.25,"Service|Hardware>Audio Issue":0.25,"Service|Security>Phishing/Spam":0.25,"Service|End User>License Change":0.25,"Service|End User>Email Recovery":0.25,"Service|End User>File Recovery":0.25,"Service|End User>File Share":0.25,"Service|End User>File Relocation":0.25,"Service|Security>Avanan":0.25,"Service|Software>Cloud Drive Mapper (CDM)":0.25,"Service|End User>Shared Mailbox":0.5,"Service|End User>Faxing Issue":0.75,"Service|Hardware>Firewall":0.5,"Service|Hardware>Laptop":0.5,"Service|Software>Microsoft Azure/Entra":0.25,"Service|Network>Wireless Configuration":0.5,"Service|Network>DNS/Domain Management":0.75,"Service|Network>ISP/LTE":0.5,"Service|Software>Microsoft 365 Apps Install":0.5,"Service|End User>Archive Mailbox":0.25,"Service|Client>Consulting/Research":0.25,"Service|End User>Admin Permissions":0.25,"Service|End User>User Termination":0.25,"Service|Software>McLeod":0.5,"Service|Hardware>UPS/APC":0.25,"Service|Network>DHCP/IP Management":0.5,"Service|Software>Splashtop":0.25,"Service|End User>Email Forwarding":0.5,"Service|Security>Proofpoint":0.25,"Service|Software>Zee Drive":0.25,"Service|Software>Printix":0.5,"Service|Network>Security Camera/Door Access":0.75,"Service|Hardware>Webcam":0.25,"Service|End User>Automatic Reply":0.25,"Service|End User>Mailbox Capacity":0.5,"Service|Software>Locator":0.5,"Service|Software>Threadworks":0.25,"Service|Software>AutoCAD":0.5,"Service|Security>Compliance/Audit":0.25,"Service|End User>SharePoint Access":0.25,"Service|Security>Restore Request":0.25,"Service|Software>Google Chrome":0.25,"Service|Security>Certificate":0.5,"Service|Hardware>Conference Room Equipment":0.5,"Service|Software>Dialpad":0.5,"Service|Client>Infrastructure":0.25,"Service|Client>Business Meeting":0.25,"Service|Software>Smokeball":0.25,"Service|End User>Email Contacts":0.5,"Service|Hardware>Wireless Access Point":0.5,"Service|Hardware>Microphone":0.25,"Service|Software>Microsoft Power BI":0.5,"Service|Hardware>Speaker":0.25,"Service|Hardware>Cable/Adapter":0.5,"Service|End User>Group Management":0.25,"Service|Hardware>iPad":0.25,"Service|End User>Account Info Update":0.25,"Service|Client>Service Documentation":0.25,"Service|Software>Software Removal":0.5,"Service|Network>Switch Configuration":0.75,"Service|Software>Microsoft OneNote":0.25,"Service|Client>Purchase Request":0.25,"Service|Network>Power Outage":0.25,"Service|Software>PerfectLaw/AIM":0.25,"Service|End User>Training":0.25,"Service|Hardware>Asset Shipping & Receiving":0.25,"Service|Hardware>Desk Phone":0.25,"Service|Client>Renewal":0.25,"Service|Security>SPF/DKIM/DMARC":1.5,"Service|Network>VLAN Configuration":0.75};


const SH=7,EH=18,HH=128,BIZ_S=8.5,BIZ_E=16.5,BIZ_D=8,FRT_SLA=4;
const TCOL=["#84BD00","#0095C8","#fdcb6e","#ff7675","#74b9ff","#fd79a8","#a29bfe","#00cec9","#e17055","#dfe6e9"];
const PC={Critical:"#fb9e00",High:"#ffb74d",Medium:"#0095C8",Low:"#6C6C6C"};
const SC={New:"#88ed61","In Progress":"#f2f400","Pending Reply":"#e27300","Client Update":"#ef0a90","Re-Assigned":"#653294","Pending AM":"#0c797d","Pending Vendor":"#aea1ff","Pending Opportunity":"#194d33","Re-Opened":"#f44e3b",Scheduled:"#999999",Monitoring:"#009ce0","License Update":"#fda1ff",Licensing:"#fda1ff","Pending Followup":"#e27300"};
const SHIFTS=[{l:"7:30 AM — 4:30 PM",s:7.5,e:16.5},{l:"8:30 AM — 5:30 PM",s:8.5,e:17.5}];
const LUNCHES=[{l:"11:15 — 12:15",s:11.25,e:12.25},{l:"12:30 — 1:30",s:12.5,e:13.5},{l:"1:45 — 2:45",s:13.75,e:14.75}];
let AGENT_LUNCH={},AGENT_SHIFT={};
async function loadAgentSchedules(){
  try{const r=await fetchRetry(PROXY_BASE+"/api/agent-schedules",{headers:authH()});if(!r||!r.ok)return;const d=await r.json();AGENT_LUNCH={};AGENT_SHIFT={};d.forEach(s=>{AGENT_LUNCH[s.agent_name]=s.lunch_slot!=null?s.lunch_slot:1;AGENT_SHIFT[s.agent_name]=s.shift_slot!=null?s.shift_slot:1})}catch(e){console.error("Agent schedules load error:",e)}
}
let techSched={};
function getSched(id){if(techSched[id])return techSched[id];return{ss:SHIFTS[1].s,se:SHIFTS[1].e,ls:LUNCHES[1].s,le:LUNCHES[1].e,si:1,li:1}}

// ═══════════ UTILS ═══════════
function wkD(b){const d=new Date(b),w=d.getDay(),m=new Date(d);if(w===0)m.setDate(d.getDate()+1);else m.setDate(d.getDate()-((w+6)%7));return Array.from({length:5},(_,i)=>{const x=new Date(m);x.setDate(m.getDate()+i);return x})}
function isSD(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()}
function isT(d){return isSD(d,new Date())}
function fDS(d){return d.toLocaleDateString("en-US",{weekday:"short"})}
function fD(d){return d.toLocaleDateString("en-US",{month:"short",day:"numeric"})}
function fDF(d){return d.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
function fWR(days){return`${fD(days[0])} — ${fD(days[4])}`}
function hT(h){const hr=Math.floor(h),mn=Math.round((h-hr)*60),ap=hr>=12?"PM":"AM",h12=hr===0?12:hr>12?hr-12:hr;return`${h12}:${mn.toString().padStart(2,"0")} ${ap}`}
function hY(h){return(h-SH)*HH}
function yH(y){return SH+y/HH}
function snap(h){return Math.ceil(h*4)/4}
function med(a){if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2}
function p90(a){if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return s[Math.max(0,Math.ceil(s.length*0.9)-1)]}
function pD(s){if(!s)return null;s=String(s).trim();if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)&&!/Z$/.test(s)&&!/[+-]\d{2}:?\d{2}$/.test(s))s+="Z";const d=new Date(s);return isNaN(d)?null:d}
function mK(d){return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`}
function mL(k){const[y,m]=k.split("-");return new Date(y,m-1).toLocaleDateString("en-US",{month:"short",year:"2-digit"})}
function esc(s){return(s==null?"":String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function bizH(start,end){if(!start||!end||end<=start)return 0;let t=0;const c=new Date(start);while(c<end){const w=c.getDay();if(w>=1&&w<=5){const ch=c.getHours()+c.getMinutes()/60;const ed=new Date(c);ed.setHours(0,0,0,0);ed.setDate(ed.getDate()+1);const es=Math.max(ch,BIZ_S);let ee;if(end<ed)ee=Math.min(end.getHours()+end.getMinutes()/60,BIZ_E);else ee=BIZ_E;if(ee>es)t+=(ee-es)*60}const n=new Date(c);n.setHours(0,0,0,0);n.setDate(n.getDate()+1);n.setHours(Math.floor(BIZ_S),(BIZ_S%1)*60,0,0);c.setTime(n.getTime())}return t/60}
function bizD(s,e){return bizH(s,e)/BIZ_D}
// ═══════════ HISTORICAL PROCESSING ═══════════
function procHist(){
  if(!histRaw.length)return;
  const byM={};
  histRaw.forEach(r=>{
    const cr=pD(r.Date_Created);if(!cr)return;
    const mk=mK(cr);
    // Global monthly
    if(!byM[mk])byM[mk]={rt:[],rd:[],sm:0,st:0,fm:0,ft:0,v:0,tw:[],csat:[],ftf:0,closed:0};
    const b=byM[mk];b.v++;
    const frd=pD(r.First_Response_Date);
    const frt=parseFloat(r.First_Response_Time);
    if(!isNaN(frt)&&frt>=0){b.rt.push(frt);b.ft++;if(frt<=FRT_SLA)b.fm++}
    const cd=pD(r.Date_Closed);
    if(cd){
      b.closed++;
      if(cr){const bd=bizD(cr,cd);if(bd>0&&bd<500)b.rd.push(bd)}
      if(frd&&isSD(frd,cd))b.ftf++;
    }
    const sl=pD(r.SLA_Resolution_Target);
    if(cd&&sl){b.st++;if(cd<=sl)b.sm++}
    const tw=parseFloat(r.Time_Taken);if(!isNaN(tw)&&tw>0)b.tw.push(tw);
    const csatRaw=(r.CSAT_Score||r.CSAT_SCORE||"").trim();
    const csatMap={excellent:4,good:3,okay:2,poor:1,bad:1};
    const csatVal=csatMap[csatRaw.toLowerCase()];
    if(csatVal){b.csat.push(csatVal)}
  });
  // Category stats
  catStats={};
  histRaw.forEach(r=>{
    const cat=r.Ticket_Category||"Uncategorized",tw=parseFloat(r.Time_Taken);
    if(isNaN(tw)||tw<=0)return;
    if(!catStats[cat])catStats[cat]=[];catStats[cat].push(tw);
  });
  Object.keys(catStats).forEach(c=>{const a=catStats[c];catStats[c]={n:a.length,med:med(a),mean:a.reduce((x,y)=>x+y,0)/a.length,p90:p90(a)}});

  populateKPIClients();populateCampaignFilters();renderCampaignCharts();updateBanner();
}

// ═══════════ ACTIVE PROCESSING ═══════════
function procAct(){
  if(!actRaw.length)return;
  // Preserve selected tech by name across roster rebuilds
  const prevSelName=selTech?roster.find(t=>t.id===selTech)?.name:null;
  const ac={};
  actRaw.filter(r=>!r.Date_Closed||!r.Date_Closed.trim()).forEach(r=>{
    const a=r.Agent_Assigned||"";
    if(a&&a!=="Unassigned"&&!a.includes("Bot")){
      ac[a]=(ac[a]||0)+1;
    }
  });
  roster=Object.keys(ac).sort((a,b)=>ac[b]-ac[a]).map((n,i)=>({id:i+1,name:n,color:TCOL[i%TCOL.length]}));
  roster.forEach(t=>{
    if(!techSched[t.id]){
      const li=AGENT_LUNCH[t.name]!=null?AGENT_LUNCH[t.name]:1;
      const si=AGENT_SHIFT[t.name]!=null?AGENT_SHIFT[t.name]:1;
      techSched[t.id]={ss:SHIFTS[si].s,se:SHIFTS[si].e,ls:LUNCHES[li].s,le:LUNCHES[li].e,si,li};
    }
  });
  // Restore selection by name
  if(prevSelName){const found=roster.find(t=>t.name===prevSelName);if(found)selTech=found.id;}

  const WAIT_STATUSES=new Set(["Pending Reply","Pending Vendor","Pending AM","Pending Followup","Monitoring","Scheduled"]);

  // Split raw data into active and closed-this-week tickets
  const activeRaw=actRaw.filter(r=>!r.Date_Closed||!r.Date_Closed.trim());
  const closedRaw=actRaw.filter(r=>r.Date_Closed&&r.Date_Closed.trim());

  // Build closed tickets list for calendar display and KPI
  const weekDays0=wkD(new Date());
  closedTix=closedRaw.map((r,i)=>{
    const agent=r.Agent_Assigned||"Unassigned",tech=roster.find(t=>t.name===agent);
    const cat=r.Ticket_Category||"Uncategorized";
    const dc=pD(r.Date_Closed);
    const dayIdx=dc?weekDays0.findIndex(d=>isSD(d,dc)):-1;
    const tw=parseFloat(r.Time_Taken||"0");
    const timeWorked=(!isNaN(tw)&&tw>0)?tw:0;
    const nrd=pD(r.Next_Respone_Date);
    const frt=parseFloat(r.First_Response_Time);
    const slaTgt=pD(r.SLA_Resolution_Target);
    const dateCreated=pD(r.Date_Created);
    const frd=pD(r.First_Response_Date);
    const status=r.Status||"Closed";
    return{id:r.Ticket_ID||`CL-${i}`,category:cat,type:r.Ticket_Type||"Service",agent,assignedTo:tech?tech.id:0,dayIdx,timeWorked,status,dateClosed:dc,dateCreated,nextResponse:nrd,slaTgt,frd,frt:!isNaN(frt)?frt:null,isClosed:true,dateAssigned:pD(r.Date_Assigned)};
  }).filter(t=>t.dayIdx>=0);

  // Merge closed-this-week tickets into histRaw for KPI processing
  if(closedTix.length){
    // Merge closedRaw into histRaw (avoid duplicates by ID)
    const existingIds=new Set(histRaw.map(r=>r.Ticket_ID));
    closedRaw.forEach(r=>{
      if(r.Ticket_ID&&!existingIds.has(r.Ticket_ID)){
        histRaw.push(r);
        existingIds.add(r.Ticket_ID);
      }
    });
    // Re-process historical data if we added new closed tickets
    if(histRaw.length)procHist();
  }

  actTix=activeRaw.map((r,i)=>{
    const agent=r.Agent_Assigned||"Unassigned",tech=roster.find(t=>t.name===agent);
    const cat=r.Ticket_Category||"Uncategorized",tt=r.Ticket_Type||"Service";
    // Estimation: type+category combo → category-only → 0.5h fallback
    let totalEst=0.5;
    const comboKey=tt+"|"+cat;
    if(BL_COMBO[comboKey]!=null)totalEst=BL_COMBO[comboKey];
    else if(BL_CAT[cat]!=null)totalEst=BL_CAT[cat];
    totalEst=Math.round(totalEst*4)/4;if(totalEst<0.25)totalEst=0.25;

    const nrd=pD(r.Next_Respone_Date);
    const status=r.Status||"New";
    const tw=parseFloat(r.Time_Taken||"0");
    const timeWorked=(!isNaN(tw)&&tw>0)?tw:0;
    const dateCreated=pD(r.Date_Created);
    const slaTgt=pD(r.SLA_Resolution_Target);
    const isWaiting=WAIT_STATUSES.has(status);

    // Calculate remaining estimate
    let est=Math.max(0.25,totalEst-timeWorked);
    est=Math.round(est*4)/4;

    return{id:r.Ticket_ID||`TK-${i}`,category:cat,type:r.Ticket_Type||"Service",priority:mapP(r),est,totalEst,timeWorked,assignedTo:tech?tech.id:0,agent,startHour:8,dayIdx:0,nextResponse:nrd,status,isWaiting,dateCreated,slaTgt,sla:r.SLA||"",source:r.Source||"",dateAssigned:pD(r.Date_Assigned)};
  });

  // Sort by Next Response Date (soonest first), then by status priority
  const stPri={New:1,"Re-Opened":1,"In Progress":2,"Re-Assigned":2,"Client Update":3,"Pending Reply":4,"Pending AM":5,"Pending Vendor":5,"Pending Followup":5,Scheduled:6,Monitoring:7,Closed:8};
  actTix.sort((a,b)=>{
    // Group by agent
    if(a.assignedTo!==b.assignedTo)return a.assignedTo-b.assignedTo;
    // Next response date soonest first
    const an=a.nextResponse?a.nextResponse.getTime():9e15;
    const bn=b.nextResponse?b.nextResponse.getTime():9e15;
    if(an!==bn)return an-bn;
    // Then status priority
    return(stPri[a.status]||5)-(stPri[b.status]||5);
  });

  applyOverrides();
  schedTix();
  if(roster.length&&!selTech){
    if(!loggedInAgent||isCommander){selTech=0}
    else{const me=roster.find(t=>t.name===loggedInAgent);selTech=me?me.id:0}
  }
  setTimeout(()=>{renderSidebar();renderCal();renderRisk();renderPlayerCards();updateBanner();BF.refresh();},0);
}

function schedTix(){
  const now=new Date();
  const nowHour=now.getHours()+now.getMinutes()/60;
  const nowSnapped=Math.ceil(nowHour*4)/4;

  const weekDays=wkD(now);
  const todayDayIdx=weekDays.findIndex(d=>isSD(d,now));
  const startDayIdx=todayDayIdx>=0?todayDayIdx:0;

  // Detect actionable Client Update tickets
  function isActionableClientUpdate(tk){
    return tk.status==="Client Update";
  }

  // Assign a scheduling priority score (lower = schedule sooner)
  // NRD is the primary driver
  // Sort all tickets by agent, then by NRD (oldest first), with Client Update as tiebreaker
  const sorted=[...actTix].sort((a,b)=>{
    if(a.assignedTo!==b.assignedTo)return a.assignedTo-b.assignedTo;
    // Primary: NRD oldest to newest (no NRD = pushed to end)
    const aNrd=a.nextResponse?a.nextResponse.getTime():9e15;
    const bNrd=b.nextResponse?b.nextResponse.getTime():9e15;
    if(aNrd!==bNrd)return aNrd-bNrd;
    // Tiebreaker: actionable Client Updates go before others
    const aCU=isActionableClientUpdate(a)?0:1;
    const bCU=isActionableClientUpdate(b)?0:1;
    if(aCU!==bCU)return aCU-bCU;
    // Final tiebreaker: waiting tickets after active
    const aW=a.isWaiting?1:0;
    const bW=b.isWaiting?1:0;
    return aW-bW;
  });

  // Schedule all tickets per-agent in priority order
  const byA={};
  function placeTicket(tk){
    const s=getSched(tk.assignedTo);
    if(!byA[tk.assignedTo]){
      let startH=Math.max(nowSnapped,s.ss);
      let startD=startDayIdx;
      if(nowSnapped>=s.se){startD=Math.min(startDayIdx+1,4);startH=snap(s.ss)}
      byA[tk.assignedTo]={d:startD,h:snap(startH)};
    }
    const a=byA[tk.assignedTo];
    a.h=snap(a.h);

    // For non-overdue waiting tickets, try to push toward their deadline
    if(tk.isWaiting&&tk.nextResponse&&tk.nextResponse>now){
      const nrdDay=weekDays.findIndex(d=>isSD(d,tk.nextResponse));
      let targetDay=nrdDay>=0?Math.max(startDayIdx,nrdDay-1):4;
      if(tk.slaTgt){const slaDay=weekDays.findIndex(d=>isSD(d,tk.slaTgt));if(slaDay>=0)targetDay=Math.min(targetDay,Math.max(startDayIdx,slaDay-1))}
      if(targetDay>a.d){a.d=targetDay;a.h=snap(s.ss)}
    }

    const dur=Math.ceil(tk.est*4)/4;

    if(a.h>=s.ls&&a.h<s.le)a.h=snap(s.le);
    if(a.h<s.ls&&a.h+dur>s.ls)a.h=snap(s.le);
    if(a.h+dur>s.se){
      a.d=a.d+1;
      a.h=snap(s.ss);
      if(a.h>=s.ls&&a.h<s.le)a.h=snap(s.le);
      if(a.h<s.ls&&a.h+dur>s.ls)a.h=snap(s.le);
    }
    if(a.h>=s.se){
      a.d=a.d+1;
      a.h=snap(s.ss);
    }

    tk.dayIdx=a.d;
    tk.startHour=a.h;
    a.h+=dur;
    if(a.h>s.ls&&a.h<=s.le)a.h=snap(s.le);
  }

  // Place overridden tickets first (they keep their positions), schedule the rest around them
  const ovr=loadOverrides();
  const overridden=sorted.filter(tk=>ovr[tk.id]&&ovr[tk.id].startHour!=null);
  const autoSchedule=sorted.filter(tk=>!ovr[tk.id]||ovr[tk.id].startHour==null);
  // Apply override positions
  overridden.forEach(tk=>{const o=ovr[tk.id];if(o.startHour!=null)tk.startHour=o.startHour;if(o.dayIdx!=null)tk.dayIdx=o.dayIdx;if(o.est!=null)tk.est=o.est});

  // Build occupied time map per agent per day from overridden tickets
  const occupied={};
  overridden.forEach(tk=>{
    const key=tk.assignedTo+"-"+tk.dayIdx;
    if(!occupied[key])occupied[key]=[];
    occupied[key].push({s:tk.startHour,e:tk.startHour+tk.est});
  });

  // Enhanced placeTicket that skips occupied slots
  function placeTicketAround(tk){
    placeTicket(tk);
    // Check if placed position overlaps any overridden ticket
    const key=tk.assignedTo+"-"+tk.dayIdx;
    const occ=occupied[key];
    if(occ){
      let maxTries=20;
      while(maxTries-->0){
        const tkEnd=tk.startHour+tk.est;
        const conflict=occ.find(o=>tk.startHour<o.e&&tkEnd>o.s);
        if(!conflict)break;
        // Jump cursor past the conflicting ticket
        const a=byA[tk.assignedTo];
        a.h=snap(conflict.e);
        const s=getSched(tk.assignedTo);
        if(a.h>=s.ls&&a.h<s.le)a.h=snap(s.le);
        const dur=Math.ceil(tk.est*4)/4;
        if(a.h+dur>s.se){a.d=a.d+1;a.h=snap(s.ss)}
        tk.dayIdx=a.d;tk.startHour=a.h;a.h+=dur;
      }
    }
    // Register this ticket as occupied too (for subsequent auto tickets)
    const key2=tk.assignedTo+"-"+tk.dayIdx;
    if(!occupied[key2])occupied[key2]=[];
    occupied[key2].push({s:tk.startHour,e:tk.startHour+tk.est});
  }

  autoSchedule.forEach(placeTicketAround);

  // Breach detection: compare scheduled end time against NRD
  actTix.forEach(tk=>{
    tk.nrdAtRisk=false;
    if(!tk.nextResponse)return;
    // Calculate the actual datetime of when this ticket finishes on the calendar
    const schedDay=weekDays[tk.dayIdx];
    if(!schedDay)return;
    const endHour=tk.startHour+tk.est;
    const schedEnd=new Date(schedDay);
    schedEnd.setHours(Math.floor(endHour),Math.round((endHour%1)*60),0,0);
    if(schedEnd>tk.nextResponse)tk.nrdAtRisk=true;
    // Also flag if NRD is already past
    if(tk.nextResponse<now)tk.nrdAtRisk=true;
  });
}

function mapP(r){const c=(r.Ticket_Category||"").toLowerCase();if(c.includes("security")||c.includes("threat"))return"High";if(c.includes("network>"))return"High";if(c.includes("password"))return"Low";return"Medium"}



let campaignCharts={};
function killCampaignCharts(){Object.values(campaignCharts).forEach(c=>c.destroy());campaignCharts={}}
function renderCampaignCharts(){
  const ag=document.getElementById("campaignAgent").value;
  const{data:dm,closedEmailWeb,closedPhoneManual,closedOther,assignedEmailWeb,assignedPhoneManual,assignedOther}=getKPIData(ag);
  if(!dm.length)return;killCampaignCharts();const lb=dm.map(d=>d.m);
  Chart.defaults.color="#506a8a";Chart.defaults.borderColor="rgba(0,149,200,0.08)";Chart.defaults.font.family="'Calibri','Arial',sans-serif";
  const co={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:"#506a8a",font:{size:11}},grid:{color:"rgba(0,149,200,0.06)"}},y:{ticks:{color:"#506a8a",font:{size:11}},grid:{color:"rgba(0,149,200,0.06)"}}}};

  // Row 1: Tickets Closed (stacked by source) + Tickets Assigned (stacked by source)
  const totalClosed=closedEmailWeb.reduce((s,v)=>s+v,0)+closedPhoneManual.reduce((s,v)=>s+v,0)+closedOther.reduce((s,v)=>s+v,0);
  campaignCharts.v=new Chart(document.getElementById("cVol"),{type:"bar",data:{labels:lb,datasets:[
    {label:"Email/Web",data:closedEmailWeb,backgroundColor:"rgba(0,149,200,0.5)",borderColor:"#0095C8",borderWidth:1,borderRadius:2},
    {label:"Phone/Manual",data:closedPhoneManual,backgroundColor:"rgba(132,189,0,0.5)",borderColor:"#84BD00",borderWidth:1,borderRadius:2},
    {label:"Other",data:closedOther,backgroundColor:"rgba(162,155,254,0.5)",borderColor:"#a29bfe",borderWidth:1,borderRadius:2}
  ]},options:{...co,plugins:{legend:{display:false},title:{display:true,text:`${totalClosed.toLocaleString()} total`,color:"#506a8a",font:{size:10,weight:"normal"},padding:{bottom:4}}},scales:{...co.scales,x:{...co.scales.x,stacked:true},y:{...co.scales.y,beginAtZero:true,stacked:true}}}});

  const totalAssigned=assignedEmailWeb.reduce((s,v)=>s+v,0)+assignedPhoneManual.reduce((s,v)=>s+v,0)+assignedOther.reduce((s,v)=>s+v,0);
  campaignCharts.assigned=new Chart(document.getElementById("cAssigned"),{type:"bar",data:{labels:lb,datasets:[
    {label:"Email/Web",data:assignedEmailWeb,backgroundColor:"rgba(0,149,200,0.5)",borderColor:"#0095C8",borderWidth:1,borderRadius:2},
    {label:"Phone/Manual",data:assignedPhoneManual,backgroundColor:"rgba(132,189,0,0.5)",borderColor:"#84BD00",borderWidth:1,borderRadius:2},
    {label:"Other",data:assignedOther,backgroundColor:"rgba(162,155,254,0.5)",borderColor:"#a29bfe",borderWidth:1,borderRadius:2}
  ]},options:{...co,plugins:{legend:{display:false},title:{display:true,text:`${totalAssigned.toLocaleString()} total`,color:"#506a8a",font:{size:10,weight:"normal"},padding:{bottom:4}}},scales:{...co.scales,x:{...co.scales.x,stacked:true},y:{...co.scales.y,beginAtZero:true,stacked:true}}}});

  // Response SLA % + Resolution SLA % (color based on weekly average)
  const respSlaData=dm.map(d=>d.respSlaPct);
  const validRespSla=respSlaData.filter(v=>v!==null);
  const weekRespSla=validRespSla.length?validRespSla.reduce((a,b)=>a+b,0)/validRespSla.length:100;
  const rSlaColor=weekRespSla>=90?"#84BD00":weekRespSla>=80?"#fcdc00":"#fb9e00";
  const rSlaBg=weekRespSla>=90?"rgba(132,189,0,0.08)":weekRespSla>=80?"rgba(251,158,0,0.08)":"rgba(255,92,92,0.08)";
  campaignCharts.rSla=new Chart(document.getElementById("cRespSla"),{type:"line",data:{labels:lb,datasets:[{data:respSlaData,borderColor:rSlaColor,backgroundColor:rSlaBg,tension:.4,pointRadius:4,pointBackgroundColor:rSlaColor,pointBorderColor:"#001a3a",pointBorderWidth:2,borderWidth:2.5,fill:true,spanGaps:true}]},options:{...co,scales:{...co.scales,y:{...co.scales.y,beginAtZero:true,max:105}}}});

  const resSlaData=dm.map(d=>d.resSlaPct);
  const validResSla=resSlaData.filter(v=>v!==null);
  const weekResSla=validResSla.length?validResSla.reduce((a,b)=>a+b,0)/validResSla.length:100;
  const dSlaColor=weekResSla>=90?"#84BD00":weekResSla>=80?"#fcdc00":"#fb9e00";
  const dSlaBg=weekResSla>=90?"rgba(132,189,0,0.08)":weekResSla>=80?"rgba(251,158,0,0.08)":"rgba(255,92,92,0.08)";
  campaignCharts.dSla=new Chart(document.getElementById("cResSla"),{type:"line",data:{labels:lb,datasets:[{data:resSlaData,borderColor:dSlaColor,backgroundColor:dSlaBg,tension:.4,pointRadius:4,pointBackgroundColor:dSlaColor,pointBorderColor:"#001a3a",pointBorderWidth:2,borderWidth:2.5,fill:true,spanGaps:true}]},options:{...co,scales:{...co.scales,y:{...co.scales.y,beginAtZero:true,max:105}}}});

}

function populateCampaignFilters(){
  const aSel=document.getElementById("campaignAgent");
  const agents=[...new Set(histRaw.map(r=>r.Agent_Resolved||r.Agent_Assigned).filter(a=>a&&a!=="Unassigned"&&!a.includes("Bot")))].sort();
  aSel.innerHTML=`<option value="">— All Agents (${agents.length}) —</option>`+agents.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join("");
}

// ═══════════ KPI AGENT SELECTOR ═══════════
function populateKPIClients(){
  const aSel=document.getElementById("kpiAgent");
  const prevAgent=aSel.value;
  const agents=[...new Set(histRaw.map(r=>r.Agent_Resolved||r.Agent_Assigned).filter(a=>a&&a!=="Unassigned"&&!a.includes("Bot")))].sort();
  aSel.innerHTML=`<option value="">— All Agents (${agents.length}) —</option>`+agents.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join("");
  if(prevAgent)aSel.value=prevAgent;
}



function getKPIData(overrideAg){
  const ag=overrideAg!==undefined?overrideAg:document.getElementById("kpiAgent").value;
  const csatMap2={excellent:4,good:3,okay:2,poor:1,bad:1};

  // Build daily data Mon-Fri for charts
  const weekDays=wkD(new Date());
  const dayLabels=weekDays.map(d=>d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}));

  // Closed tickets filtered
  const filtered=histRaw.filter(r=>{
    const dc=pD(r.Date_Closed);if(!dc)return false;
    if(!weekDays.some(wd=>isSD(wd,dc)))return false;
    if(ag&&(r.Agent_Resolved||r.Agent_Assigned)!==ag)return false;
    return true;
  });

  // Closed per day with source breakdown
  const closedEmailWeb=weekDays.map(wd=>filtered.filter(r=>{const dc=pD(r.Date_Closed);if(!dc||!isSD(dc,wd))return false;const src=(r.Source||"").toUpperCase();return src.includes("EMAIL")||src.includes("WEB")}).length);
  const closedPhoneManual=weekDays.map(wd=>filtered.filter(r=>{const dc=pD(r.Date_Closed);if(!dc||!isSD(dc,wd))return false;const src=(r.Source||"").toUpperCase();return src.includes("PHONE")||src.includes("MANUAL")}).length);
  const closedOther=weekDays.map(wd=>filtered.filter(r=>{const dc=pD(r.Date_Closed);if(!dc||!isSD(dc,wd))return false;const src=(r.Source||"").toUpperCase();return!src.includes("EMAIL")&&!src.includes("WEB")&&!src.includes("PHONE")&&!src.includes("MANUAL")}).length);

  // Daily metrics: response based on Date_Assigned, resolution based on Date_Closed
  const daily=weekDays.map((wd,di)=>{
    // Response metrics: tickets assigned on this day
    const assignedDay=actRaw.filter(r=>{
      const da=pD(r.Date_Assigned);if(!da||!isSD(da,wd))return false;
        if(ag&&(r.Agent_Assigned)!==ag)return false;
      return true;
    });
    const rt=[];let fm=0,ft=0;
    assignedDay.forEach(r=>{
      const frt=parseFloat(r.First_Response_Time);
      if(!isNaN(frt)&&frt>=0){rt.push(frt);ft++;if(frt<=FRT_SLA)fm++}
    });

    // Resolution metrics: tickets closed on this day
    const closedDay=filtered.filter(r=>{const dc=pD(r.Date_Closed);return dc&&isSD(dc,wd)});
    const rd=[];let sm=0,st=0;let csatArr=[];
    closedDay.forEach(r=>{
      const da=pD(r.Date_Assigned),dc=pD(r.Date_Closed);
      if(da&&dc){const bd=bizD(da,dc);if(bd>=0&&bd<500)rd.push(bd)}
      const sl=pD(r.SLA_Resolution_Target);
      if(dc&&sl){st++;if(dc<=sl)sm++}
      const csatRaw=(r.CSAT_Score||"").trim();
      const csatNum=csatMap2[csatRaw.toLowerCase()];
      if(csatNum)csatArr.push(csatNum);
    });
    const csatBk={4:0,3:0,2:0,1:0};csatArr.forEach(v=>{if(csatBk[v]!==undefined)csatBk[v]++});
    return{
      m:dayLabels[di],mk:di,v:closedDay.length,
      ar:rt.length?rt.reduce((a,c)=>a+c,0)/rt.length:0,
      ard:rd.length?rd.reduce((a,c)=>a+c,0)/rd.length:0,
      respSlaPct:ft?(fm/ft*100):null,
      resSlaPct:st?(sm/st*100):null,
      csatN:csatArr.length,csatBk,
      closedN:closedDay.length
    };
  });

  // Tickets assigned per day with source breakdown
  const assignedFiltered=actRaw.filter(r=>{
    const da=pD(r.Date_Assigned);if(!da)return false;
    if(!weekDays.some(wd=>isSD(wd,da)))return false;
    if(ag&&(r.Agent_Assigned)!==ag)return false;
    return true;
  });
  const assignedEmailWeb=weekDays.map(wd=>assignedFiltered.filter(r=>{const da=pD(r.Date_Assigned);if(!da||!isSD(da,wd))return false;const src=(r.Source||"").toUpperCase();return src.includes("EMAIL")||src.includes("WEB")}).length);
  const assignedPhoneManual=weekDays.map(wd=>assignedFiltered.filter(r=>{const da=pD(r.Date_Assigned);if(!da||!isSD(da,wd))return false;const src=(r.Source||"").toUpperCase();return src.includes("PHONE")||src.includes("MANUAL")}).length);
  const assignedOther=weekDays.map(wd=>assignedFiltered.filter(r=>{const da=pD(r.Date_Assigned);if(!da||!isSD(da,wd))return false;const src=(r.Source||"").toUpperCase();return!src.includes("EMAIL")&&!src.includes("WEB")&&!src.includes("PHONE")&&!src.includes("MANUAL")}).length);

  // Ticket type counts
  const typeCounts={};
  assignedFiltered.forEach(r=>{const tt=r.Ticket_Type||"Other";typeCounts[tt]=(typeCounts[tt]||0)+1});

  // Top 5 ticket categories (from assigned tickets this period)
  const catCounts={};
  assignedFiltered.forEach(r=>{const cat=r.Ticket_Category||"Uncategorized";catCounts[cat]=(catCounts[cat]||0)+1});
  const topCats=Object.entries(catCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);

  return{data:daily,closedEmailWeb,closedPhoneManual,closedOther,assignedEmailWeb,assignedPhoneManual,assignedOther,typeCounts,topCats,source:ag?"agent":"all",agentName:ag};
}

// ═══════════ TECH SIDEBAR ═══════════
let openSchedTech=null;
let _dragCancel=null; // abort any in-progress calendar drag
function renderSidebar(){
  const l=document.getElementById("tl");
  if(!roster.length){l.innerHTML='<p style="color:var(--text-dim);font-size:11px;font-style:italic">Upload active tickets</p>';return}
  const all=[{id:0,name:"Unassigned",color:"var(--gray)"},...roster];
  const sO=SHIFTS.map((o,i)=>`<option value="${i}">${o.l}</option>`).join("");
  const lO=LUNCHES.map((o,i)=>`<option value="${i}">${o.l}</option>`).join("");
  // Find today's day index for "hours today" calculation
  const weekDays2=wkD(new Date());
  const todayIdx2=weekDays2.findIndex(d=>isSD(d,new Date()));
  const now2=new Date();
  const nowH=now2.getHours()+now2.getMinutes()/60;

  l.innerHTML=all.map(t=>{
    const tt=actTix.filter(x=>x.assignedTo===t.id);
    const totalTix=tt.length;
    // Hours today = estimated hours from tickets with NRD due today (regardless of calendar placement)
    const today=new Date();
    const nrdTodayTix=tt.filter(x=>x.nextResponse&&isSD(x.nextResponse,today));
    const hoursToday=nrdTodayTix.reduce((s,x)=>s+x.est,0);
    const atRisk=tt.filter(x=>x.nrdAtRisk).length;

    // Calculate remaining shift hours today
    const sc=getSched(t.id);
    let remainingHrs=0;
    if(nowH<sc.se){
      remainingHrs=sc.se-Math.max(nowH,sc.ss);
      if(nowH<sc.le&&sc.ls<sc.le)remainingHrs-=Math.max(0,Math.min(sc.le,sc.se)-Math.max(sc.ls,Math.max(nowH,sc.ss)));
    }

    // Color logic for hours today: can the tech finish NRD-due-today work in remaining shift?
    let hoursColor="#84BD00"; // green - has time
    if(hoursToday>0&&remainingHrs>0&&hoursToday>remainingHrs)hoursColor="#fb9e00"; // red - more work due than time left
    else if(hoursToday>0&&remainingHrs>0&&hoursToday>=remainingHrs*0.8)hoursColor="#fcdc00"; // orange - tight fit
    // SLA risk color: 0=green, >=1 orange, >=4 red
    const riskColor=atRisk>=4?"#fb9e00":atRisk>=1?"#fcdc00":"#84BD00";
    // Active tix color: >=0 green, >=8 orange, >=16 red
    const tixColor=totalTix>=16?"#fb9e00":totalTix>=8?"#fcdc00":"#84BD00";

    // New tickets today (created today, assigned to this tech - both active and closed)
    const newTodayActive=tt.filter(x=>x.dateAssigned&&isSD(x.dateAssigned,today)).length;
    const newTodayClosed=closedTix.filter(x=>x.assignedTo===t.id&&x.dateAssigned&&isSD(x.dateAssigned,today)).length;
    const newToday=newTodayActive+newTodayClosed;
    // Closed tickets today
    const closedToday=closedTix.filter(x=>x.assignedTo===t.id&&x.dateClosed&&isSD(x.dateClosed,today)).length;
    // New today color: >=0 green, >=8 orange, >=16 red
    const newTodayColor=newToday>=16?"#fb9e00":newToday>=8?"#fcdc00":"#84BD00";
    // Closed today color: >=0 red, >=5 orange, >=8 green, >=11 blue
    const closedTodayColor=closedToday>=11?"#00E5FF":closedToday>=8?"#84BD00":closedToday>=5?"#fcdc00":"#fb9e00";

    const a=selTech===t.id;
    const isReal=t.id>0;
    const gearBtn=isReal?`<button class="tech-gear" data-g="${t.id}" title="Schedule"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>`:"";
    const riskText=atRisk>0?` · <span style="color:${riskColor}">${atRisk} at risk</span>`:"";
    const totalHrs=tt.reduce((s,x)=>s+x.est,0);
    // Total hours color: >=6 red, >=4 orange, <4 green
    const totalHrsColor=totalHrs>=6?"#fb9e00":totalHrs>=4?"#fcdc00":"#84BD00";
    let html=`<div class="tech-option ${a?"active":""}" data-t="${t.id}"><div class="tech-radio" style="${a?`background:${t.color};border-color:${t.color}`:""}"><div class="tech-radio-inner" style="background:white"></div></div><div style="min-width:0;flex:1"><div class="tname">${esc(t.name)}</div><div class="thours"><span style="color:${tixColor}">${totalTix} act</span> · <span style="color:${totalHrsColor}">${totalHrs.toFixed(1)}h est</span></div><div class="thours"><span style="color:${newTodayColor}">${newToday} new</span> · <span style="color:${hoursColor}">${hoursToday.toFixed(1)}h due</span></div></div>${gearBtn}</div>`;
    if(isReal&&openSchedTech===t.id){
      const s=getSched(t.id),si=s.si!=null?s.si:1,li=s.li!=null?s.li:1;
      html+=`<div class="tech-sched-panel" data-sp="${t.id}"><label>Shift</label><select data-t="${t.id}" data-f="s">${sO.replace(`value="${si}"`,`value="${si}" selected`)}</select><label>Lunch</label><select data-t="${t.id}" data-f="l">${lO.replace(`value="${li}"`,`value="${li}" selected`)}</select></div>`;
    }
    return html;
  }).join("");
  // Bind tech selection (click on the option row, but not the gear)
  l.querySelectorAll(".tech-option").forEach(el=>{el.addEventListener("click",e=>{
    if(e.target.closest(".tech-gear"))return;
    selTech=parseInt(el.dataset.t);renderSidebar();renderCal();
  })});
  // Bind gear buttons
  l.querySelectorAll(".tech-gear").forEach(btn=>{btn.addEventListener("click",e=>{
    e.stopPropagation();
    const tid=parseInt(btn.dataset.g);
    openSchedTech=openSchedTech===tid?null:tid;
    renderSidebar();
  })});
  // Bind schedule dropdowns
  l.querySelectorAll(".tech-sched-panel select").forEach(sel=>{sel.addEventListener("click",e=>e.stopPropagation());sel.addEventListener("change",e=>{
    const tid=parseInt(e.target.dataset.t),f=e.target.dataset.f,v=parseInt(e.target.value);
    if(!techSched[tid])techSched[tid]={ss:SHIFTS[1].s,se:SHIFTS[1].e,ls:LUNCHES[1].s,le:LUNCHES[1].e,si:1,li:1};
    if(f==="s"){const o=SHIFTS[v];techSched[tid].ss=o.s;techSched[tid].se=o.e;techSched[tid].si=v}
    if(f==="l"){const o=LUNCHES[v];techSched[tid].ls=o.s;techSched[tid].le=o.e;techSched[tid].li=v}
    schedTix();renderCal();
    const tech=roster.find(t=>t.id===tid);
    if(tech){const sb={agent_name:tech.name};if(f==="s")sb.shift_slot=v;if(f==="l")sb.lunch_slot=v;fetchRetry(PROXY_BASE+"/api/agent-schedules",{method:"PATCH",headers:authH(),body:JSON.stringify(sb)}).catch(err=>console.error("Schedule save error:",err));}
  })});
  // ── Reset calendar button ─────────────────────────────
  const actionsEl=document.getElementById("tl-actions");
  if(actionsEl){
    const ovr=loadOverrides();
    const hasOvr=selTech&&actTix.some(t=>t.assignedTo===selTech&&ovr[t.id]);
    const bs=`width:100%;margin-bottom:8px;padding:9px 16px;font-size:12px;font-weight:600;font-family:var(--font-body);border-radius:8px;display:inline-flex;align-items:center;justify-content:center;transition:all .25s;`;
    actionsEl.innerHTML=hasOvr
      ?`<button id="resetCalBtn" style="${bs}background:rgba(0,149,200,0.1);border:1px solid var(--border-bright);color:var(--blue);cursor:pointer" onmouseenter="this.style.background='rgba(0,149,200,0.2)';this.style.borderColor='var(--blue)'" onmouseleave="this.style.background='rgba(0,149,200,0.1)';this.style.borderColor='var(--border-bright)'">Reset Calendar</button>`
      :`<button disabled style="${bs}background:rgba(0,149,200,0.04);border:1px solid rgba(108,108,108,0.2);color:var(--text-dim);cursor:default;opacity:0.5">Reset Calendar</button>`;
    if(hasOvr)document.getElementById("resetCalBtn").addEventListener("click",()=>{
      const o=loadOverrides();
      actTix.filter(t=>t.assignedTo===selTech).forEach(t=>{deleteTicketOverride(t.id);delete o[t.id];});
      saveOverrides(o);
      procAct();
    });
  }
}

// ═══════════ CALENDAR ═══════════
function renderCal(){
  const area=document.getElementById("ca");
  if(!actTix.length){area.innerHTML='<div class="glass" style="padding:40px;text-align:center;color:var(--text-dim)">Upload active tickets</div>';return}
  const weekDays=wkD(new Date());
  const days=weekDays;
  const gh=(EH-SH)*HH,sc=getSched(selTech||1);
  const dtm=days.map((_,di)=>actTix.filter(t=>t.assignedTo===selTech&&t.dayIdx===di));
  const calOvr=loadOverrides();

  let h=`<div class="tcw"><div class="tch"><div class="tg"></div>`;
  days.forEach((day,di)=>{const tks=dtm[di],th=tks.reduce((s,t)=>s+t.est,0),td=isT(day);h+=`<div class="dch ${td?"today":""}"><div class="dn">${fDS(day)}</div><div class="dd">${fD(day)}</div><div class="ds">${tks.length} tix · ${th.toFixed(1)}h</div></div>`});
  h+=`</div><div class="tcb"><div class="tgut" style="height:${gh}px">`;
  for(let hr=SH+.5;hr<EH;hr+=.5)h+=`<div class="tl${hr===Math.floor(hr)?"":" half"}" style="top:${hY(hr)}px">${hT(hr)}</div>`;
  h+=`</div><div class="dcw">`;
  for(let hr=SH;hr<=EH;hr++){h+=`<div class="hl" style="top:${hY(hr)}px"></div>`;if(hr<EH){h+=`<div class="hhl" style="top:${hY(hr+.25)}px"></div>`;h+=`<div class="hhl" style="top:${hY(hr+.5)}px"></div>`;h+=`<div class="hhl" style="top:${hY(hr+.75)}px"></div>`}}
  days.forEach((day,di)=>{
    const tks=dtm[di];
    h+=`<div class="dc" data-d="${di}" style="height:${gh}px">`;
    if(selTech!==0){
      if(sc.ss>SH)h+=`<div class="shift-off" style="top:0;height:${hY(sc.ss)}px"></div>`;
      h+=`<div class="lunch-block" style="top:${hY(sc.ls)}px;height:${(sc.le-sc.ls)*HH}px"><span class="lunch-label">Lunch</span></div>`;
      if(sc.se<EH)h+=`<div class="shift-off" style="top:${hY(sc.se)}px;height:${(EH-sc.se)*HH}px"></div>`;
    }
    if(isT(day)){const n=new Date(),nh=n.getHours()+n.getMinutes()/60;if(nh>=SH&&nh<=EH)h+=`<div class="now-line" style="top:${hY(nh)}px"></div>`}
    tks.forEach(tk=>{
      const top=hY(tk.startHour),ht=tk.est*HH;
      const stC=SC[tk.status]||"var(--text-dim)";
      const endH=tk.startHour+tk.est;
      const nrd=tk.nextResponse?tk.nextResponse.toLocaleDateString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"—";
      const popSide=(di>=3?"pop-left":"")+" "+(tk.startHour>=14?"pop-bottom":"");
      const riskClass=tk.nrdAtRisk?"nrd-risk":"";
      const nrdColor=tk.nrdAtRisk?"color:var(--danger);font-weight:700":"";
      const isOvr=!!calOvr[tk.id];
      h+=`<div class="tt ${riskClass}${isOvr?' tt-override':''}" data-id="${esc(tk.id)}" data-d="${di}" style="top:${top}px;height:${ht}px;border-left-color:${stC}">
        <div class="tt-inner">
          <div class="tt-row1"><span class="ti">${esc(tk.id)}</span>${isOvr?'<span class="tt-override-star">★</span>':''}<span class="tit" style="color:${stC}">${esc(tk.status)}</span></div>
          <div class="tt-row2"><span class="tc">${esc(tk.category)}</span><span class="te">${tk.est}h</span></div>
        </div>
        <div class="tt-popup ${popSide}">
          <div class="pop-time">${hT(tk.startHour)} — ${hT(endH)}</div>
          <div class="pop-row"><span class="pop-label">Ticket</span><span class="pop-val">${esc(tk.id)}</span></div>
          <div class="pop-row"><span class="pop-label">Status</span><span class="pop-val" style="color:${stC}">${esc(tk.status)}</span></div>
          <div class="pop-row"><span class="pop-label">Category</span><span class="pop-val">${esc(tk.category)}</span></div>
          <div class="pop-row"><span class="pop-label">Type</span><span class="pop-val">${esc(tk.type)}</span></div>
          <div class="pop-row"><span class="pop-label">Time Worked</span><span class="pop-val">${tk.timeWorked.toFixed(1)}h</span></div>
          <div class="pop-row"><span class="pop-label">Est. Remaining</span><span class="pop-val" style="color:var(--green)">${tk.est}h</span></div>
          <div class="pop-row"><span class="pop-label">Next Response</span><span class="pop-val" style="${nrdColor}">${nrd}</span></div>
        </div>
        <div class="tt-resize-handle"></div>
      </div>`;
    });
    h+=`</div>`;
  });
  h+=`</div></div>`;

  // Closed-this-week section: collapsible, defaults to collapsed
  const anyClosedForTech=closedTix.some(t=>t.assignedTo===selTech);
  if(anyClosedForTech){
    const closedHt=0.25*HH;
    // Toggle header row
    h+=`<div style="border-top:1px solid var(--border-bright)">`;
    h+=`<div onclick="this.parentElement.classList.toggle('closed-expanded');this.querySelector('.closed-chev').classList.toggle('closed-chev-open')" style="cursor:pointer;padding:6px 12px;display:flex;align-items:center;gap:6px;user-select:none">`;
    h+=`<svg class="closed-chev" style="width:10px;height:10px;flex-shrink:0;transition:transform 0.2s;color:var(--text-dim)" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    h+=`<span style="font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--text-dim)">Closed</span>`;
    h+=`</div>`;
    // Closed tickets table (hidden by default)
    h+=`<div class="closed-body">`;
    h+=`<table style="width:100%;border-collapse:collapse;table-layout:fixed"><colgroup><col style="width:70px">`;
    for(let d=0;d<5;d++)h+=`<col>`;
    h+=`</colgroup><tr><td></td>`;
    days.forEach((day,di)=>{
      const closedDay=closedTix.filter(t=>t.assignedTo===selTech&&t.dayIdx===di);
      h+=`<td style="vertical-align:top;padding:4px 0;border-left:1px solid rgba(0,149,200,0.08)">`;
      closedDay.forEach(ct=>{
        const stC=SC[ct.status]||"#999999";
        const closedDate=ct.dateClosed?ct.dateClosed.toLocaleDateString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"—";
        const popSide=(di>=3?"pop-left":"")+" pop-bottom";
        h+=`<div class="tt tt-closed" style="height:${closedHt}px;border-left-color:${stC}">
        <div class="tt-inner">
          <div class="tt-row1"><span class="ti">${esc(ct.id)}</span><span class="tit" style="color:#999">Closed</span></div>
          <div class="tt-row2"><span class="tc">${esc(ct.category)}</span><span class="te">${ct.timeWorked.toFixed(2)}h</span></div>
        </div>
        <div class="tt-popup ${popSide}">
          <div class="pop-time">Closed ${closedDate}</div>
          <div class="pop-row"><span class="pop-label">Ticket</span><span class="pop-val">${esc(ct.id)}</span></div>
          <div class="pop-row"><span class="pop-label">Status</span><span class="pop-val" style="color:#999">Closed</span></div>
          <div class="pop-row"><span class="pop-label">Category</span><span class="pop-val">${esc(ct.category)}</span></div>
          <div class="pop-row"><span class="pop-label">Time Worked</span><span class="pop-val">${ct.timeWorked.toFixed(1)}h</span></div>
        </div>
      </div>`;
      });
      h+=`</td>`;
    });
    h+=`</tr></table></div></div>`;
  }

  h+=`</div>`;
  if(_dragCancel){_dragCancel();_dragCancel=null;}
  area.innerHTML=h;
  _bindCalDrag(area);
}

// ── Drag-to-reposition and resize for calendar tickets ───────────────────────
function _bindCalDrag(area){
  const cols=Array.from(area.querySelectorAll('.dc[data-d]'));
  function getCol(x){return cols.find(c=>{const r=c.getBoundingClientRect();return x>=r.left&&x<=r.right})||null}
  function clampHour(h,est){return Math.max(SH,Math.min(EH-est,Math.round(h*4)/4))}
  area.querySelectorAll('.tt').forEach(el=>{
    const tid=el.dataset.id,tk=actTix.find(t=>t.id===tid);if(!tk)return;
    // ── Resize ──────────────────────────────────────────────
    const handle=el.querySelector('.tt-resize-handle');
    if(handle){
      let rs=null;
      handle.addEventListener('pointerdown',e=>{e.stopPropagation();e.preventDefault();handle.setPointerCapture(e.pointerId);rs={origY:e.clientY,origEst:tk.est}});
      handle.addEventListener('pointermove',e=>{
        if(!rs)return;
        const ne=Math.max(0.25,Math.round((rs.origEst+(e.clientY-rs.origY)/HH)*4)/4);
        el.style.height=(ne*HH)+'px';
        const te=el.querySelector('.te');if(te)te.textContent=ne+'h';
        const pt=el.querySelector('.pop-time');if(pt)pt.textContent=hT(tk.startHour)+' — '+hT(tk.startHour+ne);
      });
      handle.addEventListener('pointerup',e=>{
        if(!rs)return;
        const ne=Math.max(0.25,Math.round((rs.origEst+(e.clientY-rs.origY)/HH)*4)/4);
        rs=null;
        setOverride(tk.id,{est:ne,dayIdx:tk.dayIdx,startHour:tk.startHour});
        setTimeout(()=>{schedTix();renderCal();renderSidebar();},0);
      });
    }
    // ── Drag ────────────────────────────────────────────────
    let ds=null,ghost=null;
    el.addEventListener('pointerdown',e=>{
      if(e.target.closest('.tt-resize-handle')||e.target.closest('.tt-popup')||e.button!==0)return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const rect=el.getBoundingClientRect();
      ds={offsetY:e.clientY-rect.top,startX:e.clientX,startY:e.clientY,moved:false,rect};
      _dragCancel=()=>{if(ghost){ghost.remove();ghost=null;}el.style.opacity='';document.body.style.cursor='';ds=null;};
    });
    el.addEventListener('pointermove',e=>{
      if(!ds)return;
      if(!ds.moved&&Math.abs(e.clientX-ds.startX)+Math.abs(e.clientY-ds.startY)>5){
        ds.moved=true;
        ghost=el.cloneNode(true);
        ghost.style.cssText=`position:fixed;width:${ds.rect.width}px;height:${ds.rect.height}px;top:${ds.rect.top}px;left:${ds.rect.left}px;opacity:0.8;pointer-events:none;z-index:9999;transition:none;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.5)`;
        document.body.appendChild(ghost);
        el.style.opacity='0.2';
        document.body.style.cursor='grabbing';
      }
      if(!ds.moved||!ghost)return;
      const col=getCol(e.clientX);
      ghost.style.top=(e.clientY-ds.offsetY)+'px';
      if(col){const r=col.getBoundingClientRect();ghost.style.left=r.left+'px';ghost.style.width=(r.width-6)+'px';}
    });
    el.addEventListener('pointerup',e=>{
      if(!ds)return;
      if(ghost){ghost.remove();ghost=null;}
      el.style.opacity='';
      document.body.style.cursor='';
      _dragCancel=null;
      if(ds.moved){
        const col=getCol(e.clientX);
        if(col){
          const cr=col.getBoundingClientRect();
          const rawH=SH+(e.clientY-ds.offsetY-cr.top)/HH;
          setOverride(tk.id,{dayIdx:parseInt(col.dataset.d),startHour:clampHour(rawH,tk.est),est:tk.est});
          setTimeout(()=>{schedTix();renderCal();renderSidebar();},0);
        }
      }
      ds=null;
    });
    el.addEventListener('pointercancel',()=>{
      if(ghost){ghost.remove();ghost=null;}
      el.style.opacity='';
      document.body.style.cursor='';
      _dragCancel=null;
      ds=null;
    });
  });
}

// ═══════════ PLAYER CARDS (GAMIFICATION) ═══════════
function getAgentClass(tech, weekDays) {
  // Ticket pool: assigned AND closed within current Mon-Fri week, by same agent
  const pool = closedTix.filter(t =>
    t.agent === tech.name &&
    t.dateClosed &&
    t.dateAssigned &&
    weekDays.some(d => isSD(d, t.dateClosed)) &&
    weekDays.some(d => isSD(d, t.dateAssigned))
  );

  // Step 1 — Recruit: no qualifying tickets
  if (pool.length === 0) return { name: 'Recruit', icon: '🎖️' };

  // Step 2 — Commander: overrides everything except Recruit
  if (commanderAgentNames.includes(tech.name)) return { name: 'Commander', icon: '👑' };

  // Step 3 — Calculate average Time_Taken across pool
  const avgTime = pool.reduce((sum, t) => sum + (t.timeWorked || 0), 0) / pool.length;

  // Step 4 — Tank: average time strictly greater than 0.60h
  if (avgTime > 0.60) return { name: 'Tank', icon: '🛡️' };

  // Step 5 — Soldier: average time 0.60h or under
  return { name: 'Soldier', icon: '🪖' };
}

function renderPlayerCards(){
  const section=document.getElementById("playerCards");
  const grid=document.getElementById("playerGrid");
  if(!roster.length){section.classList.add("hidden");return}
  section.classList.remove("hidden");

  const today=new Date();
  const weekDays=wkD(today);

  const cards=roster.map(t=>{
    const tt=actTix.filter(x=>x.assignedTo===t.id);
    const totalTix=tt.length;
    const totalHrs=tt.reduce((s,x)=>s+x.est,0);
    const atRisk=tt.filter(x=>x.nrdAtRisk).length;

    // HP: 100 max, deductions for workload
    let hp=100;
    hp-=totalTix*3;    // -3 per active ticket
    hp-=totalHrs*3;    // -3 per est hour

    // XP/Level: from closed tickets this week
    let totalXP=0;
    const techClosed=closedTix.filter(x=>x.assignedTo===t.id);
    // Also check histRaw for this tech's closed tickets this week
    const techClosedHist=histRaw.filter(r=>{
      const ag=r.Agent_Resolved||r.Agent_Assigned;
      if(ag!==t.name)return false;
      const dc=pD(r.Date_Closed);if(!dc)return false;
      return weekDays.some(wd=>isSD(wd,dc));
    });
    techClosedHist.forEach(r=>{
      // Base XP
      let xp=25;
      // Bonus: First response time
      const frt=parseFloat(r.First_Response_Time);
      if(!isNaN(frt)&&frt>=0){
        if(frt<=2)xp+=10;
        else if(frt<=4)xp+=5;
      }
      // Bonus: Same-day resolution (First_Response_Date same day as Date_Closed)
      const frd=pD(r.First_Response_Date);
      const dc=pD(r.Date_Closed);
      if(frd&&dc&&isSD(frd,dc))xp+=10;
      // Bonus: Closed within 5 days (Date_Created to Date_Closed)
      const cr=pD(r.Date_Created);
      if(cr&&dc){
        const diffDays=(dc-cr)/(1000*60*60*24);
        if(diffDays<=5)xp+=5;
      }
      totalXP+=xp;
    });
    hp=Math.max(0,Math.min(100,Math.round(hp)));

    const level=Math.floor(totalXP/100);
    const xpInLevel=totalXP%100;

    // Rank colors: ASPIRING SLAYER=red, HURT ME PLENTY=orange, ULTRA VIOLENCE=green, NIGHTMARE=blue
    let rank,rankColor,rankBg;
    if(level>=25){rank="NIGHTMARE";rankColor="#00E5FF";rankBg="rgba(0,229,255,0.15)"}
    else if(level>=18){rank="ULTRA VIOLENCE";rankColor="#84BD00";rankBg="rgba(132,189,0,0.15)"}
    else if(level>=11){rank="HURT ME PLENTY";rankColor="#fcdc00";rankBg="rgba(252,220,0,0.15)"}
    else{rank="ASPIRING SLAYER";rankColor="#fb9e00";rankBg="rgba(251,158,0,0.15)"}

    // HP bar color
    let hpColor,hpBg;
    if(hp>=60){hpColor="#84BD00";hpBg="rgba(132,189,0,0.8)"}
    else if(hp>=30){hpColor="#fcdc00";hpBg="rgba(251,158,0,0.8)"}
    else{hpColor="#fb9e00";hpBg="rgba(255,92,92,0.8)"}

    const agentClass=getAgentClass(t,weekDays);
    return{tech:t,hp,hpColor,hpBg,level,xpInLevel,totalXP,rank,rankColor,rankBg,totalTix,agentClass};
  });

  // Sort by HP ascending (most overwhelmed first)
  cards.sort((a,b)=>a.hp-b.hp);

  grid.innerHTML=cards.map(c=>{
    const canvasId="pcardRobot_"+c.tech.name.replace(/\s+/g,"_");
    const rCfg=getRobotConfigForAgent(c.tech.name);
    const rName=rCfg.robot_name||"Agent";
    return`
    <div class="pcard">
      <div class="pcard-header">
        <div>
          <div class="pcard-name">${esc(c.tech.name)}</div>
          <div class="pcard-class">${esc(c.agentClass.name)}</div>
          <div class="pcard-level">Lvl ${c.level}</div>
        </div>
        <span class="pcard-rank" style="color:${c.rankColor};background:${c.rankBg};border:1px solid ${c.rankColor}30${c.rank==="NIGHTMARE"?";text-shadow:0 0 8px "+c.rankColor+";box-shadow:0 0 12px "+c.rankColor+"40":""}">${c.rank}</span>
      </div>
      <div class="pcard-bar-label"><span style="color:${c.hpColor}">HP</span><span style="color:${c.hpColor}">${c.hp}/100</span></div>
      <div class="pcard-bar-wrap">
        <div class="pcard-bar" style="width:${c.hp}%;background:linear-gradient(90deg,${c.hpBg},${c.hpColor})"></div>
      </div>
      <div class="pcard-bar-label"><span style="color:#0095C8">XP</span><span style="color:#0095C8">${c.xpInLevel}/100</span></div>
      <div class="pcard-bar-wrap">
        <div class="pcard-bar" style="width:${c.xpInLevel}%;background:linear-gradient(90deg,rgba(0,149,200,0.6),#0095C8)"></div>
      </div>
      <div style="text-align:center;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">
        <canvas id="${canvasId}" width="160" height="120" style="image-rendering:pixelated"></canvas>
        <div style="font-size:9px;color:var(--text-muted);font-family:'IBM Plex Mono',monospace;margin-top:0">${esc(rName)}</div>
      </div>
      <div class="pcard-icon">${c.agentClass.icon}</div>
    </div>`;
  }).join("");

  // Render robot previews on player cards
  requestAnimationFrame(()=>{
    cards.forEach(c=>{
      const canvasId="pcardRobot_"+c.tech.name.replace(/\s+/g,"_");
      const cvs=document.getElementById(canvasId);
      if(!cvs)return;
      const ctx=cvs.getContext("2d");
      const rCfg=getRobotConfigForAgent(c.tech.name);
      drawRobot(ctx,cvs.width,cvs.height,rCfg,4);
    });
  });

  // ── Commander Cards ──
  const cmdSection=document.getElementById("commanderCards");
  const cmdGrid=document.getElementById("commanderGrid");
  const cmdNames=commanderAgentNames.filter(n=>!roster.some(r=>r.name===n));
  if(!cmdNames.length){cmdSection.classList.add("hidden");return}
  cmdSection.classList.remove("hidden");

  const cmdRankColor="#FFD700";
  const cmdRankBg="rgba(255,215,0,0.15)";

  cmdGrid.innerHTML=cmdNames.map(name=>{
    const canvasId="pcardCmdRobot_"+name.replace(/\s+/g,"_");
    const rCfg=getRobotConfigForAgent(name);
    const rName=rCfg.robot_name||"Commander";
    return`
    <div class="pcard">
      <div class="pcard-header">
        <div>
          <div class="pcard-name">${esc(name)}</div>
          <div class="pcard-level">Lvl MAX</div>
        </div>
        <span class="pcard-rank" style="color:${cmdRankColor};background:${cmdRankBg};border:1px solid ${cmdRankColor}30;text-shadow:0 0 8px ${cmdRankColor};box-shadow:0 0 12px ${cmdRankColor}40">COMMANDER</span>
      </div>
      <div class="pcard-bar-label"><span style="color:#FFD700">HP</span><span style="color:#FFD700">&infin;/&infin;</span></div>
      <div class="pcard-bar-wrap">
        <div class="pcard-bar" style="width:100%;background:linear-gradient(90deg,rgba(255,215,0,0.6),#FFD700)"></div>
      </div>
      <div class="pcard-bar-label"><span style="color:#FFD700">XP</span><span style="color:#FFD700">&infin;/&infin;</span></div>
      <div class="pcard-bar-wrap">
        <div class="pcard-bar" style="width:100%;background:linear-gradient(90deg,rgba(255,215,0,0.4),#FFD700)"></div>
      </div>
      <div style="text-align:center;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">
        <canvas id="${canvasId}" width="160" height="120" style="image-rendering:pixelated"></canvas>
        <div style="font-size:9px;color:var(--text-muted);font-family:'IBM Plex Mono',monospace;margin-top:0">${esc(rName)}</div>
      </div>
      <div class="pcard-icon">👑</div>
    </div>`;
  }).join("");

  // Render commander robot previews
  requestAnimationFrame(()=>{
    cmdNames.forEach(name=>{
      const canvasId="pcardCmdRobot_"+name.replace(/\s+/g,"_");
      const cvs=document.getElementById(canvasId);
      if(!cvs)return;
      const ctx=cvs.getContext("2d");
      const rCfg=getRobotConfigForAgent(name);
      drawRobot(ctx,cvs.width,cvs.height,rCfg,4);
    });
  });
}

// ═══════════ RADAR ═══════════


// ═══════════ RADAR ═══════════
function renderRisk(){
  if(!actTix.length){
    document.getElementById("riskInsights").innerHTML="";
    document.getElementById("riskSections").innerHTML='<div class="glass" style="padding:30px;text-align:center;color:var(--text-dim)">Upload active tickets to detect risks</div>';
    return;
  }
  const now=new Date();

  // 1. Resolution SLA Breached (exclude tickets with "Excluded from SLA")
  const slaBreach=[];
  actTix.forEach(tk=>{
    if(tk.sla&&tk.sla.toLowerCase().includes("excluded"))return;
    if(tk.type&&tk.type.toLowerCase().includes("user termination"))return;
    const raw=actRaw.find(r=>r.Ticket_ID===tk.id);
    const slaTgt=raw?pD(raw.SLA_Resolution_Target):null;
    if(!slaTgt)return;
    if(now>slaTgt){
      const overdueH=bizH(slaTgt,now);
      if(overdueH>16)slaBreach.push({...tk,overdueH,slaTgt,severity:overdueH>=48?"high":overdueH>=32?"med":"low"});
    }
  });

  // 2. Response SLA Breached (Next Response Date overdue, only if resolution target NOT breached)
  const resBreachedIds=new Set();
  actTix.forEach(tk=>{
    if(tk.sla&&tk.sla.toLowerCase().includes("excluded"))return;
    const raw=actRaw.find(r=>r.Ticket_ID===tk.id);
    const slaTgt=raw?pD(raw.SLA_Resolution_Target):null;
    if(slaTgt&&now>slaTgt)resBreachedIds.add(tk.id);
  });
  const overdueResp=[];
  actTix.forEach(tk=>{
    if(tk.sla&&tk.sla.toLowerCase().includes("excluded"))return;
    if(!tk.nextResponse)return;
    if(resBreachedIds.has(tk.id))return; // resolution target breached, skip
    if(now>tk.nextResponse){
      const overdueBizH=bizH(tk.nextResponse,now);
      if(overdueBizH>16)overdueResp.push({...tk,overdueBizH,severity:overdueBizH>=40?"high":overdueBizH>32?"med":"low"});
    }
  });

  // 3. Time Overruns (>=4h total time worked)
  const timeOverAll=[];
  actTix.forEach(tk=>{
    const raw=actRaw.find(r=>r.Ticket_ID===tk.id);
    if(!raw)return;
    const tw=parseFloat(raw.Time_Taken||raw.time_taken||"0");
    if(!isNaN(tw)&&tw>=4){
      timeOverAll.push({...tk,timeWorked:tw,severity:tw>=8?"high":tw>=6?"med":"low"});
    }
  });

  // Badge on tab
  const totalFlags=slaBreach.length+overdueResp.length+timeOverAll.length;
  const badge=document.getElementById("riskBadge");
  if(totalFlags>0){badge.style.display="inline";badge.textContent=totalFlags}else{badge.style.display="none"}

  // Broad flagging for At-Risk Agent card (any breach, no hour threshold)
  const broadFlagIds=new Set();
  actTix.forEach(tk=>{
    const raw=actRaw.find(r=>r.Ticket_ID===tk.id);
    const slaTgt=raw?pD(raw.SLA_Resolution_Target):null;
    if(slaTgt&&now>slaTgt)broadFlagIds.add(tk.id);
    if(tk.nextResponse&&now>tk.nextResponse)broadFlagIds.add(tk.id);
    const tw=parseFloat(raw?.Time_Taken||raw?.time_taken||"0");
    if(!isNaN(tw)&&tw>=4)broadFlagIds.add(tk.id);
  });
  const allRiskyBroad=actTix.filter(tk=>broadFlagIds.has(tk.id));

  // At-Risk Agent: most flagged tickets (using broad set)
  const agentRiskCount={};
  allRiskyBroad.forEach(tk=>{const a=tk.agent||"Unknown";agentRiskCount[a]=(agentRiskCount[a]||0)+1});
  const topRiskAgent=Object.entries(agentRiskCount).sort((a,b)=>b[1]-a[1])[0];

  // Heaviest Workload: agent with most active tickets, tiebreaker by est hours
  const agentWorkload={};
  actTix.filter(x=>x.assignedTo>0).forEach(tk=>{
    if(!agentWorkload[tk.agent])agentWorkload[tk.agent]={tix:0,hrs:0};
    agentWorkload[tk.agent].tix++;
    agentWorkload[tk.agent].hrs+=tk.est;
  });
  const topWorkload=Object.entries(agentWorkload).sort((a,b)=>b[1].tix-a[1].tix||b[1].hrs-a[1].hrs)[0];


  document.getElementById("riskInsights").innerHTML=[
    {l:"At-Risk Agent",v:topRiskAgent?topRiskAgent[0]:"—",sub:topRiskAgent?`${topRiskAgent[1]} flagged ticket${topRiskAgent[1]>1?"s":""}`:"No risks detected",c:topRiskAgent?"var(--danger)":"var(--green)"},
    {l:"Heaviest Workload",v:topWorkload?topWorkload[0]:"—",sub:topWorkload?`${topWorkload[1].tix} active · ${topWorkload[1].hrs.toFixed(1)}h est`:"No data",c:topWorkload?"var(--warning)":"var(--text-dim)"},
  ].map((c,i)=>`<div class="glass stat-card animate-in" style="animation-delay:${(i+4)*.04}s"><div class="stat-label">${c.l}</div><div class="stat-value-row"><span class="stat-value" style="color:${c.c};font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block" title="${c.v}">${c.v}</span></div><div class="stat-trend" style="color:var(--text-dim)">${c.sub}</div></div>`).join("");

  // Build sections
  let html="";

  if(overdueResp.length){
    html+=buildRiskSection("Response SLA Breached","#fd79a8",overdueResp.sort((a,b)=>b.overdueBizH-a.overdueBizH),tk=>{
      return`<span style="color:#fd79a8">${tk.overdueBizH.toFixed(1)}h overdue</span>`;
    },"Showing > 16h overdue");
  }

  if(slaBreach.length){
    html+=buildRiskSection("Resolution SLA Breached","var(--danger)",slaBreach.sort((a,b)=>b.overdueH-a.overdueH),tk=>{
      return`<span style="color:var(--danger)">${tk.overdueH.toFixed(1)}h overdue</span>`;
    },"Showing > 16h overdue");
  }

  if(timeOverAll.length){
    html+=buildRiskSection("TIME TAKEN SLA BREACHED","#a29bfe",timeOverAll.sort((a,b)=>b.timeWorked-a.timeWorked),tk=>{
      return`<span style="color:#a29bfe">${tk.timeWorked.toFixed(1)}h worked</span>`;
    },"Showing > 4h worked");
  }

  if(!html)html='<div class="glass" style="padding:30px;text-align:center;color:var(--green);font-weight:600">✓ No risks detected — all tickets look healthy</div>';

  document.getElementById("riskSections").innerHTML=html;

  // Bind collapsible headers
  document.querySelectorAll(".risk-header").forEach(h=>{
    h.addEventListener("click",()=>h.classList.toggle("open"));
  });
}

function buildRiskSection(title,color,tickets,detailFn,subtitle){
  let h=`<div class="glass risk-section"><div class="risk-header open"><h3><svg style="width:14px;height:14px;stroke:${color}"><use href="#iw"/></svg> ${title} <span class="risk-badge" style="background:${color}">${tickets.length}</span>${subtitle?`<span style="font-size:9px;font-weight:400;color:var(--text-dim);margin-left:10px;letter-spacing:0;text-transform:none">${subtitle}</span>`:""}</h3><span class="risk-arrow">▶</span></div><div class="risk-body" style="display:block">`;
  tickets.forEach(tk=>{
    const sev=tk.severity==="high"?"sev-high":tk.severity==="med"?"sev-med":"sev-low";
    const dateCreated=tk.dateCreated?tk.dateCreated.toLocaleDateString("en-US",{month:"short",day:"numeric"})+" "+tk.dateCreated.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}):"—";
    h+=`<div class="risk-row ${sev}"><span class="risk-id">${esc(tk.id)}</span><span class="risk-title">${esc(tk.category)}</span><span class="risk-agent">${esc(tk.agent)||"Unassigned"}</span><span class="risk-date">${dateCreated}</span><span class="risk-detail">${detailFn(tk)}</span></div>`;
  });
  h+=`</div></div>`;
  return h;
}



// ═══════════ BANNER ═══════════
function updateBanner(){const h=document.getElementById("headerStats");if(!h)return;const parts=[];if(actTix.length||closedTix.length){const wd=wkD(new Date());const assignedWeek=actTix.filter(t=>t.dateAssigned&&wd.some(d=>isSD(d,t.dateAssigned))).length+closedTix.filter(t=>t.dateAssigned&&wd.some(d=>isSD(d,t.dateAssigned))).length;parts.push(`<b style="color:var(--green)">${actTix.length}</b> active`);parts.push(`<b style="color:var(--green)">${assignedWeek}</b> assigned this week`);parts.push(`<b style="color:var(--green)">${closedTix.length}</b> closed this week`);parts.push(`<b style="color:var(--green)">${roster.length}</b> techs`)}if(histRaw.length){parts.push(`<b style="color:var(--green)">${Object.keys(catStats).length}</b> categories`)}h.innerHTML=parts.join('<span style="color:rgba(0,149,200,0.3)">·</span>')}

// ═══════════ EVENTS ═══════════
// Login/logout button
document.getElementById("loginBtn").addEventListener("click",async()=>{
  if(loggedInAgent){
    isCommander=false;loggedInAgent=null;
    await fetch(PROXY_BASE+"/api/logout",{method:"POST",credentials:"include"}).catch(()=>{});
    authToken="";stopAutoRefresh();applyLoginState();
  }else{
    document.getElementById("loginPanel").classList.toggle("hidden");
  }
});
// Close dropdown when clicking outside
document.addEventListener("click",(e)=>{
  const panel=document.getElementById("loginPanel");
  const btn=document.getElementById("loginBtn");
  if(panel&&!panel.classList.contains("hidden")&&!panel.contains(e.target)&&!btn.contains(e.target)){
    panel.classList.add("hidden");
  }
});
function applyLoginState(){
  const mainContent=document.getElementById("mainContent");
  const loginGate=document.getElementById("loginGate");
  const loginPanel=document.getElementById("loginPanel");
  const loginBtnWrap=document.getElementById("loginBtnWrap");
  const ss=document.getElementById("syncStatus");
  if(!authToken){
    if(mainContent)mainContent.classList.add("hidden");
    if(loginGate)loginGate.classList.remove("hidden");
    if(loginPanel)loginPanel.classList.add("hidden");
    if(loginBtnWrap)loginBtnWrap.style.display="none";
    if(ss)ss.textContent="";
  }else{
    if(mainContent)mainContent.classList.remove("hidden");
    if(loginGate)loginGate.classList.add("hidden");
    if(loginBtnWrap)loginBtnWrap.style.display="";
  }
  const riskTab=document.querySelector('.tab[data-tab="risk"]');
  const st=document.getElementById("loginStatus");
  const btnLabel=document.getElementById("loginBtnLabel");
  const loggedInUserEl=document.getElementById("loggedInUser");
  const agentLabel=document.querySelector('label[for="kpiAgent"]')||document.querySelector('#capTab .qbr-select label:nth-of-type(2)');
  const agentSelect=document.getElementById("kpiAgent");
  // Find the agent filter label+select wrapper elements (Deployment tab)
  const agentFilterEls=document.querySelectorAll('#capTab .qbr-select > *');
  let agentLabelEl=null,agentSelectEl=null;
  agentFilterEls.forEach(el=>{
    if(el.tagName==="LABEL"&&el.textContent.trim()==="Agent:")agentLabelEl=el;
    if(el.id==="kpiAgent")agentSelectEl=el;
  });
  // Find the agent filter label+select wrapper elements (Campaign tab)
  const campFilterEls=document.querySelectorAll('#campaignTab .qbr-select > *');
  let campAgentLabelEl=null,campAgentSelectEl=null;
  campFilterEls.forEach(el=>{
    if(el.tagName==="LABEL"&&el.textContent.trim()==="Agent:")campAgentLabelEl=el;
    if(el.id==="campaignAgent")campAgentSelectEl=el;
  });
  const robotCustomizer=document.getElementById("robotCustomizer");
  if(isCommander){
    riskTab.style.display="";
    if(agentLabelEl)agentLabelEl.style.display="";
    if(agentSelectEl){agentSelectEl.style.display="";agentSelectEl.value="";}
    if(campAgentLabelEl)campAgentLabelEl.style.display="";
    if(campAgentSelectEl){campAgentSelectEl.style.display="";campAgentSelectEl.value="";}
  }else{
    riskTab.style.display="none";
    if(riskTab.classList.contains("active")){
      riskTab.classList.remove("active");
      document.getElementById("riskTab").classList.add("hidden");
      document.querySelector('.tab[data-tab="barracks"]').classList.add("active");
      document.getElementById("barracksTab").classList.remove("hidden");
    }
    if(agentLabelEl)agentLabelEl.style.display="none";
    if(agentSelectEl)agentSelectEl.style.display="none";
    if(campAgentLabelEl)campAgentLabelEl.style.display="none";
    if(campAgentSelectEl)campAgentSelectEl.style.display="none";
  }
  // Login button and user display state
  if(loggedInAgent){
    if(loginPanel)loginPanel.classList.add("hidden");
    if(btnLabel)btnLabel.textContent="Logout";
    if(loggedInUserEl){
      loggedInUserEl.textContent=isCommander?"Commander View":"Logged in as "+loggedInAgent;
      loggedInUserEl.style.display="";
    }
    if(st){st.textContent="";st.style.display="none";}
    robotCustomizer.classList.remove("hidden");
    loadAgentRobot();
  }else{
    if(btnLabel)btnLabel.textContent="Login";
    if(loggedInUserEl){loggedInUserEl.textContent="";loggedInUserEl.style.display="none";}
    if(st){st.textContent="";st.style.display="none";}
    const nameInput=document.getElementById("loginName");
    const pwdInput=document.getElementById("loginPwd");
    if(nameInput)nameInput.value="";
    if(pwdInput)pwdInput.value="";
    robotCustomizer.classList.add("hidden");
  }
  // Update default workload selection based on login state
  if(roster.length){
    if(!loggedInAgent||isCommander){selTech=0}
    else{const me=roster.find(t=>t.name===loggedInAgent);selTech=me?me.id:0}
  }
  renderCommsBoard();
}
// Gate login (main login screen)
async function doGateLogin(){
  const name=document.getElementById("gateName").value.trim();
  const pwd=document.getElementById("gatePwd").value.trim();
  const gst=document.getElementById("gateStatus");
  if(!name||!pwd){gst.textContent="Enter your name and password.";gst.style.color="var(--warning)";return}
  gst.textContent="Logging in...";gst.style.color="var(--blue)";
  const result=await supaLogin(name,pwd);
  if(result.error){gst.textContent=result.error;gst.style.color="var(--danger)";return}
  if(result.role==="admin"){isCommander=true;loggedInAgent=result.agent_name||"Commander"}
  else{isCommander=false;loggedInAgent=result.agent_name}
  await Promise.all([loadAgentSchedules(),loadTicketOverrides()]);
  allRobotConfigs=await loadAllRobots();
  commanderAgentNames=await loadCommanderAgents();
  loadAllHatSprites();
  initComms();
  applyLoginState();
  startAutoRefresh();
}
document.getElementById("gateLoginBtn").addEventListener("click",doGateLogin);
document.getElementById("gateName").addEventListener("keydown",(e)=>{if(e.key==="Enter")document.getElementById("gatePwd").focus()});
document.getElementById("gatePwd").addEventListener("keydown",(e)=>{if(e.key==="Enter")doGateLogin()});

// In-app login (dropdown panel)
document.getElementById("loginSubmitBtn").addEventListener("click",async()=>{
  const name=document.getElementById("loginName").value.trim();
  const pwd=document.getElementById("loginPwd").value.trim();
  const st=document.getElementById("loginStatus");
  if(!name||!pwd){st.textContent="Enter name and password";st.style.display="";return}
  st.textContent="Logging in...";st.style.display="";st.style.color="var(--blue)";
  const result=await supaLogin(name,pwd);
  if(result.error){st.textContent=result.error;st.style.color="var(--danger)";st.style.display="";return}
  if(result.role==="admin"){isCommander=true;loggedInAgent=result.agent_name||"Commander"}
  else{isCommander=false;loggedInAgent=result.agent_name}
  await Promise.all([loadAgentSchedules(),loadTicketOverrides()]);
  allRobotConfigs=await loadAllRobots();
  commanderAgentNames=await loadCommanderAgents();
  loadAllHatSprites();
  initComms();
  applyLoginState();
  startAutoRefresh();
});
document.getElementById("loginName").addEventListener("keydown",(e)=>{
  if(e.key==="Enter")document.getElementById("loginPwd").focus();
});
document.getElementById("loginPwd").addEventListener("keydown",(e)=>{
  if(e.key==="Enter")document.getElementById("loginSubmitBtn").click();
});
// Last sync timestamp
function updateLastSync(){
  const now=new Date();
  document.getElementById("lastSync").textContent=`Last sync: ${now.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}`;
}
document.querySelectorAll(".tab").forEach(tab=>{tab.addEventListener("click",()=>{if(!isCommander&&tab.dataset.tab==="risk")return;document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));tab.classList.add("active");const tg=tab.dataset.tab;["barracksTab","capTab","commsTab","campaignTab","riskTab"].forEach(id=>document.getElementById(id).classList.add("hidden"));const map={barracks:"barracksTab",capacity:"capTab",comms:"commsTab",campaign:"campaignTab",risk:"riskTab"};document.getElementById(map[tg]).classList.remove("hidden");if(tg==="comms")renderCommsBoard()})});

document.getElementById("campaignAgent").addEventListener("change",()=>{renderCampaignCharts()});


// ═══════════ HALOPSA LIVE FETCH ═══════════
async function fetchHaloReport(reportName,onSuccess){
  const ss=document.getElementById("syncStatus");
  if(ss){ss.textContent="Fetching data...";ss.style.color="var(--blue)"}
  try{
    const r=await fetch(PROXY_BASE+"/api/active",{credentials:"include",headers:authH()});
    if(r.status===401){
      authToken="";loggedInAgent=null;isCommander=false;stopAutoRefresh();applyLoginState();return;
    }
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const data=await r.json();
    const rows=Array.isArray(data)?data:data.report_data||data.results||data.data||[];
    if(!rows.length)throw new Error("No data returned");
    onSuccess(rows);
    // Set sync status after banner rebuild
    const ss2=document.getElementById("syncStatus");
    if(ss2){ss2.innerHTML='<b style="color:var(--green)">Sync Active</b>'}
  }catch(e){
    const ss2=document.getElementById("syncStatus");
    if(ss2){
      if(e.message==="Failed to fetch"){
        ss2.innerHTML='<span style="color:var(--danger)">✗ Can\'t connect to launcher</span>';
      }else{
        ss2.innerHTML=`<span style="color:var(--danger)">✗ ${esc(e.message)}</span>`;
      }
    }
  }
}

function fetchActiveNow(){
  fetchHaloReport("active",rows=>{
    actRaw=rows.filter(r=>r.Ticket_ID);
    procAct();
    updateLastSync();
  });
}



// Auto-refresh for active tickets (every 5 minutes)
let autoRefreshTimer=null;
let autoRefreshOn=false;
function startAutoRefresh(){
  if(autoRefreshOn)return;
  autoRefreshOn=true;
  fetchActiveNow();
  autoRefreshTimer=setInterval(async()=>{
    refreshTokenIfNeeded();
    const results=await Promise.all([loadAgentSchedules(),loadAllRobots(),loadCommsCards(),loadTicketOverrides()]);
    if(results[1])allRobotConfigs=results[1];
    roster.forEach(t=>{const li=AGENT_LUNCH[t.name]!=null?AGENT_LUNCH[t.name]:1;const si=AGENT_SHIFT[t.name]!=null?AGENT_SHIFT[t.name]:1;techSched[t.id]={ss:SHIFTS[si].s,se:SHIFTS[si].e,ls:LUNCHES[li].s,le:LUNCHES[li].e,si,li}});
    renderCommsBoard();
    fetchActiveNow();
  },60*1000);
}
function stopAutoRefresh(){
  if(!autoRefreshOn)return;
  clearInterval(autoRefreshTimer);autoRefreshTimer=null;
  autoRefreshOn=false;
}

// ═══════════ SESSION RESTORE ═══════════
(async function restoreSession(){
  // Check for an existing session via the HttpOnly cookie.
  // /api/me returns 200+identity if the cookie is valid, 401 otherwise.
  try{
    const r=await fetch(PROXY_BASE+"/api/me",{credentials:"include"});
    if(r.ok){
      const d=await r.json();
      if(d.agent_name){
        authToken="1";
        loggedInAgent=d.agent_name;
        isCommander=d.role==="admin";
      }
    }
  }catch(e){/* network error — stay logged out */}
  if(authToken){
    await Promise.all([loadAgentSchedules(),loadTicketOverrides()]);
    allRobotConfigs=await loadAllRobots();
    commanderAgentNames=await loadCommanderAgents();
    loadAllHatSprites();
    await initComms();
    setTimeout(startAutoRefresh,500);
  }
  applyLoginState();
})();


// ═══════════ ROBOT CUSTOMIZER ═══════════
const ROBOT_COLORS=[
  {id:"none",hex:null,label:"None"},
  {id:"blue",hex:"#0095C8",label:"Cyber Blue"},
  {id:"green",hex:"#84BD00",label:"Neon Green"},
  {id:"red",hex:"#ff5c5c",label:"Blaze Red"},
  {id:"purple",hex:"#a29bfe",label:"Phantom Purple"},
  {id:"orange",hex:"#fb9e00",label:"Volt Orange"},
  {id:"cyan",hex:"#00E5FF",label:"Ice Cyan"},
  {id:"pink",hex:"#ff6b9d",label:"Plasma Pink"},
  {id:"gold",hex:"#fcdc00",label:"Solar Gold"},
  {id:"white",hex:"#e8e8e8",label:"Ghost White"},
  {id:"navy",hex:"#1a3a5c",label:"Deep Navy"},
  {id:"lime",hex:"#32cd32",label:"Acid Lime"},
  {id:"crimson",hex:"#dc143c",label:"Crimson"},
  {id:"teal",hex:"#2aa198",label:"Teal"},
  {id:"coral",hex:"#ff7f50",label:"Coral"},
  {id:"violet",hex:"#8b5cf6",label:"Violet"},
  {id:"steel",hex:"#708090",label:"Steel"},
  {id:"mint",hex:"#3eb489",label:"Mint"},
  {id:"magenta",hex:"#ff00ff",label:"Magenta"},
  {id:"amber",hex:"#ffbf00",label:"Amber"},
  {id:"slate",hex:"#4a5568",label:"Slate"},
];
// Hat sprite mapping: accessory id → sprite filename
const HAT_SPRITE_MAP={
  none:"tech-sprite-8",
  trilby:"tech-sprite-hat1",
  cowboy:"tech-sprite-hat2",
  tophat:"tech-sprite-hat3",
  cap:"tech-sprite-hat4",
  fedora:"tech-sprite-hat5",
  hardhat:"tech-sprite-hat6",
  viking:"tech-sprite-hat7",
  crown:"tech-sprite-hat8",
  partyhat:"tech-sprite-hat9",
  beanie:"tech-sprite-hat10",
  knighthelmet:"tech-sprite-hat11",
  spikedhair:"tech-sprite-hat12",
  longhair:"tech-sprite-hat13",
  wizardhat:"tech-sprite-hat14",
  piratehat:"tech-sprite-hat15",
  spacehelmet:"tech-sprite-hat16",
  propellercap:"tech-sprite-hat17",
  hockeymask:"tech-sprite-hat18",
  paperbag:"tech-sprite-hat19"
};
const ROBOT_ACCESSORIES=[
  {id:"none",label:"None"},
  {id:"trilby",label:"Trilby"},
  {id:"cowboy",label:"Cowboy Hat"},
  {id:"tophat",label:"Top Hat"},
  {id:"cap",label:"Cap"},
  {id:"fedora",label:"Fedora"},
  {id:"hardhat",label:"Hardhat"},
  {id:"viking",label:"Viking"},
  {id:"crown",label:"Crown"},
  {id:"partyhat",label:"Party Hat"},
  {id:"beanie",label:"Beanie"},
  {id:"knighthelmet",label:"Knight Helmet"},
  {id:"spikedhair",label:"Spiked Hair"},
  {id:"longhair",label:"Long Hair"},
  {id:"wizardhat",label:"Wizard Hat"},
  {id:"piratehat",label:"Pirate Hat"},
  {id:"spacehelmet",label:"Space Helmet"},
  {id:"propellercap",label:"Propeller Cap"},
  {id:"hockeymask",label:"Hockey Mask"},
  {id:"paperbag",label:"Paper Bag"},
];

let currentRobot={color:"blue",eyes:"visor",antenna:"spike",accessory:"none",robot_name:""};

// Global cache of all robot configs (loaded from Supabase)
let allRobotConfigs=[];
let commanderAgentNames=[];
const DEFAULT_ROBOT={color:"blue",eyes:"visor",antenna:"none",accessory:"none",robot_name:""};

// Sprite system for previews and battlefield — one sheet per hat
const SPRITE_FRAME_W=169,SPRITE_FRAME_H=369,SPRITE_FRAMES=4,SPRITE_INSET=0;
const SPRITE_BASE_URL="https://king-kirratoy.github.io/Tech-Service-Hub/assets/";
const hatSpriteSheets={};  // hatId → Image
const hatTintCache={};     // "hatId:color" → canvas
let hatSpritesReady=false;

function loadAllHatSprites(){
  const ids=Object.keys(HAT_SPRITE_MAP);
  let loaded=0;
  ids.forEach(hatId=>{
    const img=new Image();
    img.crossOrigin="anonymous";
    img.onload=()=>{
      hatSpriteSheets[hatId]=img;
      loaded++;
      if(loaded===ids.length){
        hatSpritesReady=true;
        updateRobotPreview();
        renderPlayerCards();
      }
    };
    img.onerror=()=>{
      console.warn("Hat sprite failed to load:",hatId);
      loaded++;
      if(loaded===ids.length){hatSpritesReady=true;updateRobotPreview();renderPlayerCards()}
    };
    img.src=SPRITE_BASE_URL+HAT_SPRITE_MAP[hatId]+".png";
  });
}

function getTintedHatSprite(hatId,color){
  const key=hatId+":"+(color||"none");
  if(hatTintCache[key])return hatTintCache[key];
  const sheet=hatSpriteSheets[hatId]||hatSpriteSheets["none"];
  if(!sheet)return null;
  const oc=document.createElement("canvas");
  oc.width=sheet.width;oc.height=sheet.height;
  const ox=oc.getContext("2d");
  ox.drawImage(sheet,0,0);
  if(color){
    const id=ox.getImageData(0,0,oc.width,oc.height);
    const d=id.data;
    const tr=parseInt(color.slice(1,3),16),tg=parseInt(color.slice(3,5),16),tb=parseInt(color.slice(5,7),16);
    for(let i=0;i<d.length;i+=4){
      const r=d[i],g=d[i+1],b=d[i+2];
      if(r<25&&g<25&&b<25){d[i+3]=0;continue}
      const lum=(r*0.299+g*0.587+b*0.114)/255;
      d[i]=Math.min(255,Math.round(tr*lum+r*0.15));
      d[i+1]=Math.min(255,Math.round(tg*lum+g*0.15));
      d[i+2]=Math.min(255,Math.round(tb*lum+b*0.15));
    }
    ox.putImageData(id,0,0);
  }
  hatTintCache[key]=oc;
  return oc;
}

function getRobotConfigForAgent(agentName){
  const r=allRobotConfigs.find(x=>x.agent_name===agentName);
  if(r)return{color:r.body_color||"blue",eyes:r.eye_style||"visor",antenna:r.antenna||"none",accessory:r.accessory||"none",robot_name:r.robot_name||""};
  return{...DEFAULT_ROBOT};
}

function drawRobot(ctx,w,h,config,scale){
  const s=scale||4;
  ctx.clearRect(0,0,w,h);
  const c=ROBOT_COLORS.find(x=>x.id===config.color)||ROBOT_COLORS[1];
  const hex=c.hex||null;
  const hatId=config.accessory||"none";

  // Get the tinted sprite for this hat + color combo
  const tinted=getTintedHatSprite(hatId,hex);
  const refH=Math.max(h,200);
  const dh=refH*0.85;
  const dw=dh*(SPRITE_FRAME_W/SPRITE_FRAME_H);
  const cx=w/2;
  const baseY=h/2+dh/2;

  if(tinted){
    ctx.drawImage(tinted,SPRITE_INSET,0,SPRITE_FRAME_W-SPRITE_INSET*2,SPRITE_FRAME_H,cx-dw/2,baseY-dh,dw,dh);
  }else{
    // Fallback: simple colored rectangle
    ctx.fillStyle=hex||"#888888";
    ctx.fillRect(cx-15*s,baseY-38*s,30*s,38*s);
  }
}

function shadeColor(hex,pct){
  let r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  r=Math.max(0,Math.min(255,r+pct));g=Math.max(0,Math.min(255,g+pct));b=Math.max(0,Math.min(255,b+pct));
  return"#"+[r,g,b].map(x=>x.toString(16).padStart(2,"0")).join("");
}

function initRobotCustomizer(){
  const colorPicker=document.getElementById("robotColorPicker");
  const accessoryPicker=document.getElementById("robotAccessoryPicker");

  function buildPicker(container,items,key,isColor){
    container.innerHTML=items.map(item=>{
      const active=currentRobot[key]===item.id?"active":"";
      if(isColor&&item.hex){
        return`<div class="robo-opt ${active}" data-key="${key}" data-val="${item.id}" style="background:${item.hex}" title="${item.label}"></div>`;
      }
      return`<div class="robo-opt robo-opt-text ${active}" data-key="${key}" data-val="${item.id}" title="${item.label}">${item.label}</div>`;
    }).join("");
    container.querySelectorAll(".robo-opt").forEach(el=>{
      el.addEventListener("click",()=>{
        currentRobot[el.dataset.key]=el.dataset.val;
        buildPicker(container,items,key,isColor);
        updateRobotPreview();
      });
    });
  }

  buildPicker(colorPicker,ROBOT_COLORS,"color",true);
  buildPicker(accessoryPicker,ROBOT_ACCESSORIES,"accessory",false);

  document.getElementById("robotName").addEventListener("input",(e)=>{
    currentRobot.robot_name=e.target.value;
  });

  document.getElementById("robotSaveBtn").addEventListener("click",async()=>{
    if(!loggedInAgent)return;
    const st=document.getElementById("robotSaveStatus");
    st.textContent="Saving...";st.style.color="var(--blue)";
    const ok=await saveRobotConfig(loggedInAgent,{
      robot_name:currentRobot.robot_name,
      body_color:currentRobot.color,
      eye_style:currentRobot.eyes,
      antenna:currentRobot.antenna,
      accessory:currentRobot.accessory
    });
    if(ok){
      st.textContent="Saved!";st.style.color="var(--green)";
      // Refresh cached robot configs for battlefield and player cards
      allRobotConfigs=await loadAllRobots();
      renderPlayerCards();
    }
    else{st.textContent="Save failed";st.style.color="var(--danger)"}
    setTimeout(()=>{st.textContent=""},3000);
  });

  // Toggle customizer panel
  document.getElementById("robotCustomizeToggle").addEventListener("click",()=>{
    const panel=document.getElementById("robotCustomizerPanel");
    const btn=document.getElementById("robotCustomizeToggle");
    panel.classList.toggle("hidden");
    btn.textContent=panel.classList.contains("hidden")?"Customize Robot":"Hide Customizer";
  });
  document.getElementById("robotCloseBtn").addEventListener("click",()=>{
    document.getElementById("robotCustomizerPanel").classList.add("hidden");
    document.getElementById("robotCustomizeToggle").textContent="Customize Robot";
  });

  updateRobotPreview();
}

function updateRobotPreview(){
  const canvas=document.getElementById("robotPreview");
  if(!canvas)return;
  const ctx=canvas.getContext("2d");
  drawRobot(ctx,canvas.width,canvas.height,currentRobot,5);
}

async function loadAgentRobot(){
  if(!loggedInAgent)return;
  const data=await loadRobotConfig(loggedInAgent);
  if(data){
    currentRobot.color=data.body_color||"blue";
    currentRobot.eyes=data.eye_style||"visor";
    currentRobot.antenna=data.antenna||"spike";
    currentRobot.accessory=data.accessory||"none";
    currentRobot.robot_name=data.robot_name||"";
    document.getElementById("robotName").value=currentRobot.robot_name;
  }else{
    currentRobot={color:"blue",eyes:"visor",antenna:"spike",accessory:"none",robot_name:""};
    document.getElementById("robotName").value="";
  }
  initRobotCustomizer();
}





// ═══════════ BATTLEFIELD ENGINE ═══════════
const BF={
  canvas:null,ctx:null,W:0,H:160,scale:2,warriors:[],commanders:[],enemies:[],projectiles:[],grenades:[],floatingTexts:[],airStrikes:[],frontLine:0.5,
  targetFront:0.5,frame:0,running:false,muted:true,hoveredEntity:null,
  lastHourClosedCount:0,lastHourCheckTime:0,
  prevWarriorState:{}, // Cache warrior positions across refreshes
  spriteLoaded:false,
  spriteFrameW:169,spriteFrameH:369,spriteFrames:4,
  spriteDH:280, // display height in canvas pixels
  enemySheets:{},enemySpritesLoaded:0,
  enemySizes:{small:{dh:220,maxEst:1},medium:{dh:320,maxEst:2},large:{dh:420,maxEst:999}},
  WCOLORS:["#4FC3F7","#AED581","#FFD54F","#FF8A65","#BA68C8","#4DD0E1","#F06292","#81C784","#FFB74D","#9575CD","#E57373","#64B5F6","#DCE775","#FF8A80","#80CBC4","#A1887F","#90A4AE","#FFF176","#CE93D8","#80DEEA"],
  ECOLORS:{"Hardware":"#6D3A1F","Software":"#5C2D82","Network":"#2E7D32","Security":"#C62828","Email":"#1565C0","End User":"#D84315","Licensing":"#5D4037","Other":"#455A64"},
  contentLeft:0,contentRight:0,
  groundY:0,

  init(){
    this.canvas=document.getElementById("battleCanvas");
    if(!this.canvas)return;
    this.ctx=this.canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize",()=>this.resize());
    this.canvas.addEventListener("mousemove",e=>{
      const rect=this.canvas.getBoundingClientRect();
      const mx=(e.clientX-rect.left)*(this.canvas.width/rect.width);
      const my=(e.clientY-rect.top)*(this.canvas.height/rect.height);
      this.checkHover(mx,my,e.clientX,e.clientY);
    });
    this.canvas.addEventListener("mouseleave",()=>{
      this.hoveredEntity=null;
      document.getElementById("battleTooltip").style.display="none";
    });
    document.getElementById("battleMute").addEventListener("click",()=>{
      this.muted=!this.muted;
      document.getElementById("battleMute").textContent=this.muted?"\uD83D\uDD07":"\uD83D\uDD0A";
    });
    this.running=true;
    this.loadSprite();
    this.loop();
  },

  loadSprite(){
    // Hat sprites are loaded globally via loadAllHatSprites()
    // BF uses the shared hatSpriteSheets and hatTintCache
    this.spriteLoaded=true;
    // Load enemy sprites
    ["small","medium","large"].forEach(tier=>{
      const ei=new Image();
      ei.crossOrigin="anonymous";
      ei.onload=()=>{
        this.enemySheets[tier]=ei;
        this.enemySpritesLoaded++;
        console.log("Enemy sprite loaded:",tier,ei.width,"x",ei.height);
      };
      ei.onerror=()=>console.warn("Enemy sprite failed:",tier);
      ei.src=SPRITE_BASE_URL+"enemy-"+tier+".png";
    });
  },

  getTintedSprite(hatId,color){
    return getTintedHatSprite(hatId,color);
  },

  resize(){
    const rect=this.canvas.parentElement.getBoundingClientRect();
    this.W=Math.floor(rect.width);
    this.canvas.width=this.W*this.scale;
    this.canvas.height=this.H*this.scale;
    this.canvas.style.height=this.H+"px";
    this.ctx.imageSmoothingEnabled=false;
    // Calculate content bounds matching container below
    const contW=Math.min(1280,this.W);
    const pad=28;
    this.contentLeft=((this.W-contW)/2+pad)*this.scale;
    this.contentRight=(this.W-(this.W-contW)/2-pad)*this.scale;
    this.groundY=this.canvas.height-10*this.scale;
  },

  update(){
    if(!roster.length)return;
    const weekDays=wkD(new Date());
    const s=this.scale;
    const today=new Date();
    // Weekly closed vs assigned ticket counts drive battlefield position
    // More closed than assigned = push right, more assigned than closed = push left
    const closedWeek=closedTix.length;
    const assignedWeek=actTix.filter(t=>t.dateCreated&&weekDays.some(wd=>isSD(wd,t.dateCreated))).length+closedWeek;
    const diff=closedWeek-assignedWeek;
    // 1 pixel per ticket difference from center, clamped to prevent runoff
    const battleLeft=this.contentLeft;
    const battleRight=this.contentRight;
    const battleW=battleRight-battleLeft;
    const centerX=battleLeft+battleW*0.5;
    const rawOffset=diff*1*s;
    const maxOffset=battleW*0.2;
    const clampedOffset=Math.max(-maxOffset,Math.min(maxOffset,rawOffset));
    const targetFxAbs=centerX+clampedOffset;
    if(!this._fxAbs)this._fxAbs=targetFxAbs;
    this._fxAbs+=(targetFxAbs-this._fxAbs)*0.015;
    const fxAbs=this._fxAbs;

    // Build/update warriors — diff-based: keep existing, add new, remove departed
    const rosterNames=new Set(roster.map(t=>t.name));
    const existingByName={};this.warriors.forEach(w=>{existingByName[w.name]=w});
    if(this._needsSync||this.warriors.length!==roster.length||roster.some(t=>!existingByName[t.name])){
      this._needsSync=false;
      const newWarriors=roster.map((t,i)=>{
        const existing=existingByName[t.name];
        if(existing){existing.id=t.id;return existing}// Keep in place
        const cached=this.prevWarriorState[t.name];
        const rCfg=getRobotConfigForAgent(t.name);
        const rColorObj=ROBOT_COLORS.find(rc=>rc.id===rCfg.color);
        const wColor=rColorObj?rColorObj.hex:this.WCOLORS[i%this.WCOLORS.length];
        return{
          id:t.id,name:t.name,color:wColor,
          level:0,hp:100,
          x:cached?cached.x:fxAbs-80*s,
          y:cached?cached.y:this.groundY,
          vx:0,frame:Math.floor(Math.random()*200),
          atkTimer:30+Math.floor(Math.random()*60),attacking:false,atkFrame:0,
          walkOff:0,bobPhase:Math.random()*Math.PI*2,
          weapon:cached?cached.weapon:null,
          weaponLevel:cached?cached.weaponLevel:undefined,
          prevLevel:cached?cached.prevLevel:undefined
        };
      });
      this.warriors=newWarriors;
    }
    // Update warrior stats
    this.warriors.forEach((w,i)=>{
      const t=roster[i];if(!t)return;
      const tt=actTix.filter(x=>x.assignedTo===t.id);
      w.hp=Math.max(0,Math.min(100,Math.round(100-tt.length*3-tt.reduce((s2,x)=>s2+x.est,0)*3)));
      // Recalc level
      const techClosedHist=histRaw.filter(r=>{
        const ag=r.Agent_Resolved||r.Agent_Assigned;
        if(ag!==t.name)return false;
        const dc=pD(r.Date_Closed);if(!dc)return false;
        return weekDays.some(wd=>isSD(wd,dc));
      });
      let totalXP=0;
      techClosedHist.forEach(r=>{
        let xp=25;
        const frt=parseFloat(r.First_Response_Time);
        if(!isNaN(frt)&&frt>=0){if(frt<=2)xp+=10;else if(frt<=4)xp+=5}
        const frd=pD(r.First_Response_Date),dc=pD(r.Date_Closed);
        if(frd&&dc&&isSD(frd,dc))xp+=10;
        const cr=pD(r.Date_Created);
        if(cr&&dc&&(dc-cr)/(1000*60*60*24)<=5)xp+=5;
        totalXP+=xp;
      });
      w.level=Math.floor(totalXP/100);
      w.closedCount=techClosedHist.length;
    });

    // Sort warriors by closed count (most closed = front/right, least = back/left)
    const sortedWarriors=[...this.warriors].sort((a,b)=>b.closedCount-a.closedCount);
    const wIdxMap={};sortedWarriors.forEach((w,i)=>{wIdxMap[w.id]=i});

    // Position warriors in diagonal "/" grid pattern
    // Each warrior gets own column, row cycles 0→1→2 creating repeating "/" diagonals
    const wDiagRows=3;
    const wSpacing=40*s;
    const wRows=5;
    this.warriors.forEach(w=>{
      const i=wIdxMap[w.id];
      const col=i;
      const diagRow=wDiagRows-1-(i%wDiagRows); // 2,1,0,2,1,0... = "/" from top-right
      const targetX=fxAbs-50*s-col*wSpacing+Math.sin(this.frame*0.02+w.id)*4*s;
      const targetY=this.groundY-diagRow*5*s;
      w.x+=(targetX-w.x)*0.04;
      w.y+=(targetY-w.y)*0.04;
      w.frame++;
      w.bobPhase+=0.04;
      w.atkTimer--;
      if(w.atkTimer<=0&&!w.attacking){
        w.attacking=true;w.atkFrame=0;
        // Assign weapon type on first attack or re-roll on level-up
        // Pool excludes weaker weapons as level increases
        const needsWeapon=!w.weapon||(w.weaponLevel!==undefined&&w.weaponLevel!==w.level);
        if(needsWeapon){
          let pool;
          if(w.level>=25)pool=["railgun","railgun","laser","plasma"];
          else if(w.level>=18)pool=["laser","laser","plasma","railgun"];
          else if(w.level>=11)pool=["plasma","plasma","laser","rifle"];
          else if(w.level>=4)pool=["rifle","rifle","plasma","pistol"];
          else pool=["pistol","pistol","rifle"];
          w.weapon=pool[Math.floor(Math.random()*pool.length)];
        }
        w.weaponLevel=w.level;
        // Weapon stats
        const wpn=w.weapon;
        const fireRate=wpn==="railgun"?25:wpn==="laser"?22:wpn==="plasma"?28:wpn==="rifle"?32:42;
        w.atkTimer=fireRate+Math.floor(Math.random()*15);
        const dh=this.spriteDH;
        const dw=dh*(this.spriteFrameW/this.spriteFrameH);
        const randLife=25+Math.floor(Math.random()*70);
        if(wpn==="railgun"){
          // Railgun: fast, bright cyan beam, large
          this.projectiles.push({x:w.x+dw*0.45,y:w.y-dh*0.15,vx:10*s,color:"#00E5FF",size:5*s,trail:true,life:randLife,age:0,shape:"beam"});
        }else if(wpn==="laser"){
          // Laser: twin green beams, medium speed
          this.projectiles.push({x:w.x+dw*0.45,y:w.y-dh*0.17,vx:7*s,color:"#84BD00",size:3.5*s,trail:true,life:randLife,age:0,shape:"beam"});
          this.projectiles.push({x:w.x+dw*0.45,y:w.y-dh*0.12,vx:7*s,color:"#84BD00",size:2.5*s,trail:true,life:randLife+5,age:0,shape:"beam"});
        }else if(wpn==="plasma"){
          // Plasma: glowing orb, medium
          this.projectiles.push({x:w.x+dw*0.45,y:w.y-dh*0.15,vx:6*s,color:"#fcdc00",size:4*s,trail:true,life:randLife,age:0,shape:"orb"});
        }else if(wpn==="rifle"){
          // Rifle: fast small rounds, occasional double tap
          this.projectiles.push({x:w.x+dw*0.45,y:w.y-dh*0.15,vx:8*s,color:"#74b9ff",size:2.5*s,trail:false,life:randLife,age:0,shape:"bolt"});
          if(Math.random()<0.4){
            this.projectiles.push({x:w.x+dw*0.45,y:w.y-dh*0.14,vx:8*s,color:"#74b9ff",size:2*s,trail:false,life:randLife+3,age:0,shape:"bolt"});
          }
        }else{
          // Pistol: slow, small
          this.projectiles.push({x:w.x+dw*0.45,y:w.y-dh*0.15,vx:4*s,color:"#ccc",size:2*s,trail:false,life:randLife,age:0,shape:"bolt"});
        }
      }
      if(w.attacking){w.atkFrame++;if(w.atkFrame>16)w.attacking=false}
      // Cache position and weapon
      this.prevWarriorState[w.name]={x:w.x,y:w.y,weapon:w.weapon,weaponLevel:w.weaponLevel,prevLevel:w.prevLevel};
    });

    // Build/update commanders (commander agents — positioned far left, behind warriors)
    const cmdNames=commanderAgentNames.filter(n=>!roster.some(r=>r.name===n));
    const existingCmdByName={};this.commanders.forEach(c=>{existingCmdByName[c.name]=c});
    if(this.commanders.length!==cmdNames.length||cmdNames.some(n=>!existingCmdByName[n])){
      this.commanders=cmdNames.map((name,i)=>{
        const existing=existingCmdByName[name];
        if(existing)return existing;// Keep in place
        const rCfg=getRobotConfigForAgent(name);
        const rColorObj=ROBOT_COLORS.find(rc=>rc.id===rCfg.color);
        const cmdColor=rColorObj?rColorObj.hex:"#FFD700";
        return{
          id:-100-i,name,color:cmdColor,isCommander:true,
          x:battleLeft+40*s,
          y:this.groundY,
          frame:Math.floor(Math.random()*200),
          bobPhase:Math.random()*Math.PI*2,
          atkTimer:40+Math.floor(Math.random()*60),
          attacking:false,atkFrame:0,
          weapon:null,weaponLevel:undefined,level:30
        };
      });
    }
    // Position commanders directly behind the last column of warriors
    const wCols=this.warriors.length; // Each warrior has own column in diagonal grid
    const behindWarriorsX=fxAbs-50*s-wCols*wSpacing;
    const cDiagRows=3;
    const cSpacing=40*s;
    this.commanders.forEach((cmd,i)=>{
      const col=i;
      const diagRow=cDiagRows-1-(i%cDiagRows); // 2,1,0,2,1,0... = "/" diagonal
      const targetX=behindWarriorsX-col*cSpacing+Math.sin(this.frame*0.02+cmd.id)*4*s;
      const targetY=this.groundY-diagRow*5*s;
      cmd.x+=(targetX-cmd.x)*0.04;
      cmd.y+=(targetY-cmd.y)*0.04;
      cmd.frame++;
      cmd.bobPhase+=0.03;
      // Commander shooting logic (same as warriors)
      cmd.atkTimer--;
      if(cmd.atkTimer<=0&&!cmd.attacking){
        cmd.attacking=true;cmd.atkFrame=0;
        if(!cmd.weapon){
          const pool=["railgun","railgun","laser","plasma"];
          cmd.weapon=pool[Math.floor(Math.random()*pool.length)];
        }
        const wpn=cmd.weapon;
        const fireRate=wpn==="railgun"?25:wpn==="laser"?22:wpn==="plasma"?28:25;
        cmd.atkTimer=fireRate+Math.floor(Math.random()*15);
        const dh=this.spriteDH;
        const dw=dh*(this.spriteFrameW/this.spriteFrameH);
        const randLife=25+Math.floor(Math.random()*70);
        if(wpn==="railgun"){
          this.projectiles.push({x:cmd.x+dw*0.45,y:cmd.y-dh*0.15,vx:10*s,color:"#00E5FF",size:5*s,trail:true,life:randLife,age:0,shape:"beam"});
        }else if(wpn==="laser"){
          this.projectiles.push({x:cmd.x+dw*0.45,y:cmd.y-dh*0.17,vx:7*s,color:"#84BD00",size:3.5*s,trail:true,life:randLife,age:0,shape:"beam"});
          this.projectiles.push({x:cmd.x+dw*0.45,y:cmd.y-dh*0.12,vx:7*s,color:"#84BD00",size:2.5*s,trail:true,life:randLife+5,age:0,shape:"beam"});
        }else if(wpn==="plasma"){
          this.projectiles.push({x:cmd.x+dw*0.45,y:cmd.y-dh*0.15,vx:6*s,color:"#fcdc00",size:4*s,trail:true,life:randLife,age:0,shape:"orb"});
        }
      }
      if(cmd.attacking){cmd.atkFrame++;if(cmd.atkFrame>16)cmd.attacking=false}
    });

    // Build enemies from active tickets
    const activeIds=new Set(actTix.map(t=>t.id));
    // Mark enemies as dying when their ticket is closed (instead of instant removal)
    this.enemies.forEach(e=>{
      if(!activeIds.has(e.id)&&!e.dying&&!e.dead){
        e.dying=true;e.deathTimer=0;e.deathDuration=90; // ~1.5s at 60fps
        // Spawn XP popup at the assigned warrior's position
        const closedTk=closedTix.find(t=>t.id===e.id);
        if(closedTk&&closedTk.assignedTo){
          const warrior=this.warriors.find(w=>w.id===closedTk.assignedTo);
          if(warrior){
            let xp=25;
            const hist=histRaw.find(r=>r.Ticket_ID===e.id);
            if(hist){
              const frt=parseFloat(hist.First_Response_Time);
              if(!isNaN(frt)&&frt>=0){if(frt<=2)xp+=10;else if(frt<=4)xp+=5}
              const frd=pD(hist.First_Response_Date),dc=pD(hist.Date_Closed);
              if(frd&&dc&&isSD(frd,dc))xp+=10;
              const cr=pD(hist.Date_Created);
              if(cr&&dc&&(dc-cr)/(1000*60*60*24)<=5)xp+=5;
            }
            const dh=this.spriteDH;
            this.floatingTexts.push({
              x:warrior.x,y:warrior.y-dh*0.45,
              text:"+"+xp+" XP",color:warrior.color,
              age:0,duration:90
            });
          }
        }
      }
    });
    // Update dying enemies — transition to "dead" (corpse on ground) after animation
    const now=Date.now();
    this.enemies.forEach(e=>{
      if(e.dying){
        e.deathTimer++;
        if(e.deathTimer>=e.deathDuration){
          e.dying=false;e.dead=true;e.deadSince=now;
        }
      }
    });
    // Remove corpses after 30 minutes
    this.enemies=this.enemies.filter(e=>{
      if(e.dead)return(now-e.deadSince)<1800000;
      return true;
    });
    // Add new enemies
    const existingIds=new Set(this.enemies.map(e=>e.id));
    actTix.forEach((tk,idx)=>{
      if(existingIds.has(tk.id))return;
      if(this.enemies.length>=180)return;
      const cat=(tk.category||"Other").split(">")[0];
      const eColor=this.ECOLORS[cat]||this.ECOLORS.Other;
      const sz=Math.max(14,Math.min(40,Math.round(tk.est*8+12)));
      const tier=tk.est<=0.75?"small":tk.est<1.5?"medium":"large";
      this.enemies.push({
        id:tk.id,ticketRef:tk,cat,color:eColor,size:sz,tier,
        x:battleRight+Math.random()*100*s,
        y:this.groundY-Math.random()*10*s,
        frame:Math.floor(Math.random()*200),bobPhase:Math.random()*Math.PI*2
      });
    });
    // Update enemy ticket refs
    this.enemies.forEach(e=>{const tk=actTix.find(t=>t.id===e.id);if(tk)e.ticketRef=tk});

    // Position enemies sorted by next response date (soonest = front, nearest warriors)
    const eSpacing=32*s;
    const eRows=6;
    const FAR_FUTURE=9e15;
    const eSorted=this.enemies.filter(e=>!e.dying&&!e.dead);
    eSorted.sort((a,b)=>{
      const aNrd=a.ticketRef&&a.ticketRef.nextResponse?a.ticketRef.nextResponse.getTime():FAR_FUTURE;
      const bNrd=b.ticketRef&&b.ticketRef.nextResponse?b.ticketRef.nextResponse.getTime():FAR_FUTURE;
      return aNrd-bNrd;
    });
    eSorted.forEach((e,i)=>{
      const col=Math.floor(i/eRows);
      const row=i%eRows;
      const targetX=fxAbs+30*s+col*eSpacing+Math.sin(this.frame*0.025+i*0.7)*5*s;
      const targetY=this.groundY-row*1.5*s;
      e.x+=(targetX-e.x)*0.03;
      e.y+=(targetY-e.y)*0.03;
      const tier=e.tier||"small";
      e.frame+=(tier==="large"?1:0.6);
      e.bobPhase+=0.03;
    });

    // Grenade system — warriors throw a grenade when they level up
    this.warriors.forEach(w=>{
      if(w.prevLevel===undefined)w.prevLevel=w.level; // Init tracking
      if(w.level>w.prevLevel){
        // Level up! Throw a grenade to celebrate
        const liveEnemies=this.enemies.filter(e=>!e.dying&&!e.dead);
        if(liveEnemies.length){
          const target=liveEnemies[Math.floor(Math.random()*Math.min(liveEnemies.length,20))];
          const dh=this.spriteDH;
          const dw=dh*(this.spriteFrameW/this.spriteFrameH);
          const grenColor=w.level>=25?"#00E5FF":w.level>=18?"#84BD00":w.level>=11?"#fcdc00":w.level>=4?"#74b9ff":"#aaa";
          const grenSize=(w.level>=25?6:w.level>=18?5:w.level>=11?4:3)*s;
          this.grenades.push({
            x:w.x+dw*0.3,y:w.y-dh*0.35,
            startX:w.x+dw*0.3,startY:w.y-dh*0.35,
            targetX:target.x,targetY:target.y-20*s,
            age:0,duration:40+Math.floor(Math.random()*20),
            color:grenColor,size:grenSize,
            exploded:false,explodeTimer:0
          });
          // Level-up floating text
          this.floatingTexts.push({
            x:w.x-20*s,y:w.y-this.spriteDH*0.55,
            text:"LEVEL "+w.level+"!",color:"#FFD700",
            age:0,duration:120
          });
        }
        w.prevLevel=w.level;
      }else{
        w.prevLevel=w.level;
      }
    });
    // Update grenades (parabolic arc)
    this.grenades.forEach(g=>{
      if(!g.exploded){
        g.age++;
        const t=Math.min(g.age/g.duration,1);
        g.x=g.startX+(g.targetX-g.startX)*t;
        const arcHeight=80*s;
        g.y=g.startY+(g.targetY-g.startY)*t-Math.sin(t*Math.PI)*arcHeight;
        if(t>=1){g.exploded=true;g.explodeTimer=0}
      }else{
        g.explodeTimer++;
      }
    });
    this.grenades=this.grenades.filter(g=>!g.exploded||g.explodeTimer<30);

    // Update floating texts
    this.floatingTexts.forEach(ft=>{ft.age++;ft.y-=0.8*s});
    this.floatingTexts=this.floatingTexts.filter(ft=>ft.age<ft.duration);

    // Air strike detection — 20+ tickets closed in the last hour
    const nowMs=Date.now();
    if(!this.lastHourCheckTime||nowMs-this.lastHourCheckTime>30000){ // Check every 30s
      this.lastHourCheckTime=nowMs;
      const oneHourAgo=new Date(nowMs-3600000);
      const recentClosed=closedTix.filter(t=>t.dateClosed&&t.dateClosed>oneHourAgo).length;
      if(recentClosed>=20&&recentClosed!==this.lastHourClosedCount&&this.lastHourClosedCount<20){
        // Trigger air strike across enemy positions
        const liveEnemies=this.enemies.filter(e=>!e.dying&&!e.dead);
        if(liveEnemies.length){
          const strikeCount=Math.min(8,Math.max(4,Math.floor(liveEnemies.length/5)));
          const strikeXs=[];
          for(let i=0;i<strikeCount;i++){
            const target=liveEnemies[Math.floor(Math.random()*liveEnemies.length)];
            strikeXs.push(target.x+(Math.random()-0.5)*30*s);
          }
          strikeXs.sort((a,b)=>a-b);
          this.airStrikes.push({age:0,duration:180,strikeCount,strikeXs});
        }
      }
      this.lastHourClosedCount=recentClosed;
    }
    // Update air strikes
    this.airStrikes.forEach(as=>{as.age++});
    this.airStrikes=this.airStrikes.filter(as=>as.age<as.duration);

    // Update projectiles
    this.projectiles.forEach(p=>{p.x+=p.vx;p.age++});
    this.projectiles=this.projectiles.filter(p=>p.age<p.life&&p.x<this.canvas.width);
  },

  drawWarrior(x,y,w){
    const c=this.ctx,s=this.scale;
    const hovered=this.hoveredEntity&&this.hoveredEntity.type==="warrior"&&this.hoveredEntity.id===w.id;
    const bob=Math.sin(w.bobPhase)*2*s;
    const yy=y+bob;

    // Sprite dimensions on canvas
    const dh=this.spriteDH;
    const dw=dh*(this.spriteFrameW/this.spriteFrameH);
    const frameIdx=Math.floor(w.frame/18)%this.spriteFrames;
    const sx=frameIdx*this.spriteFrameW+SPRITE_INSET;

    // Get robot config for this agent — use body color for tinting
    const rCfg=getRobotConfigForAgent(w.name);
    const robotColorObj=ROBOT_COLORS.find(rc=>rc.id===rCfg.color);
    const tintColor=robotColorObj?robotColorObj.hex:w.color;

    // Shadow on ground
    c.fillStyle="rgba(0,0,0,0.25)";
    c.beginPath();c.ellipse(x,y+10*s,dw*0.35,4*s,0,0,Math.PI*2);c.fill();
    // Character occupies roughly y 111-258 of 369px frame, so bottom 30% is empty
    const groundOffset=dh*0.38;
    const hatId=rCfg.accessory||"none";
    const tinted=hatSpritesReady?this.getTintedSprite(hatId,tintColor):null;
    if(tinted){
      c.drawImage(tinted,sx,0,this.spriteFrameW-SPRITE_INSET*2,this.spriteFrameH,x-dw/2,yy-dh+groundOffset,dw,dh);
    }else{
      c.fillStyle=tintColor;
      c.fillRect(x-12*s,yy-30*s,24*s,30*s);
    }

    // Hover detected via hitbox only, no visual indicator

    // Muzzle flash when attacking — color matches weapon type
    if(w.attacking&&w.atkFrame<6){
      const wpn=w.weapon||"pistol";
      const gunColor=wpn==="railgun"?"#00E5FF":wpn==="laser"?"#84BD00":wpn==="plasma"?"#fcdc00":wpn==="rifle"?"#74b9ff":"#888";
      const flashSize=(6-w.atkFrame)*s*(wpn==="railgun"?2:wpn==="plasma"?1.8:1.5);
      c.fillStyle=gunColor;
      c.globalAlpha=0.7;
      c.beginPath();c.arc(x+dw*0.45,yy-dh*0.15,flashSize,0,Math.PI*2);c.fill();
      c.globalAlpha=1;
    }

    // HP bar removed - shown on player cards instead
  },

  drawCommander(x,y,cmd){
    const c=this.ctx,s=this.scale;
    const bob=Math.sin(cmd.bobPhase)*2*s;
    const yy=y+bob;

    // Commander same size as regular warriors
    const dh=this.spriteDH;
    const dw=dh*(this.spriteFrameW/this.spriteFrameH);
    const frameIdx=Math.floor(cmd.frame/18)%this.spriteFrames;
    const sx=frameIdx*this.spriteFrameW+SPRITE_INSET;

    const rCfg=getRobotConfigForAgent(cmd.name);
    const robotColorObj=ROBOT_COLORS.find(rc=>rc.id===rCfg.color);
    const tintColor=robotColorObj?robotColorObj.hex:cmd.color;

    // Shadow
    c.fillStyle="rgba(0,0,0,0.3)";
    c.beginPath();c.ellipse(x,y+10*s,dw*0.35,4*s,0,0,Math.PI*2);c.fill();

    const groundOffset=dh*0.38;
    const hatId=rCfg.accessory||"none";
    const tinted=hatSpritesReady?this.getTintedSprite(hatId,tintColor):null;
    if(tinted){
      c.drawImage(tinted,sx,0,this.spriteFrameW-SPRITE_INSET*2,this.spriteFrameH,x-dw/2,yy-dh+groundOffset,dw,dh);
    }else{
      c.fillStyle=tintColor;
      c.fillRect(x-15*s,yy-38*s,30*s,38*s);
    }

    // Muzzle flash when attacking
    if(cmd.attacking&&cmd.atkFrame<6){
      const wpn=cmd.weapon||"railgun";
      const gunColor=wpn==="railgun"?"#00E5FF":wpn==="laser"?"#84BD00":wpn==="plasma"?"#fcdc00":"#888";
      const flashSize=(6-cmd.atkFrame)*s*(wpn==="railgun"?2:wpn==="plasma"?1.8:1.5);
      c.fillStyle=gunColor;
      c.globalAlpha=0.7;
      c.beginPath();c.arc(x+dw*0.45,yy-dh*0.15,flashSize,0,Math.PI*2);c.fill();
      c.globalAlpha=1;
    }
  },

  drawEnemy(x,y,e){
    const c=this.ctx,s=this.scale;
    const hovered=this.hoveredEntity&&this.hoveredEntity.type==="enemy"&&this.hoveredEntity.id===e.id;
    const bob=(e.dying||e.dead)?0:Math.sin(e.bobPhase)*2*s;
    const yy=y+bob;
    const tier=e.tier||"small";
    const dh=this.enemySizes[tier].dh;
    const dw=dh*(169/369);
    const frameIdx=Math.floor(e.frame/18)%4;
    const sx=frameIdx*169;
    const groundOffset=dh*0.30;

    // Death animation: tilt over, flash red, fade out
    if(e.dying){
      const prog=e.deathTimer/e.deathDuration; // 0→1
      const fade=1-prog;
      const tilt=prog*Math.PI*0.45; // Tilt up to ~80 degrees
      const sinkY=prog*12*s; // Sink into ground
      // Initial hit flash (first 15% of death)
      if(prog<0.15){
        c.globalAlpha=0.6*(1-prog/0.15);
        c.fillStyle="#FF4444";
        c.beginPath();c.arc(x,yy-dh*0.3+groundOffset,dw*0.5,0,Math.PI*2);c.fill();
        c.globalAlpha=1;
      }
      // Shadow shrinks as enemy falls
      c.fillStyle="rgba(0,0,0,"+(0.2*fade)+")";
      c.beginPath();c.ellipse(x,y+4*s,dw*0.35*fade,4*s*fade,0,0,Math.PI*2);c.fill();
      // Draw tilting, fading sprite
      c.save();
      c.globalAlpha=fade;
      c.translate(x,yy+groundOffset+sinkY);
      c.rotate(tilt);
      c.translate(-x,-(yy+groundOffset+sinkY));
      const sheet=this.enemySheets[tier];
      if(sheet){
        c.drawImage(sheet,sx,0,169,369,x-dw/2,yy-dh+groundOffset+sinkY,dw,dh);
      }else{
        const sz=e.size*s*0.85;
        c.fillStyle=e.color;
        c.fillRect(x-sz,yy-sz*2+sinkY,sz*2,sz*2);
      }
      c.restore();
      // Defeat sparks in the first half
      if(prog<0.5&&this.frame%3===0){
        c.fillStyle="rgba(255,200,50,"+(0.7*(1-prog*2))+")";
        for(let i=0;i<3;i++){
          const sparkX=x+(Math.random()-0.5)*dw*0.8;
          const sparkY=yy-dh*0.3+groundOffset+(Math.random()-0.5)*dh*0.3;
          c.fillRect(sparkX,sparkY,3*s,3*s);
        }
      }
      return; // Skip normal drawing
    }

    // Dead corpse — fully tilted, faded, lying on ground
    if(e.dead){
      const sinkY=12*s;
      // Faint shadow
      c.fillStyle="rgba(0,0,0,0.06)";
      c.beginPath();c.ellipse(x,y+4*s,dw*0.2,2*s,0,0,Math.PI*2);c.fill();
      // Draw fully tilted, very faded sprite
      c.save();
      c.globalAlpha=0.15;
      c.translate(x,yy+groundOffset+sinkY);
      c.rotate(Math.PI*0.45);
      c.translate(-x,-(yy+groundOffset+sinkY));
      const dsheet=this.enemySheets[tier];
      if(dsheet){
        c.drawImage(dsheet,0,0,169,369,x-dw/2,yy-dh+groundOffset+sinkY,dw,dh);
      }else{
        const sz=e.size*s*0.85;
        c.fillStyle=e.color;
        c.fillRect(x-sz,yy-sz*2+sinkY,sz*2,sz*2);
      }
      c.restore();
      return;
    }

    // Shadow on ground
    c.fillStyle="rgba(0,0,0,0.2)";
    c.beginPath();c.ellipse(x,y+4*s,dw*0.35,4*s,0,0,Math.PI*2);c.fill();

    // Draw sprite
    const sheet=this.enemySheets[tier];
    if(sheet){
      c.drawImage(sheet,sx,0,169,369,x-dw/2,yy-dh+groundOffset,dw,dh);
    }else{
      // Fallback
      const sz=e.size*s*0.85;
      c.fillStyle=e.color;
      c.fillRect(x-sz,yy-sz*2,sz*2,sz*2);
    }

    // Hover detected via hitbox only, no visual indicator
  },

  drawBackground(){
    const c=this.ctx;
    const W=this.canvas.width,H=this.canvas.height,s=this.scale;

    // Sky gradient
    const grad=c.createLinearGradient(0,0,0,H);
    grad.addColorStop(0,"#0B1929");
    grad.addColorStop(0.3,"#162D50");
    grad.addColorStop(0.6,"#1A3355");
    grad.addColorStop(0.85,"#1F3D1F");
    grad.addColorStop(1,"#2A4A20");
    c.fillStyle=grad;
    c.fillRect(0,0,W,H);

    // Stars
    c.fillStyle="rgba(255,255,255,0.4)";
    for(let i=0;i<25;i++){
      const sx=(i*137+53)%W,sy=(i*89+17)%(H*0.5);
      const twinkle=Math.sin(this.frame*0.03+i*2)*0.3+0.7;
      c.globalAlpha=twinkle*0.5;
      c.fillRect(sx,sy,s,s);
    }
    c.globalAlpha=1;

    // Distant mountains/hills
    c.fillStyle="rgba(15,30,15,0.8)";
    c.beginPath();c.moveTo(-10,H);
    for(let x=-10;x<=W+10;x+=30*s){
      c.lineTo(x,H*0.5+Math.sin(x*0.003)*20*s+Math.sin(x*0.007)*12*s);
    }
    c.lineTo(W+10,H);c.closePath();c.fill();

    // Ground / grass area
    const gy=this.groundY;
    c.fillStyle="#2D5A1E";
    c.fillRect(0,gy-4*s,W,H-gy+4*s);
    c.fillStyle="#3A7A28";
    c.fillRect(0,gy-4*s,W,3*s);
    // Grass tufts
    c.fillStyle="#4A9A30";
    for(let i=0;i<W;i+=6*s){
      const gh=3*s+Math.sin(i*0.5+this.frame*0.02)*s;
      c.fillRect(i,gy-4*s-gh,2*s,gh);
    }
    // Dirt texture
    c.fillStyle="#3D6B26";
    for(let i=0;i<W;i+=12*s){
      c.fillRect(i+Math.sin(i)*4*s,gy+2*s,3*s,2*s);
    }

    // Battle dust/particles at front line
    const fx=this._fxAbs||this.contentLeft+0.5*(this.contentRight-this.contentLeft);
    c.fillStyle="rgba(180,160,120,0.05)";
    for(let i=0;i<6;i++){
      const dx=Math.sin(this.frame*0.04+i*1.3)*30*s;
      const dy=Math.cos(this.frame*0.03+i*2)*15*s;
      c.beginPath();c.arc(fx+dx,gy-20*s+dy,10*s+Math.sin(this.frame*0.06+i)*4*s,0,Math.PI*2);c.fill();
    }

    // Spark effects at clash
    if(this.frame%2===0){
      c.fillStyle="rgba(255,255,200,0.2)";
      for(let i=0;i<3;i++){
        const sx=fx+Math.random()*30*s-15*s;
        const sy=gy-Math.random()*40*s;
        c.fillRect(sx,sy,2*s,2*s);
      }
    }
  },

  checkHover(mx,my,clientX,clientY){
    const tooltip=document.getElementById("battleTooltip");
    let found=null;
    const s=this.scale;
    // Check commanders first (larger hitbox)
    for(const cmd of this.commanders){
      const cdh=this.spriteDH*1.25;
      const cdw=cdh*(this.spriteFrameW/this.spriteFrameH);
      if(mx>=cmd.x-cdw/2&&mx<=cmd.x+cdw/2&&my>=cmd.y-cdh*0.42&&my<=cmd.y+4*s){
        found={type:"commander",id:cmd.id,entity:cmd};break;
      }
    }
    if(!found){
      for(const w of this.warriors){
        const dh=this.spriteDH;
        const dw=dh*(this.spriteFrameW/this.spriteFrameH);
        if(mx>=w.x-dw/2&&mx<=w.x+dw/2&&my>=w.y-dh*0.42&&my<=w.y+4*s){
          found={type:"warrior",id:w.id,entity:w};break;
        }
      }
    }
    if(!found){
      for(const e of this.enemies){
        if(e.dying||e.dead)continue; // Skip dying/dead enemies for hover
        const tier=e.tier||"small";
        const edh=this.enemySizes[tier].dh;
        const edw=edh*(169/369);
        const eGO=edh*0.30;
        const bob=Math.sin(e.bobPhase)*2*s;
        const eyy=e.y+bob;
        // Character art occupies roughly 30%-70% of frame height
        const hitTop=eyy-edh*0.70+eGO;
        const hitBot=eyy-edh*0.10+eGO;
        if(mx>=e.x-edw*0.4&&mx<=e.x+edw*0.4&&my>=hitTop&&my<=hitBot){
          found={type:"enemy",id:e.id,entity:e};break;
        }
      }
    }
    this.hoveredEntity=found;
    if(found){
      let html="";
      if(found.type==="commander"){
        const cmd=found.entity;
        html=`<div style="font-weight:700;font-size:12px;margin-bottom:4px;color:${cmd.color}">${cmd.name}</div>`;
        html+=`<div style="font-size:10px;color:#FFD700;font-weight:700;letter-spacing:1px;text-transform:uppercase">Commander</div>`;
      }else if(found.type==="warrior"){
        const w=found.entity;
        const tt=actTix.filter(x=>x.assignedTo===w.id);
        let rank;
        if(w.level>=25)rank='<span style="color:#00E5FF">NIGHTMARE</span>';
        else if(w.level>=18)rank='<span style="color:#84BD00">ULTRA VIOLENCE</span>';
        else if(w.level>=11)rank='<span style="color:#fcdc00">HURT ME PLENTY</span>';
        else rank='<span style="color:#fcdc00">ASPIRING SLAYER</span>';
        html=`<div style="line-height:1.2"><div style="font-weight:700;font-size:12px;margin-bottom:2px;color:${w.color}">${esc(w.name)}</div>`;
        html+=`<div style="font-size:9px;color:var(--text-muted);margin-bottom:2px">Lvl ${w.level} \u00b7 ${rank}</div>`;
        html+=`<div style="font-size:9px;margin-bottom:2px">HP: <span style="color:${w.hp>=60?"#84BD00":w.hp>=30?"#fcdc00":"#fb9e00"}">${w.hp}/100</span></div></div>`;
      }else{
        const tk=found.entity.ticketRef;
        if(tk){
          const stC=SC[tk.status]||"var(--text-dim)";
          html=`<div style="line-height:1.2"><div style="font-weight:700;font-size:11px;color:var(--blue);margin-bottom:2px">${esc(tk.id)}</div>`;
          html+=`<div style="font-size:9px;color:var(--text-muted);margin-bottom:2px">${esc(tk.category)}</div>`;
          html+=`<div style="font-size:9px"><span style="color:${stC}">${esc(tk.status)}</span> \u00b7 ${tk.est}h est</div></div>`;
        }
      }
      tooltip.innerHTML=html;tooltip.style.display="block";
      const rect=this.canvas.parentElement.getBoundingClientRect();
      tooltip.style.left=Math.min(clientX-rect.left+12,rect.width-230)+"px";
      const tipH=tooltip.offsetHeight||80;
      tooltip.style.top=(clientY-rect.top-tipH-14)+"px";
    }else{tooltip.style.display="none"}
  },

  render(){
    if(!this.ctx)return;
    const c=this.ctx,s=this.scale;
    this.drawBackground();
    // Draw entities sorted by y for depth (commanders, warriors, enemies)
    const all=[
      ...this.enemies.map(e=>({type:"e",e,y:e.y})),
      ...this.warriors.map(w=>({type:"w",w,y:w.y})),
      ...this.commanders.map(cmd=>({type:"cmd",cmd,y:cmd.y}))
    ];
    all.sort((a,b)=>a.y-b.y);
    all.forEach(item=>{
      if(item.type==="w")this.drawWarrior(item.w.x,item.w.y,item.w);
      else if(item.type==="cmd")this.drawCommander(item.cmd.x,item.cmd.y,item.cmd);
      else this.drawEnemy(item.e.x,item.e.y,item.e);
    });
    // Draw projectiles on top
    this.projectiles.forEach(p=>{
      const shape=p.shape||"bolt";
      if(shape==="orb"){
        // Plasma orb — glowing circle with halo
        c.fillStyle=p.color;
        c.globalAlpha=0.2;
        c.beginPath();c.arc(p.x,p.y,p.size*2.5,0,Math.PI*2);c.fill();
        c.globalAlpha=0.5;
        c.beginPath();c.arc(p.x,p.y,p.size*1.2,0,Math.PI*2);c.fill();
        c.globalAlpha=1;
        c.beginPath();c.arc(p.x,p.y,p.size*0.7,0,Math.PI*2);c.fill();
        c.fillStyle="#fff";c.globalAlpha=0.7;
        c.beginPath();c.arc(p.x,p.y,p.size*0.3,0,Math.PI*2);c.fill();
        c.globalAlpha=1;
      }else if(shape==="beam"){
        // Beam — elongated glowing bar
        if(p.trail){
          c.globalAlpha=0.25;
          c.fillStyle=p.color;
          c.fillRect(p.x-p.size*5,p.y-p.size*0.2,p.size*5,p.size*0.4);
          c.globalAlpha=0.1;
          c.fillRect(p.x-p.size*9,p.y-p.size*0.1,p.size*4,p.size*0.2);
          c.globalAlpha=1;
        }
        c.fillStyle=p.color;
        c.fillRect(p.x-p.size*1.5,p.y-p.size*0.35,p.size*3,p.size*0.7);
        c.fillStyle="#fff";c.globalAlpha=0.7;
        c.fillRect(p.x-p.size*0.8,p.y-p.size*0.15,p.size*1.6,p.size*0.3);
        c.globalAlpha=1;
        // End glow
        c.fillStyle=p.color;c.globalAlpha=0.2;
        c.beginPath();c.arc(p.x+p.size*1.5,p.y,p.size,0,Math.PI*2);c.fill();
        c.globalAlpha=1;
      }else{
        // Bolt (pistol/rifle) — original style
        if(p.trail){
          c.globalAlpha=0.3;
          c.fillStyle=p.color;
          c.fillRect(p.x-p.size*3,p.y-p.size*0.3,p.size*3,p.size*0.6);
          c.globalAlpha=0.15;
          c.fillRect(p.x-p.size*6,p.y-p.size*0.2,p.size*3,p.size*0.4);
          c.globalAlpha=1;
        }
        c.fillStyle=p.color;
        c.fillRect(p.x-p.size,p.y-p.size*0.4,p.size*2,p.size*0.8);
        c.fillStyle="#fff";c.globalAlpha=0.6;
        c.fillRect(p.x-p.size*0.5,p.y-p.size*0.2,p.size,p.size*0.4);
        c.globalAlpha=1;
        c.fillStyle=p.color;c.globalAlpha=0.15;
        c.beginPath();c.arc(p.x,p.y,p.size*2,0,Math.PI*2);c.fill();
        c.globalAlpha=1;
      }
    });
    // Draw grenades
    this.grenades.forEach(g=>{
      if(!g.exploded){
        // Grenade in flight — spinning circle with trail
        const trailLen=5;
        for(let i=trailLen;i>=0;i--){
          const tt=Math.max(0,(g.age-i*2)/g.duration);
          const tx=g.startX+(g.targetX-g.startX)*tt;
          const ty=g.startY+(g.targetY-g.startY)*tt-Math.sin(tt*Math.PI)*80*s;
          c.globalAlpha=0.1+0.15*(trailLen-i)/trailLen;
          c.fillStyle=g.color;
          c.beginPath();c.arc(tx,ty,g.size*0.5,0,Math.PI*2);c.fill();
        }
        c.globalAlpha=1;
        // Main grenade body
        c.fillStyle=g.color;
        c.beginPath();c.arc(g.x,g.y,g.size,0,Math.PI*2);c.fill();
        // Bright core
        c.fillStyle="#fff";c.globalAlpha=0.5;
        c.beginPath();c.arc(g.x,g.y,g.size*0.4,0,Math.PI*2);c.fill();
        c.globalAlpha=1;
      }else{
        // Explosion effect
        const ep=g.explodeTimer/30;
        const radius=g.size*(3+ep*12);
        // Outer blast
        c.globalAlpha=0.6*(1-ep);
        c.fillStyle=g.color;
        c.beginPath();c.arc(g.targetX,g.targetY,radius,0,Math.PI*2);c.fill();
        // Inner flash
        c.globalAlpha=0.8*(1-ep);
        c.fillStyle="#FFF";
        c.beginPath();c.arc(g.targetX,g.targetY,radius*0.4,0,Math.PI*2);c.fill();
        // Sparks
        if(ep<0.6){
          c.fillStyle=g.color;c.globalAlpha=0.7*(1-ep);
          for(let i=0;i<5;i++){
            const ang=i*Math.PI*2/5+g.explodeTimer*0.2;
            const dist=radius*(0.5+ep);
            c.fillRect(g.targetX+Math.cos(ang)*dist,g.targetY+Math.sin(ang)*dist,3*s,3*s);
          }
        }
        c.globalAlpha=1;
      }
    });
    // Draw floating XP texts
    this.floatingTexts.forEach(ft=>{
      const prog=ft.age/ft.duration;
      const fade=prog<0.2?1:1-(prog-0.2)/0.8; // Full opacity first 20%, then fade
      const fontSize=Math.round(11*s);
      c.font="bold "+fontSize+"px monospace";
      c.globalAlpha=fade;
      c.fillStyle="#000";
      c.fillText(ft.text,ft.x+1*s,ft.y+1*s); // Shadow
      c.fillStyle=ft.color;
      c.fillText(ft.text,ft.x,ft.y);
      c.globalAlpha=1;
    });
    // Draw air strikes
    this.airStrikes.forEach(as=>{
      const prog=as.age/as.duration;
      if(prog<0.15){
        // Incoming warning lines from top
        const warnAlpha=0.4*Math.sin(as.age*0.5);
        c.strokeStyle="rgba(255,80,80,"+Math.abs(warnAlpha)+")";
        c.lineWidth=2*s;
        for(let i=0;i<as.strikeCount;i++){
          const sx=as.strikeXs[i];
          c.beginPath();c.moveTo(sx,0);c.lineTo(sx,this.canvas.height);c.stroke();
        }
      }else if(prog<0.4){
        // Explosions cascade across enemy line
        const bombProg=(prog-0.15)/0.25;
        for(let i=0;i<as.strikeCount;i++){
          const delay=i/as.strikeCount;
          const localProg=Math.max(0,Math.min(1,(bombProg-delay*0.5)/0.5));
          if(localProg<=0)continue;
          const sx=as.strikeXs[i];
          const radius=(20+localProg*40)*s;
          // Flash
          c.globalAlpha=0.7*(1-localProg);
          c.fillStyle="#FFF";
          c.beginPath();c.arc(sx,this.groundY-20*s,radius*0.4,0,Math.PI*2);c.fill();
          // Fireball
          c.fillStyle="#FF6600";
          c.beginPath();c.arc(sx,this.groundY-20*s,radius,0,Math.PI*2);c.fill();
          // Outer ring
          c.fillStyle="#FF4444";
          c.globalAlpha=0.3*(1-localProg);
          c.beginPath();c.arc(sx,this.groundY-20*s,radius*1.5,0,Math.PI*2);c.fill();
          c.globalAlpha=1;
        }
      }else{
        // Smoke/debris fading out
        const smokeProg=(prog-0.4)/0.6;
        for(let i=0;i<as.strikeCount;i++){
          const sx=as.strikeXs[i];
          c.globalAlpha=0.2*(1-smokeProg);
          c.fillStyle="#555";
          c.beginPath();c.arc(sx,this.groundY-(30+smokeProg*50)*s,15*s,0,Math.PI*2);c.fill();
        }
        c.globalAlpha=1;
      }
    });
  },

  loop(){
    if(!this.running)return;
    this.frame++;
    this.update();
    this.render();
    requestAnimationFrame(()=>this.loop());
  },

  refresh(){
    const section=document.getElementById("battleSection");
    if(roster.length&&actTix.length){
      section.classList.remove("hidden");
      if(!this.canvas)this.init();
      else{this.resize();this._needsSync=true}// Flag for smooth sync on next update()
    }else{section.classList.add("hidden")}
  }
};

// ═══════════ COMMS BOARD ═══════════
const COMMS_ROWS=10,COMMS_COLS=5;
const COMMS_REACTION_EMOJIS=["👍","🔥","😂","❤️","🎯","🚀","👀","💀","⚡","🙌"];
const COMMS_ICONS=[
  {id:"none",emoji:""},
  {id:"megaphone",emoji:"📢"},{id:"warning",emoji:"⚠️"},{id:"fire",emoji:"🔥"},{id:"star",emoji:"⭐"},
  {id:"rocket",emoji:"🚀"},{id:"wrench",emoji:"🔧"},{id:"shield",emoji:"🛡️"},{id:"bolt",emoji:"⚡"},
  {id:"skull",emoji:"💀"},{id:"target",emoji:"🎯"},{id:"clock",emoji:"⏰"},{id:"flag",emoji:"🚩"},
  {id:"lock",emoji:"🔒"},{id:"eye",emoji:"👁️"},{id:"bug",emoji:"🐛"},{id:"crown",emoji:"👑"},
  {id:"sword",emoji:"⚔️"},{id:"bomb",emoji:"💣"},{id:"medal",emoji:"🏅"},{id:"ghost",emoji:"👻"},
  {id:"diamond",emoji:"💎"},{id:"heart",emoji:"❤️"},{id:"pizza",emoji:"🍕"},{id:"coffee",emoji:"☕"},
  {id:"music",emoji:"🎵"},{id:"thumbsup",emoji:"👍"},{id:"terminal",emoji:"💻"},{id:"wifi",emoji:"📡"},
  {id:"server",emoji:"🖥️"},{id:"checkmark",emoji:"✅"},{id:"helmet",emoji:"⛑️"},{id:"flash",emoji:"🔦"}
];
const COMMS_CARD_COLORS=[
  {id:"navy",hex:"#0a1e3d",label:"Deep Navy"},
  {id:"darkblue",hex:"#002855",label:"Navy"},
  {id:"midnight",hex:"#1a1a3e",label:"Midnight"},
  {id:"charcoal",hex:"#2d2d3d",label:"Charcoal"},
  {id:"darkgreen",hex:"#0d2b1a",label:"Forest"},
  {id:"darkteal",hex:"#0a2a2a",label:"Deep Teal"},
  {id:"darkpurple",hex:"#1e0a3a",label:"Shadow Purple"},
  {id:"darkred",hex:"#2a0a0a",label:"Blood Red"},
  {id:"darkamber",hex:"#2a1f0a",label:"Dark Amber"},
  {id:"slate",hex:"#1e2a3a",label:"Slate"},
  {id:"onyx",hex:"#1a1a1a",label:"Onyx"},
  {id:"steel",hex:"#2a3040",label:"Steel"},
];
const COMMS_BORDER_COLORS=[
  {id:"blue",hex:"#0095C8",label:"Cyber Blue"},
  {id:"green",hex:"#84BD00",label:"Neon Green"},
  {id:"red",hex:"#ff5c5c",label:"Blaze Red"},
  {id:"purple",hex:"#a29bfe",label:"Phantom Purple"},
  {id:"orange",hex:"#fb9e00",label:"Volt Orange"},
  {id:"cyan",hex:"#00E5FF",label:"Ice Cyan"},
  {id:"pink",hex:"#ff6b9d",label:"Plasma Pink"},
  {id:"gold",hex:"#fcdc00",label:"Solar Gold"},
  {id:"white",hex:"#e8e8e8",label:"Ghost White"},
  {id:"teal",hex:"#2aa198",label:"Teal"},
  {id:"crimson",hex:"#dc143c",label:"Crimson"},
  {id:"lime",hex:"#32cd32",label:"Acid Lime"},
];

let commsCards=[];
let commsPlacingMode=false;
let commsSelectedSlot=null;
let commsEditingId=null;
let commsCreatorState={title:"",body:"",icon:"none",bgColor:"navy",borderColor:"blue"};

// Draw robot head on a small canvas (crop top portion of sprite)
function drawRobotHead(canvas,config){
  const ctx=canvas.getContext("2d");
  const w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);
  const c=ROBOT_COLORS.find(x=>x.id===config.color)||ROBOT_COLORS[1];
  const hatId=config.accessory||"none";
  const tinted=getTintedHatSprite(hatId,c.hex||null);
  if(tinted){
    // Crop head+body region of the 369px sprite, keeping aspect ratio
    const srcY=0,srcH=Math.round(SPRITE_FRAME_H*0.55);
    const srcX=SPRITE_INSET,srcW=SPRITE_FRAME_W-SPRITE_INSET*2;
    const aspectRatio=srcW/srcH;
    const destW=Math.min(w,h*aspectRatio);
    const destH=destW/aspectRatio;
    const destX=(w-destW)/2;
    const destY=Math.max(0,(h-destH)/2-destH*0.15);
    ctx.drawImage(tinted,srcX,srcY,srcW,srcH,destX,destY,destW,destH);
  }else{
    ctx.fillStyle=c.hex;
    ctx.fillRect(w*0.2,h*0.1,w*0.6,h*0.8);
  }
}

async function loadCommsCards(){
  try{
    const r=await fetchRetry(PROXY_BASE+"/api/comms-cards",{headers:authH()});
    if(!r||!r.ok){commsCards=[];return}
    commsCards=await r.json();
  }catch(e){console.error("Comms load error:",e);commsCards=[]}
}

function renderCommsBoard(){
  const board=document.getElementById("commsBoard");
  const emptyMsg=document.getElementById("commsBoardEmpty");
  const newBtn=document.getElementById("commsNewBtn");
  if(!board)return;

  // Show/hide new button based on login
  if(loggedInAgent)newBtn.style.display="";
  else newBtn.style.display="none";

  // Build slot map
  const slotMap={};
  commsCards.forEach(c=>{slotMap[c.grid_row+","+c.grid_col]=c});

  const hasCards=commsCards.length>0;
  // If no cards and not placing, show empty state
  if(!hasCards&&!commsPlacingMode){
    board.style.display="none";
    emptyMsg.style.display="";
    return;
  }
  board.style.display="";
  emptyMsg.style.display="none";

  // Determine how many rows to show (at least enough for all cards + 1 row, max COMMS_ROWS)
  let maxRow=0;
  commsCards.forEach(c=>{if(c.grid_row>maxRow)maxRow=c.grid_row});
  const visibleRows=commsPlacingMode?COMMS_ROWS:Math.min(COMMS_ROWS,Math.max(maxRow+2,2));

  board.innerHTML="";
  for(let r=0;r<visibleRows;r++){
    for(let c=0;c<COMMS_COLS;c++){
      const key=r+","+c;
      const card=slotMap[key];
      const slot=document.createElement("div");
      slot.className="comms-slot"+(card?" occupied":"")+(commsPlacingMode&&!card?" available":"");
      slot.dataset.row=r;
      slot.dataset.col=c;
      if(card){
        slot.appendChild(buildCommsCard(card));
      }else if(commsPlacingMode){
        slot.addEventListener("click",()=>selectCommsSlot(r,c));
        slot.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;opacity:0.3;font-size:11px;color:var(--green);font-weight:600;letter-spacing:1px">+ PLACE HERE</div>';
      }
      board.appendChild(slot);
    }
  }
}

function buildCommsCard(card){
  console.log('card.created_at:', card.created_at);
  const bgHex=(COMMS_CARD_COLORS.find(x=>x.id===card.bg_color)||COMMS_CARD_COLORS[0]).hex;
  const borderHex=(COMMS_BORDER_COLORS.find(x=>x.id===card.border_color)||COMMS_BORDER_COLORS[0]).hex;
  const iconObj=COMMS_ICONS.find(x=>x.id===card.icon);
  const iconEmoji=iconObj?iconObj.emoji:"";

  const el=document.createElement("div");
  el.className="comms-card";
  el.style.background=`linear-gradient(135deg,${bgHex},${adjustAlpha(bgHex,0.8)})`;
  el.style.border=`1px solid ${borderHex}50`;
  el.style.boxShadow=`0 0 12px ${borderHex}20,inset 0 1px 0 ${borderHex}15`;

  // Get robot config for card author
  const rCfg=getRobotConfigForAgent(card.agent_name);

  // Edit button for card owner (shown in header)
  const isOwner=loggedInAgent&&(loggedInAgent===card.agent_name);

  // Reactions
  const reactionMap={};
  (card.reactions||[]).forEach(rx=>{
    if(!reactionMap[rx.emoji])reactionMap[rx.emoji]={count:0,agents:[],mine:false};
    reactionMap[rx.emoji].count++;
    reactionMap[rx.emoji].agents.push(rx.agent_name);
    if(rx.agent_name===loggedInAgent)reactionMap[rx.emoji].mine=true;
  });

  const canvasId="comms-avatar-"+card.id;
  const _d=pD(card.created_at);
  const _dateStr=_d
    ?_d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      +' · '
      +_d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})
    :'';
  el.innerHTML=`
    <div class="comms-card-header">
      <div class="comms-card-avatar"><canvas id="${canvasId}" width="64" height="64"></canvas></div>
      <div class="comms-card-agent-group">
        <span class="comms-card-agent">${esc(card.agent_name)}</span>
        ${_dateStr?`<span class="comms-card-date">${_dateStr}</span>`:''}
      </div>
      ${iconEmoji?`<span class="comms-card-icon">${iconEmoji}</span>`:""}
    </div>
    <div class="comms-card-body">
      ${card.title?`<div class="comms-card-title">${esc(card.title)}</div>`:""}
      ${card.body?`<div class="comms-card-text">${esc(card.body)}</div>`:""}
    </div>
    <div class="comms-reactions"></div>
  `;

  // Build reaction buttons via DOM to avoid inline handlers
  const reactionsEl=el.querySelector(".comms-reactions");
  Object.keys(reactionMap).forEach(emoji=>{
    const rx=reactionMap[emoji];
    const btn=document.createElement("button");
    btn.className="comms-react-btn"+(rx.mine?" active":"");
    btn.title=rx.agents.join(", ");
    btn.innerHTML=emoji+`<span class="react-count">${rx.count}</span>`;
    btn.addEventListener("click",()=>toggleCommsReaction(card.id,emoji));
    reactionsEl.appendChild(btn);
  });

  // Add-reaction picker (signed-in agents only)
  if(loggedInAgent){
    const addSpan=document.createElement("span");
    addSpan.className="comms-react-add";
    addSpan.textContent="+";
    addSpan.addEventListener("click",(e)=>toggleEmojiPicker(e,card.id));

    const picker=document.createElement("div");
    picker.className="comms-emoji-picker";
    picker.id="ep-"+card.id;
    COMMS_REACTION_EMOJIS.forEach(emoji=>{
      const eBtn=document.createElement("button");
      eBtn.className="comms-emoji-opt";
      eBtn.textContent=emoji;
      eBtn.addEventListener("click",(e)=>{e.stopPropagation();toggleCommsReaction(card.id,emoji)});
      picker.appendChild(eBtn);
    });
    addSpan.appendChild(picker);
    reactionsEl.appendChild(addSpan);
  }

  // Edit button for card owner
  if(isOwner){
    const editBtn=document.createElement("button");
    editBtn.className="comms-edit-btn";
    editBtn.title="Edit";
    editBtn.textContent="✏️";
    editBtn.addEventListener("click",()=>editCommsCard(card.id));
    reactionsEl.appendChild(editBtn);
  }

  // Draw robot head after DOM insert via microtask
  setTimeout(()=>{
    const cvs=document.getElementById(canvasId);
    if(cvs)drawRobotHead(cvs,rCfg);
  },0);

  return el;
}

function adjustAlpha(hex,factor){
  // Darken a hex color slightly
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return`rgb(${Math.round(r*factor)},${Math.round(g*factor)},${Math.round(b*factor)})`;
}

function toggleEmojiPicker(event,cardId){
  event.stopPropagation();
  const picker=document.getElementById("ep-"+cardId);
  if(!picker)return;
  // Close all other pickers
  document.querySelectorAll(".comms-emoji-picker.open").forEach(p=>{if(p!==picker)p.classList.remove("open")});
  picker.classList.toggle("open");
}

// Close emoji pickers on outside click
document.addEventListener("click",()=>{document.querySelectorAll(".comms-emoji-picker.open").forEach(p=>p.classList.remove("open"))});

async function toggleCommsReaction(cardId,emoji){
  if(!loggedInAgent)return;
  // Close picker
  document.querySelectorAll(".comms-emoji-picker.open").forEach(p=>p.classList.remove("open"));
  try{
    const r=await fetch(PROXY_BASE+"/api/comms-reactions",{method:"POST",credentials:"include",headers:authH(),body:JSON.stringify({card_id:cardId,emoji})});
    if(r.ok){
      await loadCommsCards();
      renderCommsBoard();
    }
  }catch(e){console.error("Reaction error:",e)}
}

// New Transmission flow
document.getElementById("commsNewBtn").addEventListener("click",()=>{
  commsEditingId=null;
  commsCreatorState={title:"",body:"",icon:"none",bgColor:"navy",borderColor:"blue"};
  commsPlacingMode=true;
  commsSelectedSlot=null;
  document.getElementById("commsCreator").classList.add("hidden");
  renderCommsBoard();
});

function selectCommsSlot(row,col){
  commsSelectedSlot={row,col};
  commsPlacingMode=false;
  openCommsCreator();
}

function openCommsCreator(){
  const panel=document.getElementById("commsCreator");
  panel.classList.remove("hidden");
  // Populate pickers
  buildCommsColorPicker("commsBgColorPicker",COMMS_CARD_COLORS,"bgColor");
  buildCommsColorPicker("commsBorderColorPicker",COMMS_BORDER_COLORS,"borderColor");
  buildCommsIconPicker();
  // Restore fields
  document.getElementById("commsCardTitle").value=commsCreatorState.title;
  document.getElementById("commsCardBody").value=commsCreatorState.body;
  // Show delete button only when editing
  const delBtn=document.getElementById("commsDeleteBtn");
  delBtn.style.display=commsEditingId?"":"none";
  updateCommsPreview();
  renderCommsBoard();
}

function buildCommsColorPicker(containerId,colors,field){
  const container=document.getElementById(containerId);
  container.innerHTML="";
  colors.forEach(c=>{
    const opt=document.createElement("div");
    opt.className="robo-opt"+(commsCreatorState[field]===c.id?" active":"");
    opt.style.background=c.hex;
    opt.title=c.label;
    opt.addEventListener("click",()=>{
      commsCreatorState[field]=c.id;
      container.querySelectorAll(".robo-opt").forEach(o=>o.classList.remove("active"));
      opt.classList.add("active");
      updateCommsPreview();
    });
    container.appendChild(opt);
  });
}

function buildCommsIconPicker(){
  const container=document.getElementById("commsIconPicker");
  container.innerHTML="";
  COMMS_ICONS.forEach(ic=>{
    const opt=document.createElement("div");
    opt.className="comms-icon-opt"+(commsCreatorState.icon===ic.id?" active":"");
    opt.textContent=ic.emoji||"—";
    opt.title=ic.id;
    opt.addEventListener("click",()=>{
      commsCreatorState.icon=ic.id;
      container.querySelectorAll(".comms-icon-opt").forEach(o=>o.classList.remove("active"));
      opt.classList.add("active");
      updateCommsPreview();
    });
    container.appendChild(opt);
  });
}

function updateCommsPreview(){
  const preview=document.getElementById("commsPreviewCard");
  if(!preview)return;
  const fakeCard={
    id:"preview",
    agent_name:loggedInAgent||"Agent",
    title:document.getElementById("commsCardTitle").value||"",
    body:document.getElementById("commsCardBody").value||"",
    icon:commsCreatorState.icon,
    bg_color:commsCreatorState.bgColor,
    border_color:commsCreatorState.borderColor,
    reactions:[]
  };
  preview.innerHTML="";
  preview.appendChild(buildCommsCard(fakeCard));
}

// Live preview updates
document.getElementById("commsCardTitle").addEventListener("input",updateCommsPreview);
document.getElementById("commsCardBody").addEventListener("input",updateCommsPreview);

// Save card
document.getElementById("commsSaveBtn").addEventListener("click",async()=>{
  const title=document.getElementById("commsCardTitle").value.trim();
  const body=document.getElementById("commsCardBody").value.trim();
  if(!title&&!body){document.getElementById("commsSaveStatus").textContent="Add a title or message.";return}
  if(!commsSelectedSlot&&!commsEditingId){document.getElementById("commsSaveStatus").textContent="Select a slot first.";return}

  const payload={
    title,body,
    icon:commsCreatorState.icon,
    bg_color:commsCreatorState.bgColor,
    border_color:commsCreatorState.borderColor
  };

  try{
    let r;
    if(commsEditingId){
      r=await fetch(PROXY_BASE+"/api/comms-cards/"+commsEditingId,{method:"PUT",credentials:"include",headers:authH(),body:JSON.stringify(payload)});
    }else{
      payload.grid_row=commsSelectedSlot.row;
      payload.grid_col=commsSelectedSlot.col;
      r=await fetch(PROXY_BASE+"/api/comms-cards",{method:"POST",credentials:"include",headers:authH(),body:JSON.stringify(payload)});
    }
    if(r.ok){
      document.getElementById("commsCreator").classList.add("hidden");
      commsSelectedSlot=null;
      commsEditingId=null;
      commsCreatorState={title:"",body:"",icon:"none",bgColor:"navy",borderColor:"blue"};
      await loadCommsCards();
      renderCommsBoard();
    }else{
      const err=await r.json().catch(()=>({}));
      document.getElementById("commsSaveStatus").textContent=err.error||"Failed to save.";
    }
  }catch(e){console.error("Comms save error:",e);document.getElementById("commsSaveStatus").textContent="Network error."}
});

// Cancel
document.getElementById("commsCancelBtn").addEventListener("click",()=>{
  document.getElementById("commsCreator").classList.add("hidden");
  commsPlacingMode=false;
  commsSelectedSlot=null;
  commsEditingId=null;
  commsCreatorState={title:"",body:"",icon:"none",bgColor:"navy",borderColor:"blue"};
  renderCommsBoard();
});

// Delete from creator panel
document.getElementById("commsDeleteBtn").addEventListener("click",async()=>{
  if(!commsEditingId)return;
  if(!confirm("Delete this transmission?"))return;
  try{
    const r=await fetch(PROXY_BASE+"/api/comms-cards/"+commsEditingId,{method:"DELETE",credentials:"include",headers:authH()});
    if(r.ok){
      document.getElementById("commsCreator").classList.add("hidden");
      commsPlacingMode=false;
      commsSelectedSlot=null;
      commsEditingId=null;
      commsCreatorState={title:"",body:"",icon:"none",bgColor:"navy",borderColor:"blue"};
      await loadCommsCards();
      renderCommsBoard();
    }
  }catch(e){console.error("Comms delete error:",e)}
});

// Edit card
function editCommsCard(cardId){
  const card=commsCards.find(c=>c.id===cardId);
  if(!card||card.agent_name!==loggedInAgent)return;
  commsEditingId=cardId;
  commsSelectedSlot={row:card.grid_row,col:card.grid_col};
  commsCreatorState={
    title:card.title||"",
    body:card.body||"",
    icon:card.icon||"none",
    bgColor:card.bg_color||"navy",
    borderColor:card.border_color||"blue"
  };
  openCommsCreator();
}

// Load comms on initial data load
async function initComms(){
  await loadCommsCards();
  renderCommsBoard();
}

