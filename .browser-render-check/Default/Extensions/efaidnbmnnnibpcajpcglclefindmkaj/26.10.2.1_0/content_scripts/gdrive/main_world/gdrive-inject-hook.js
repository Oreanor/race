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
!function(){if(window.acrobatGdriveInjectHookInstalled)return;window.acrobatGdriveInjectHookInstalled=!0;const e=[];let t=null;function n(n,s){t?t({eventType:n,detail:s}):(e.length>=1e3&&e.shift(),e.push({eventType:n,detail:s}))}setTimeout(()=>{t||(e.length=0)},1e4),Object.defineProperty(window,"__acrobat_gdrive_inject_a",{set(n){const s=Object.getOwnPropertyDescriptor(window,"__acrobat_gdrive_inject_b");s&&s.set&&(window.__acrobat_gdrive_inject_b={token:n.token,buffer:e,setActiveSend(e){t=e}})},configurable:!1,enumerable:!1});const s=XMLHttpRequest.prototype,o=s.send;s.send=function(...e){let t="";return this.addEventListener("progress",function(){if(!this.responseURL.includes("/cloudsearch/request"))return;const e=this.responseText.slice(t.length);t+=e,e.includes("table cellpadding")&&(n("gdrive-search-bar-api-response",{searchResponse:t}),t="")}),this.addEventListener("load",function(){try{const e=new URL(this.responseURL);"clients6.google.com"===e.hostname&&e.pathname.includes("/drive/v2internal/apps")&&n("acrobat-addon-status-data",{responseData:this.response,url:this.responseURL})}catch{}}),o.apply(this,e)}}();