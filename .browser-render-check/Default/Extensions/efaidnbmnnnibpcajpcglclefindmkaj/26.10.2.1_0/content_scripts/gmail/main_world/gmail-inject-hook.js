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
!function(){if(window.acrobatGmailInjectHookInstalled)return;window.acrobatGmailInjectHookInstalled=!0;const t=[];let e=null;function n(n,a){e?e({eventType:n,detail:a}):(t.length>=1e3&&t.shift(),t.push({eventType:n,detail:a}))}setTimeout(()=>{e||(t.length=0)},1e4),Object.defineProperty(window,"__acrobat_gmail_inject_a",{set(n){const a=Object.getOwnPropertyDescriptor(window,"__acrobat_gmail_inject_b");a&&a.set&&(window.__acrobat_gmail_inject_b={token:n.token,buffer:t,setActiveSend(t){e=t}})},configurable:!1,enumerable:!1});const a=XMLHttpRequest.prototype,o=a.send;a.send=function(...t){return this.addEventListener("load",function(){try{const t=new URL(this.responseURL);"mail.google.com"===t.hostname&&t.pathname.includes("/sync/u/")&&(t.pathname.includes("/fd")||t.pathname.includes("/i/s")||t.pathname.includes("/i/bv"))&&n("acrobat-mail-data",{responseData:this.response,url:this.responseURL})}catch{}}),o.apply(this,t)};const s=setInterval(()=>{if("function"==typeof window._GM_setData){clearInterval(s);const t=window._GM_setData;window._GM_setData=function(...e){t.apply(this,e);try{const t=e[0],a=t?.Cl6csf?"Cl6csf":"a6jdv";t[a]?.[0]?.[2]&&n("acrobat-mail-data",{responseData:t[a][0][2],key:a,url:"gmSetData"})}catch(t){}}}},50);setTimeout(()=>clearInterval(s),1e4)}();