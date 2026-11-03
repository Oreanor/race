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
const setupMainWorldReceiver=async({channels:e,signal:r})=>{const t=await crypto.subtle.generateKey({name:"AES-GCM",length:256},!0,["decrypt"]),a=await crypto.subtle.exportKey("raw",t),n=Array.from(new Uint8Array(a));return e.forEach(({eventName:e,handler:a})=>{document.addEventListener(e,async e=>{const{iv:r,ciphertext:n}=e.detail||{};if(Array.isArray(r)&&Array.isArray(n))try{const e=await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(r)},t,new Uint8Array(n)),c=JSON.parse((new TextDecoder).decode(e));a(c)}catch(e){}},{signal:r})}),{aesKeyBytes:n}};export{setupMainWorldReceiver};