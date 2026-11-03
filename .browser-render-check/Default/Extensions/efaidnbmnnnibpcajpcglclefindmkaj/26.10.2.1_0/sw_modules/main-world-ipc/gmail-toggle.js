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
import{floodgate as t}from"../floodgate.js";import{loggingApi as i}from"../../common/loggingApi.js";import{isSecureIpcSurfaceEnabled as o}from"./module.js";const a="gmail-inject-hook",c=["https://mail.google.com/*"];let r=null;async function e(){return r||(r=(async()=>{try{const i=await async function(){const[i,a,c,r]=await Promise.all([t.hasFlag("dc-cv-gmail-acrobat-touch-point"),t.hasFlag("dc-cv-gmail-pdftools-touch-point"),t.hasFlag("dc-cv-gmail-implicit-default-viewership"),t.hasFlag("dc-cv-gmail-default-viewership")]);return(i||a||c||r)&&o("gmail_inject")}(),r=(await chrome.scripting.getRegisteredContentScripts({ids:[a]})).length>0;i&&!r?await chrome.scripting.registerContentScripts([{id:a,matches:c,js:["content_scripts/gmail/main_world/gmail-inject-hook.js"],runAt:"document_start",world:"MAIN"}]):!i&&r&&await chrome.scripting.unregisterContentScripts({ids:[a]})}catch(t){i.error({message:"Error toggling gmail-inject-hook content script",error:t?.message,stack:t?.stack})}finally{r=null}})(),r)}export{e as toggleGmailInjectHooks};