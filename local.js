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
let persistido=false, silencio=false;
async function escribir(p,v){ await cargar(); if(!persistido){ persistido=true; try{ navigator.storage&&navigator.storage.persist&&navigator.storage.persist(); }catch{} }
  if(v===undefined){ await tx("docs","readwrite",s=>s.delete(p)); cache.delete(p); } else { await tx("docs","readwrite",s=>s.put(v,p)); cache.set(p,v); }
  if(!silencio&&p.startsWith("juegos/")){ try{ localStorage.setItem("retrolia.cambios",String((+localStorage.getItem("retrolia.cambios")||0)+1)); }catch{} }
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
    if(/^image\//.test(type)){ try{ localStorage.setItem("retrolia.fotos",String((+localStorage.getItem("retrolia.fotos")||0)+1)); }catch{} }
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
// Copia completa en un .zip: retrolia.json (fichas e índice) + carpeta archivos/ con fotos, capturas y ROM
let zipP=null;
const cargarZip=()=>window.JSZip?Promise.resolve(window.JSZip):(zipP||(zipP=new Promise((ok,ko)=>{ const t=document.createElement("script"); t.src="jszip.min.js"; t.onload=()=>ok(window.JSZip); t.onerror=()=>{ zipP=null; ko(err("sin_zip")); }; document.head.append(t); })));
const EXT={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","application/json":"json"};
const limpio=(t,def)=>String(t||"").replace(/[\/\\:*?"<>|\x00-\x1f]/g," ").replace(/\s+/g," ").trim().slice(0,90)||def;
const idRuta=u=>{ const m=/blob\/([0-9a-f]{32})$/.exec(String(u||"")); return m&&m[1]; };
const u8a64=u=>{ let t=""; for(let i=0;i<u.length;i+=0x8000) t+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000)); return btoa(t); };
const a64u8=t=>{ const b=atob(t), u=new Uint8Array(b.length); for(let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; };
// Nombres legibles dentro del zip: fotos/Consola_Juego.jpg, capturas/Consola_Juego_captura 1.png, roms/Consola_Juego.sfc
function nombresZip(tipos){ const nombres=new Map(), usados=new Set();
  const pon=(id,carpeta,base,ext,rom)=>{ if(!id||!tipos.has(id)||nombres.has(id)) return; let n=`${carpeta}/${base}.${ext}`, k=2; while(usados.has(n.toLowerCase())) n=`${carpeta}/${base} (${k++}).${ext}`; usados.add(n.toLowerCase()); nombres.set(id,{archivo:n,rom}); };
  [...cache.keys()].filter(p=>colDe(p)==="juegos").sort().forEach(p=>{ const g=cache.get(p)||{}, base=limpio(g.plataforma||"SNES","Sin consola")+"_"+limpio(g.titulo,"sin título");
    [...new Set([g.foto,...(g.galeria||[])].map(idRuta).filter(Boolean))].forEach((id,i)=>pon(id,"fotos",i?`${base}_${i+1}`:base,EXT[tipos.get(id)]||"jpg"));
    (g.capturas||[]).map(idRuta).filter(Boolean).forEach((id,i)=>pon(id,"capturas",`${base}_captura ${i+1}`,EXT[tipos.get(id)]||"png"));
    [g.rom,...(g.roms||[])].filter(r=>r&&r.id).forEach(r=>{ const m=/\.([a-z0-9]{1,5})$/i.exec(r.name||""); pon(r.id,"roms",r.reg?`${base} (${limpio(r.reg,"")})`:base,m?m[1].toLowerCase():"bin",true); }); });
  return nombres; }
async function exportar(){ await cargar(); const JSZip=await cargarZip(), d=await abrir;
  const [ids,vals]=await new Promise((ok,ko)=>{ const t=d.transaction("blobs"), s=t.objectStore("blobs"), a=s.getAllKeys(), b=s.getAll(); t.oncomplete=()=>ok([a.result,b.result]); t.onerror=()=>ko(t.error); });
  const docs={}; cache.forEach((v,k)=>{ docs[k]=v; });
  const tipos=new Map(ids.map((id,i)=>[id,vals[i].type||""])), nombres=nombresZip(tipos), zip=new JSZip(), blobs=[];
  for(let i=0;i<ids.length;i++){ const id=ids[i], type=vals[i].type||"", blob=vals[i].blob, n=nombres.get(id);
    if(n&&n.rom){ try{ const j=JSON.parse(await blob.text()); if(typeof j.b64!=="string") throw 0;
        blobs.push({id,type,archivo:n.archivo,rom:{name:j.name||"",crc:j.crc||""}}); zip.file(n.archivo,a64u8(j.b64),{binary:true,compression:"DEFLATE"}); continue; }catch{} }
    const archivo=n&&!n.rom?n.archivo:"otros/"+id+"."+(EXT[type]||"bin"); blobs.push({id,type,archivo});
    zip.file(archivo,blob,{binary:true,compression:/^image\//.test(type)?"STORE":"DEFLATE"}); }
  zip.file("retrolia.json",JSON.stringify({formato:"retrolia",v:3,exportado:new Date().toISOString(),docs,blobs},null,1));
  zip.file("LEEME.txt","Copia de seguridad de Retrolia.\r\n\r\nPara recuperarla: en Retrolia, pulsa \"Restaurar una copia\" y elige este .zip tal cual, sin descomprimir.\r\n\r\nfotos/      las fotos de tus juegos, como Consola_Juego.jpg\r\ncapturas/   las capturas de pantalla guardadas en las fichas\r\nroms/       las ROM guardadas, en su formato original\r\nretrolia.json   las fichas y el índice que une cada archivo con su ficha\r\n\r\nNo cambies los nombres dentro del .zip si quieres poder restaurarlo.\r\n");
  const blob=await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:6}});
  return {blob,fichas:Object.keys(docs).filter(k=>k.startsWith("juegos/")).length,archivos:ids.length}; }
async function guardarTodo(h,leer){ if(!h||h.formato!=="retrolia"||!h.docs) throw err("formato");
  for(const b of (h.blobs||[])){ const buf=await leer(b);
    try{ await tx("blobs","readwrite",s=>s.put({blob:new Blob([buf],{type:b.type}),type:b.type},b.id)); }catch(e){ throw err(e&&e.name==="QuotaExceededError"?"sin_espacio":"upstream_error"); } }
  silencio=true; let fichas=0;
  try{ for(const [p,v] of Object.entries(h.docs)){ await escribir(p,clon(v)); if(p.startsWith("juegos/")) fichas++; } } finally{ silencio=false; }
  return {fichas,archivos:(h.blobs||[]).length}; }
async function restaurar(file){ const ini=new Uint8Array(await file.slice(0,8).arrayBuffer());
  if(ini[0]===0x50&&ini[1]===0x4b){ const JSZip=await cargarZip(); let zip; try{ zip=await JSZip.loadAsync(file); }catch{ throw err("incompleta"); }
    const j=zip.file("retrolia.json"); if(!j) throw err("formato"); let h; try{ h=JSON.parse(await j.async("string")); }catch{ throw err("formato"); }
    return guardarTodo(h,async b=>{ const f=zip.file(b.archivo||""); if(!f) throw err("incompleta"); const buf=await f.async("arraybuffer");
      return b.rom?new TextEncoder().encode(JSON.stringify({name:b.rom.name,crc:b.rom.crc,b64:u8a64(new Uint8Array(buf))})).buffer:buf; }); }
  if(new TextDecoder().decode(ini)!=="RETROLIA") throw err("formato");   // formato antiguo de un solo archivo .retrolia
  const n=new DataView(await file.slice(8,12).arrayBuffer()).getUint32(0); let h; try{ h=JSON.parse(await file.slice(12,12+n).text()); }catch{ throw err("formato"); }
  let off=12+n; const total=((h&&h.blobs)||[]).reduce((a,b)=>a+b.size,0); if(off+total>file.size) throw err("incompleta");
  return guardarTodo(h,async b=>{ const buf=await file.slice(off,off+b.size).arrayBuffer(); off+=b.size; return buf; }); }
window.RetroliaDatos={exportar,restaurar,importar:async j=>{ await cargar(); let n=0; for(const g of (j.juegos||[])){ if(!g||!g.id) continue; const {id,...d}=g; await escribir("juegos/"+id,clon(d)); n++; }
  for(const t of (j.tareas||[])){ if(!t||!t.id) continue; const {id,...d}=t; await escribir("tareas/"+id,clon(d)); }
  if(j.ajustes) await escribir("ajustes/general",clon(j.ajustes)); return n; }};
})();
