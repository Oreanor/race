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
import{resolveMode as e,getResolvedMode as n}from"./op-migration-state.js";import{loggingApi as t}from"../../common/loggingApi.js";import{mediate as i,mediateResolvedMode as r}from"./mediation-pipeline.js";import{startGatewayPerf as s,startTiming as o,endTiming as a}from"./gateway-perf.js";import{wrapRuntimeMessageListener as p,wrapPortMessageListener as d,wrapSynchronousRuntimeMessageListener as m}from"./message-gateway-core.js";import{BUS as g}from"./messaging-constants.js";function u(e){t.warn({message:"DCBrowserExt:Messaging:Rejected",...e})}function c(n){return i({...n,resolveModeFn:e,reportRejectionFn:u})}s();export function wrapSynchronousRuntimeMessageListener(e,t,{endpoint:i,envelopeFields:s,busId:p=g.RUNTIME_MESSAGE}={}){return m(e,t,{mediateSyncFn:e=>r({...e,mode:n(e.busId,e.op),reportRejectionFn:u}),endpoint:i,envelopeFields:s,busId:p,reportRejectionFn:u,startTiming:o,endTiming:a})}export function wrapRuntimeMessageListener(e,n,{mediateFn:t=c,endpoint:i,envelopeFields:r,busId:s}={}){return p(e,n,{mediateFn:t,endpoint:i,reportRejectionFn:u,startTiming:o,endTiming:a,envelopeFields:r,busId:s})}export function registerRuntimeMessageHandler(e,n,{endpoint:t,mediateFn:i=c,envelopeFields:r}={}){const s={mediateFn:i,endpoint:t,envelopeFields:r};chrome.runtime.onMessage.addListener(wrapRuntimeMessageListener(e,n,s))}export function registerExternalMessageHandler(e,n,{endpoint:t,wrapListener:i}={}){const r=wrapRuntimeMessageListener(e,n,{mediateFn:c,endpoint:t,busId:g.EXTERNAL_MESSAGE});chrome.runtime.onMessageExternal.addListener(i?i(r):r)}export function wrapPortMessageListener(e,n,{mediateFn:t=c,endpoint:i}={}){return d(e,n,{mediateFn:t,endpoint:i,reportRejectionFn:u,startTiming:o,endTiming:a})}export function registerPortMessageHandler(e,n,t,{endpoint:i}={}){const r=wrapPortMessageListener(n,t,{endpoint:i});e.onMessage.addListener(n=>r(n,e))}