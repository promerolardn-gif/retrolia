// Retrolia sin servidor: datos, fotos y ROM en el navegador (IndexedDB); IA con la clave del propio usuario.
(()=>{
const DB="retrolia", VER=1;
const abrir=new Promise((ok,ko)=>{ const r=indexedDB.open(DB,VER);
  r.onupgradeneeded=()=>{ const d=r.result; if(!d.objectStoreNames.contains("docs")) d.createObjectStore("docs"); if(!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs"); };
  r.onsuccess=()=>ok(r.result); r.onerror=()=>ko(r.error); });
const tx=(store,mode,fn)=>abrir.then(d=>new Promise((ok,ko)=>{ const t=d.transaction(store,mode); const q=fn(t.objectStore(store)); t.oncomplete=()=>ok(q&&q.result); t.onerror=()=>ko(t.error); t.onabort=()=>ko(t.error); }));
const clon=x=>x==null?x:JSON.parse(JSON.stringify(x));
const err=(code,message)=>Object.assign(new Error(message||code),{code});

// ---- Base de datos ----
const cache=new Map(); let cargado=null; const oyentes=new Set();
const canal=("BroadcastChannel" in window)?new BroadcastChannel("retrolia"):null;
function cargar(){ return cargado||(cargado=abrir.then(d=>new Promise((ok,ko)=>{ cache.clear(); const c=d.transaction("docs").objectStore("docs").openCursor();
  c.onsuccess=()=>{ const k=c.result; if(k){ cache.set(k.key,k.value); k.continue(); } else ok(); }; c.onerror=()=>ko(c.error); }))); }
const colDe=p=>p.slice(0,p.lastIndexOf("/")), idDe=p=>p.slice(p.lastIndexOf("/")+1);
const snapDoc=p=>{ const v=cache.get(p); return {id:idDe(p),exists:v!==undefined,data:()=>clon(v)}; };
const snapCol=c=>({docs:[...cache.keys()].filter(p=>colDe(p)===c).sort().map(snapDoc)});
function avisar(p,remoto){ const c=colDe(p); oyentes.forEach(o=>{ if(o.col===c||o.doc===p) queueMicrotask(()=>{ try{ o.cb(o.doc?snapDoc(o.doc):snapCol(o.col)); }catch(e){ console.error(e); } }); });
  if(!remoto&&canal) canal.postMessage(p); }
if(canal) canal.onmessage=async e=>{ const p=e.data; try{ const v=await tx("docs","readonly",s=>s.get(p)); if(v===undefined) cache.delete(p); else cache.set(p,v); avisar(p,true); }catch{} };
let persistido=false;
async function escribir(p,v){ await cargar(); if(!persistido){ persistido=true; try{ navigator.storage&&navigator.storage.persist&&navigator.storage.persist(); }catch{} }
  if(v===undefined){ await tx("docs","readwrite",s=>s.delete(p)); cache.delete(p); } else { await tx("docs","readwrite",s=>s.put(v,p)); cache.set(p,v); }
  avisar(p); }
function oir(o){ oyentes.add(o); cargar().then(()=>{ if(oyentes.has(o)) o.cb(o.doc?snapDoc(o.doc):snapCol(o.col)); },e=>o.ko&&o.ko(e)); return ()=>oyentes.delete(o); }
const db={
  collection:c=>({ onSnapshot:(cb,ko)=>oir({col:c,cb,ko}), doc:id=>db.doc(c+"/"+id), get:async()=>{ await cargar(); return snapCol(c); } }),
  doc:p=>({ get:async()=>{ await cargar(); return snapDoc(p); }, set:d=>escribir(p,clon(d)),
    update:async d=>{ await cargar(); if(!cache.has(p)) throw err("not_found"); return escribir(p,{...cache.get(p),...clon(d)}); },
    delete:()=>escribir(p,undefined), onSnapshot:(cb,ko)=>oir({doc:p,cb,ko}) }) };

// ---- Archivos (fotos, capturas, ROM) ----
const nuevoId=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,"0")).join("");
const assets={
  upload:async(blob,o)=>{ const id=nuevoId(), type=(o&&o.type)||blob.type||"application/octet-stream";
    try{ await tx("blobs","readwrite",s=>s.put({blob,type},id)); }catch(e){ throw err(e&&e.name==="QuotaExceededError"?"too_large":"upstream_error"); }
    return {id,url:"blob/"+id,sizeBytes:blob.size,contentType:type}; },
  delete:id=>tx("blobs","readwrite",s=>s.delete(id)),
  list:async()=>({assets:[],usage:null}) };

// ---- Descargas ----
const downloads={ save:async({filename,data})=>{ const b=data instanceof Blob?data:new Blob([data]); const u=URL.createObjectURL(b), a=document.createElement("a");
  a.href=u; a.download=filename||"retrolia"; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),30000); } };

// ---- IA con la clave del usuario ----
const IA_KEY="retrolia.ia";
const iaCfg=()=>{ try{ return JSON.parse(localStorage.getItem(IA_KEY)||"{}")||{}; }catch{ return {}; } };
const b64=blob=>new Promise((ok,ko)=>{ const r=new FileReader(); r.onload=()=>ok(String(r.result).split(",")[1]); r.onerror=()=>ko(r.error); r.readAsDataURL(blob); });
const codigo=s=>s===429?"rate_limited":(s===400||s===401||s===403||s===404)?"bad_key":"upstream_error";
const GEM="https://generativelanguage.googleapis.com/v1beta/";
async function modelosGemini(key){ const r=await fetch(GEM+"models?pageSize=200",{headers:{"x-goog-api-key":key}}); if(!r.ok) throw err(codigo(r.status));
  const j=await r.json(); const ver=n=>{ const m=/gemini-(\d+(?:\.\d+)?)/.exec(n); return m?+m[1]:0; };
  return (j.models||[]).filter(m=>(m.supportedGenerationMethods||[]).includes("generateContent")).map(m=>m.name.replace(/^models\//,""))
    .filter(n=>/^gemini-.*flash/.test(n)&&!/lite|tts|live|image|audio|transcri|embed|thinking|exp/.test(n))
    .sort((a,b)=>ver(b)-ver(a)||(/preview/.test(a)-/preview/.test(b))||a.length-b.length); }
async function modelosOpenAI(c){ const r=await fetch(c.base.replace(/\/+$/,"")+"/models",{headers:{Authorization:"Bearer "+c.key}}); if(!r.ok) throw err(codigo(r.status));
  const j=await r.json(); return (j.data||j.models||[]).map(m=>m.id||m.name).filter(Boolean).sort(); }
async function preguntar(texto,imgs){ const c=iaCfg(); if(!c.key) throw err("no_key");
  let r;
  try{
    if((c.prov||"gemini")==="gemini"){ let modelo=c.model; if(!modelo){ modelo=(await modelosGemini(c.key))[0]; if(!modelo) throw err("bad_key"); }
      const parts=[{text:texto}]; for(const i of imgs) parts.push({inline_data:{mime_type:i.type||"image/jpeg",data:await b64(i)}});
      r=await fetch(GEM+"models/"+encodeURIComponent(modelo)+":generateContent",{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":c.key},body:JSON.stringify({contents:[{parts}]})});
      if(!r.ok) throw err(codigo(r.status)); const j=await r.json();
      const t=((j.candidates||[])[0]?.content?.parts||[]).map(p=>p.text||"").join(""); if(!t) throw err(j.promptFeedback?.blockReason?"refused":"empty_completion"); return t; }
    if(!c.base||!c.model) throw err("no_key");
    const content=[{type:"text",text:texto}]; for(const i of imgs) content.push({type:"image_url",image_url:{url:"data:"+(i.type||"image/jpeg")+";base64,"+await b64(i)}});
    r=await fetch(c.base.replace(/\/+$/,"")+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+c.key},body:JSON.stringify({model:c.model,messages:[{role:"user",content:imgs.length?content:texto}]})});
    if(!r.ok) throw err(codigo(r.status)); const j=await r.json(); const m=(j.choices||[])[0]?.message?.content;
    const t=typeof m==="string"?m:Array.isArray(m)?m.map(p=>p.text||"").join(""):""; if(!t) throw err("empty_completion"); return t;
  }catch(e){ if(e&&e.code) throw e; throw err("upstream_error",String(e&&e.message||e)); } }
const entrada=i=>typeof i==="string"?i:(i||[]).map(t=>t.content).join("\n\n");
async function sample(input,o){ const text=await preguntar(entrada(input),(o&&o.images)||[]); o&&o.onText&&o.onText({text,delta:text}); return {text,truncated:false}; }
sample.json=async(input,o)=>{ const {text}=await sample(input,o); const a=text.indexOf("{"), b=text.lastIndexOf("}");
  try{ return JSON.parse(a>=0&&b>a?text.slice(a,b+1):text); }catch{ throw err("invalid_json"); } };
sample.limits=async()=>({images:{max:4}});

// ---- Arranque: las fotos se sirven desde un service worker ----
const listo=(async()=>{ if(!("serviceWorker" in navigator)) return;
  try{ await navigator.serviceWorker.register("sw.js"); await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller) await Promise.race([new Promise(ok=>navigator.serviceWorker.addEventListener("controllerchange",ok,{once:true})),new Promise(ok=>setTimeout(ok,3000))]); }catch(e){ console.warn("Sin service worker: las fotos guardadas no se verán",e); } })();
const caps={db,assets,downloads,sample};
window.claude={use:async n=>{ await listo; return caps[n]||null; }};
window.RetroliaIA={cfg:iaCfg,guardar:c=>localStorage.setItem(IA_KEY,JSON.stringify(c)),modelos:c=>(c.prov||"gemini")==="gemini"?modelosGemini(c.key):modelosOpenAI(c),probar:()=>preguntar("Responde solo con la palabra: listo",[])};
window.RetroliaDatos={importar:async j=>{ await cargar(); let n=0; for(const g of (j.juegos||[])){ if(!g||!g.id) continue; const {id,...d}=g; await escribir("juegos/"+id,clon(d)); n++; }
  for(const t of (j.tareas||[])){ if(!t||!t.id) continue; const {id,...d}=t; await escribir("tareas/"+id,clon(d)); }
  if(j.ajustes) await escribir("ajustes/general",clon(j.ajustes)); return n; }};
})();
