// Retrolia: sirve las fotos, capturas y ROM guardadas en el navegador (IndexedDB) en la ruta blob/<id>
const DB="retrolia", VER=1;
function abrir(){ return new Promise((ok,ko)=>{ const r=indexedDB.open(DB,VER);
  r.onupgradeneeded=()=>{ const d=r.result; if(!d.objectStoreNames.contains("docs")) d.createObjectStore("docs"); if(!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs"); };
  r.onsuccess=()=>ok(r.result); r.onerror=()=>ko(r.error); }); }
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{ const m=/\/blob\/([0-9a-f]{32})$/.exec(new URL(e.request.url).pathname); if(!m) return;
  e.respondWith((async()=>{ try{ const d=await abrir(); const v=await new Promise((ok,ko)=>{ const q=d.transaction("blobs").objectStore("blobs").get(m[1]); q.onsuccess=()=>ok(q.result); q.onerror=()=>ko(q.error); }); d.close();
      if(!v) return new Response("",{status:404});
      return new Response(v.blob,{headers:{"Content-Type":v.type||v.blob.type||"application/octet-stream","Cache-Control":"no-store"}}); }
    catch{ return new Response("",{status:500}); } })()); });
