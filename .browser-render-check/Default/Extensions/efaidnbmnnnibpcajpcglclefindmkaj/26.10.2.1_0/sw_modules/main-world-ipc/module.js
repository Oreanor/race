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
import{floodgate as r}from"../floodgate.js";import{loggingApi as e}from"../../common/loggingApi.js";import{MAIN_WORLD_INJECT_FUNCS as n}from"./registry.js";const s="dc-cv-main-world-script-ab-ipc";function t(){try{const e=r.getFeatureMeta(s),n=e?JSON.parse(e):{};return Array.isArray(n?.surfaces)?n.surfaces:[]}catch{return[]}}function a(r){return t().includes(r)}async function o({sender:r,func:n,args:s,errorMessageId:t}){try{const e=r.tab.id,t=Number.isInteger(r.frameId)?{tabId:e,frameIds:[r.frameId]}:{tabId:e};await chrome.scripting.executeScript({target:t,world:"MAIN",func:n,args:s})}catch(r){e.error({message:t,error:r?.message||String(r)})}}function i({request:r,sender:s,senderType:t}){if("content-script"!==t)return void e.warn({message:`[inject_main_world] dropped: sender is not a content-script (senderType=${t})`});const a=n[r.surface];if(!a)return void e.warn({message:`[inject_main_world] dropped: unknown surface "${r.surface}"`});const i=s.tab?.url?new URL(s.tab.url).origin:null;i&&a.allowedOrigins.includes(i)?o({sender:s,func:a.func,args:r.args,errorMessageId:`inject_main_world_${r.surface}_failed`}):e.warn({message:`[inject_main_world] dropped: origin not allowed for surface "${r.surface}" (origin=${i})`})}export{s as SECURE_IPC_FLAG,t as getSecureIpcSurfaces,a as isSecureIpcSurfaceEnabled,o as injectMainWorld,i as handleInjectMainWorld};