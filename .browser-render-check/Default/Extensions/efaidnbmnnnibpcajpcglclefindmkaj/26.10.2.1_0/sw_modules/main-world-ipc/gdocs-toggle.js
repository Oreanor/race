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
import{floodgate as t}from"../floodgate.js";import{loggingApi as o}from"../../common/loggingApi.js";import{isSecureIpcSurfaceEnabled as c}from"./module.js";const s="gdocs-inject-hook",e=["https://docs.google.com/*"];let r=null;async function n(){return r||(r=(async()=>{try{const o=await async function(){const[o,s,e]=await Promise.all([t.hasFlag("dc-cv-google-docs-convert-to-pdf-touch-point"),t.hasFlag("dc-cv-google-sheets-convert-to-pdf-touch-point"),t.hasFlag("dc-cv-google-slides-convert-to-pdf-touch-point")]);return(o||s||e)&&c("gdocs_inject")}(),r=(await chrome.scripting.getRegisteredContentScripts({ids:[s]})).length>0;o&&!r?await chrome.scripting.registerContentScripts([{id:s,matches:e,js:["content_scripts/gdocs/main_world/gdocs-fetch-interceptor-hook.js"],runAt:"document_start",world:"MAIN"}]):!o&&r&&await chrome.scripting.unregisterContentScripts({ids:[s]})}catch(t){o.error({message:"Error toggling gdocs-inject-hook content script",error:t?.message,stack:t?.stack})}finally{r=null}})(),r)}export{n as toggleGdocsInjectHooks};