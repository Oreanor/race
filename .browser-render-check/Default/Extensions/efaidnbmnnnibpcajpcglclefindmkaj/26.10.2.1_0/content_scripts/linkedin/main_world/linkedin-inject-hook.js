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
!function(){if(window.acrobatLinkedinInjectHookInstalled)return;window.acrobatLinkedinInjectHookInstalled=!0;const e=[];let n=null;setTimeout(()=>{n||(e.length=0)},1e4),Object.defineProperty(window,"__acrobat_linkedin_inject_a",{set(t){const i=Object.getOwnPropertyDescriptor(window,"__acrobat_linkedin_inject_b");i&&i.set&&(window.__acrobat_linkedin_inject_b={token:t.token,buffer:e,setActiveSend(e){n=e}})},configurable:!1,enumerable:!1});const t=window.fetch;window.fetch=function(...i){return t.apply(this,i).then(t=>(Promise.resolve().then(()=>{let i=null;try{const e=new URL(t.url);"www.linkedin.com"===e.hostname&&e.pathname.includes("/voyager/api/voyagerMessagingGraphQL/graphql")&&decodeURIComponent(e.search).includes("urn:li:msg_conversation")?i="linkedin-chat-messages-data":e.pathname.includes("feedshare-document-master-manifest")&&(i="linkedin-feed-post-data")}catch(e){}if(i)try{t.clone().text().then(t=>{var a,o;a=i,o={responseData:t},n?n({eventType:a,detail:o}):(e.length>=1e3&&e.shift(),e.push({eventType:a,detail:o}))}).catch(()=>{})}catch(e){}}),t)).catch(e=>{throw e})}}();