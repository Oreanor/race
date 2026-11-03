/*************************************************************************
* ADOBE CONFIDENTIAL
* ___________________
*
*  Copyright 2015 Adobe Systems Incorporated
*  All Rights Reserved.
*
* NOTICE:  All information contained herein is, and remains
* the property of Adobe Systems Incorporated and its suppliers,
* if any.  The intellectual and technical concepts contained
* herein are proprietary to Adobe Systems Incorporated and its
* suppliers and are protected by all applicable intellectual property laws,
* including trade secret and or copyright laws.
* Dissemination of this information or reproduction of this material
* is strictly forbidden unless prior written permission is obtained
* from Adobe Systems Incorporated.
**************************************************************************/
function e(e){const t=crypto.subtle.importKey.bind(crypto.subtle),n=crypto.subtle.encrypt.bind(crypto.subtle),r=crypto.getRandomValues.bind(crypto);Object.defineProperty(window,"__acrobat_gdrive_inject_b",{set(o){const{token:c,buffer:i,setActiveSend:a}=o;if(Array.isArray(c)&&c.length===e.length){for(let t=0;t<e.length;t+=1)if(c[t]!==e[t])return;t("raw",new Uint8Array(e),{name:"AES-GCM"},!1,["encrypt"]).then(e=>{let t=Promise.resolve();const o=({eventType:o,detail:c})=>{t=t.then(()=>{const t=r(new Uint8Array(12)),i=(new TextEncoder).encode(JSON.stringify(c));return n({name:"AES-GCM",iv:t},e,i).then(e=>{document.dispatchEvent(new CustomEvent(o,{detail:{iv:Array.from(t),ciphertext:Array.from(new Uint8Array(e))}}))}).catch(()=>{})})};a(o),i.splice(0).forEach(o)}).catch(()=>{})}},configurable:!1,enumerable:!1}),window.__acrobat_gdrive_inject_a={token:e}}export{e as gdriveInjectBridgeFunc};