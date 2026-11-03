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
import{floodgate as e}from"../floodgate.js";import{loggingApi as t}from"../../common/loggingApi.js";import{util as i}from"../util.js";import{isImplicitDefaultViewershipEligible as r}from"../implicit-default-viewership-module.js";import{isExpressMenuEnabled as o}from"../express/express-enablement.js";import{isSecureIpcSurfaceEnabled as s}from"./module.js";const c="gdrive-inject-hook",n=["https://drive.google.com/*"];let a=null;async function d(){return a||(a=(async()=>{try{const t=await async function(){const[t,c,n,a,d,g,l]=await Promise.all([e.hasFlag("dc-cv-gdrive-default-viewership"),e.hasFlag("dc-cv-gdrive-implicit-default-viewership"),r("gdrive"),o("gdrive-native-viewer"),e.hasFlag("dc-cv-gdrive-edit-pdf"),e.hasFlag("dc-cv-gdrive-convert-excel-ppt-to-pdf"),e.hasFlag("dc-cv-gdrive-convert-image-word-to-pdf")]),p=i.isAcrobatTouchPointEnabled("acrobat-touch-point-in-gdrive"),m=t||c,v=a?.enableGdriveNativeViewerExpressMenu;return(p||m||n||v||d||g||l)&&s("gdrive_inject")}(),a=(await chrome.scripting.getRegisteredContentScripts({ids:[c]})).length>0;t&&!a?await chrome.scripting.registerContentScripts([{id:c,matches:n,js:["content_scripts/gdrive/main_world/gdrive-inject-hook.js"],runAt:"document_start",world:"MAIN"}]):!t&&a&&await chrome.scripting.unregisterContentScripts({ids:[c]})}catch(e){t.error({message:"Error toggling gdrive-inject-hook content script",error:e?.message,stack:e?.stack})}finally{a=null}})(),a)}export{d as toggleGdriveInjectHooks};