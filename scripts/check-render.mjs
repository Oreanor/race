import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const userDataDir = path.join(os.tmpdir(), 'race-browser-render-check');
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=9338',`--user-data-dir=${userDataDir}`,'--no-first-run','--no-default-browser-check','--window-size=1440,1000','about:blank'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
try {
 let pages;
 for(let i=0;i<30;i++){try{pages=await(await fetch('http://127.0.0.1:9338/json')).json();break;}catch{await sleep(300)}}
 if(!pages)throw Error('Chrome unavailable');
 ws=new WebSocket(pages[0].webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
 let id=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')console.log(JSON.stringify(m.params.exceptionDetails));else if(m.method==='Network.loadingFailed')console.log('NETWORK',JSON.stringify(m.params));};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),20000);pending.set(n,m=>{clearTimeout(timer);m.error?reject(m.error):resolve(m.result)});ws.send(JSON.stringify({id:n,method,params}));});
 await call('Network.enable');await call('Runtime.enable');await call('Page.enable');await call('Page.navigate',{url:'http://localhost:3000'});
 for(const seconds of [5,45]){await sleep(seconds*1000);console.log((await call('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true})).result.value);}
 await call('Browser.close');
}finally{ws?.close();browser.kill();}
