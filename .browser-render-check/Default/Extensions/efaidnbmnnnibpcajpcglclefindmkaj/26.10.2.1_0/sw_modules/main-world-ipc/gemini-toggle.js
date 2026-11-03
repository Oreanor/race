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
import{floodgate as t}from"../floodgate.js";import{loggingApi as i}from"../../common/loggingApi.js";import{isSecureIpcSurfaceEnabled as e}from"./module.js";const n="gemini-inject-hook",o=["https://gemini.google.com/*"];let r=null;async function c(){return r||(r=(async()=>{try{const i=await async function(){const[i,n,o]=await Promise.all([t.hasFlag("dc-cv-gemini-convert-pdf-add-cta"),t.hasFlag("dc-cv-gemini-convert-pdf-replace-pill"),t.hasFlag("dc-cv-gemini-response-convert-pdf")]);return(i||n||o)&&e("gemini_inject")}(),r=(await chrome.scripting.getRegisteredContentScripts({ids:[n]})).length>0;i&&!r?await chrome.scripting.registerContentScripts([{id:n,matches:o,js:["content_scripts/gemini/main_world/gemini-inject-hook.js"],runAt:"document_start",world:"MAIN"}]):!i&&r&&await chrome.scripting.unregisterContentScripts({ids:[n]})}catch(t){i.error({message:"Error toggling gemini-inject-hook content script",error:t?.message,stack:t?.stack})}finally{r=null}})(),r)}export{c as toggleGeminiInjectHooks};