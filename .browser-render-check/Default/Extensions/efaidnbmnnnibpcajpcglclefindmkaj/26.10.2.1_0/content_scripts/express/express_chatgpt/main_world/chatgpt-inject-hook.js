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
!function(){if(window.acrobatChatgptInjectHookInstalled)return;window.acrobatChatgptInjectHookInstalled=!0;const t=["/backend-api/aip/connectors/links/list_accessible"],e=[];let n=null;function c(t,c){n?n({eventType:t,detail:c}):(e.length>=1e3&&e.shift(),e.push({eventType:t,detail:c}))}setTimeout(()=>{n||(e.length=0)},1e4),Object.defineProperty(window,"__acrobat_chatgpt_inject_a",{set(t){const c=Object.getOwnPropertyDescriptor(window,"__acrobat_chatgpt_inject_b");c&&c.set&&(window.__acrobat_chatgpt_inject_b={token:t.token,buffer:e,setActiveSend(t){n=t}})},configurable:!1,enumerable:!1});const o=window.fetch;window.fetch=function(...e){return o.apply(this,e).then(e=>(Promise.resolve().then(()=>{try{const n=new URL(e.url);(function(t,e){return"chatgpt.com"===t.hostname&&e.some(e=>t.pathname.includes(e))})(n,function(){try{const e=sessionStorage.getItem("adobeAcrobatExpressConnectedAppAPIs");if(!e)return t;const n=JSON.parse(e);return Array.isArray(n)?n:t}catch{return t}}())&&e.clone().text().then(t=>{c("acrobat-chatgpt-api-response",{success:!0,responseData:t,responseUrl:e.url,status:e.status})}).catch(t=>{c("acrobat-chatgpt-api-response",{success:!1,error:t.message})})}catch{}}),e)).catch(t=>{throw t})}}();