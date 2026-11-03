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
import{floodgate as t}from"../floodgate.js";import{loggingApi as n}from"../../common/loggingApi.js";import{isSecureIpcSurfaceEnabled as i}from"./module.js";const e="linkedin-inject-hook",o=["https://www.linkedin.com/*"];let r=null;async function c(){return r||(r=(async()=>{try{const n=await async function(){const n=await t.hasFlag("dc-cv-linkedin-chat-pdf-touch-point");return(!!t.getFeatureMeta("dc-cv-linkedin-pdf-touch-point-updated")||n)&&i("linkedin_inject")}(),r=(await chrome.scripting.getRegisteredContentScripts({ids:[e]})).length>0;n&&!r?await chrome.scripting.registerContentScripts([{id:e,matches:o,js:["content_scripts/linkedin/main_world/linkedin-inject-hook.js"],runAt:"document_start",world:"MAIN"}]):!n&&r&&await chrome.scripting.unregisterContentScripts({ids:[e]})}catch(t){n.error({message:"Error toggling linkedin-inject-hook content script",error:t?.message,stack:t?.stack})}finally{r=null}})(),r)}export{c as toggleLinkedinInjectHooks};