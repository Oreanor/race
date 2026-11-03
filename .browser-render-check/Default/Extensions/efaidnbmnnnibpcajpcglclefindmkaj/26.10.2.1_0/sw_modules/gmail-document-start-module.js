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
import{floodgate as t}from"./floodgate.js";import{fetchDefaultViewershipConfig as o}from"../content_scripts/utils/util.js";import{gmailConvertToPdfInit as a}from"./gmail-convert-to-pdf-module.js";import{SECURE_IPC_FLAG as i,isSecureIpcSurfaceEnabled as e}from"./main-world-ipc/module.js";async function l(l){const[c,r,s,n,m,u]=await Promise.all([t.hasFlag("dc-cv-gmail-acrobat-touch-point"),t.hasFlag("dc-cv-gmail-convert-to-pdf"),t.hasFlag("dc-cv-gmail-implicit-default-viewership"),chrome.storage.local.get("acrobat-touch-points-in-other-surfaces"),o("gmail"),t.hasFlag(i)]),f="false"!==n["acrobat-touch-points-in-other-surfaces"];let p=null;r&&(p=await new Promise(t=>{a(t)})),l({enableGmailTouchPoint:c,enableImplicitDefaultViewershipFeature:s,touchPointSettingEnabled:f,isAcrobatDefaultForSurface:m,gmailConvertToPdfConfig:p,secureIpcForGmailInject:u&&e("gmail_inject")})}export{l as gmailDocumentStartInit};