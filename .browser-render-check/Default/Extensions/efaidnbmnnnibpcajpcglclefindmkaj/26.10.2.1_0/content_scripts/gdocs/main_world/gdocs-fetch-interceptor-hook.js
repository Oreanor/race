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
!function(){if(window.acrobatGdocsInjectHookInstalled)return;window.acrobatGdocsInjectHookInstalled=!0;const t=[];let e=null;setTimeout(()=>{e||(t.length=0)},1e4),Object.defineProperty(window,"__acrobat_gdocs_inject_a",{set(n){const o=Object.getOwnPropertyDescriptor(window,"__acrobat_gdocs_inject_b");o&&o.set&&(window.__acrobat_gdocs_inject_b={token:n.token,buffer:t,setActiveSend(t){e=t}})},configurable:!1,enumerable:!1});const n=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(o,c,...a){if(c&&"string"==typeof c)try{const n=new URL(c);if("docs.google.com"===n.hostname&&n.pathname.includes("/u/")){const o=n.pathname.match(/u\/([^/]+)/),c=o?o[1]:null;null!==c&&(s="acrobat-extension-authuser",r={authuser:c},e?e({eventType:s,detail:r}):(t.length>=100&&t.shift(),t.push({eventType:s,detail:r})))}}catch(t){}var s,r;return n.apply(this,[o,c,...a])}}();