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
import{loggingApi as e}from"../../common/loggingApi.js";import{common as t}from"../common.js";import{floodgate as r}from"../floodgate.js";import{forceResetService as o}from"../force-reset-service.js";import s from"../CacheStore.js";import{CACHE_PURGE_SCHEME as a}from"../constant.js";import{busFlagId as n,MASTER_ENABLE_FLAG as i}from"./flag-ids.js";import{busOpManifests as c}from"./op-manifest.default.js";import{BUS as f,MODE as m}from"./messaging-constants.js";import{OP as l}from"./op-ids.js";const u="op-manifest",p=new s;let g=null,h=c;function w(e,t,r){const o=e[t];return r===f.RUNTIME_MESSAGE&&t===l.OPTIONS_AUTOMATION_TEST&&o===m.ENFORCE?m.DARK_LAUNCH:o===m.DARK_LAUNCH||o===m.ENFORCE?o:m.UNMIGRATED}async function A(){const e=new AbortController,r=setTimeout(()=>e.abort(),5e3);let o;try{if(o=await fetch(t.getOpManifestUrl(),{signal:e.signal}),!o.ok)throw new Error(`HTTP ${o.status}`);const r=await o.json();if(!r||"object"!=typeof r||Array.isArray(r))throw new Error("op-manifest: unexpected shape");return r}finally{clearTimeout(r)}}export async function getBusManifest(t){let r;g||(g=async function(){let t;o.executeFeature(u,async()=>{const e=await A();return await p.set(u,e),e}).catch(t=>e.error({message:"[op-manifest] refresh error",error:t?.message}));try{t=await p.get(u)}catch{t=null}if(t)return t;try{const e=await A();return await p.set(u,e),e}catch(t){return e.error({message:"[op-manifest] fetch error",error:t?.message}),c}}(),setTimeout(()=>{g=null},9e5));try{r=await g}catch{g=null,r=c}return h=r,h[t]??{}}export function getResolvedMode(t,o){return r.hasFlagSync(i)&&r.hasFlagSync(n(t))?(getBusManifest(t).catch(t=>e.error({message:"[op-manifest] refresh error",error:t?.message})),w(h[t]??{},o,t)):m.UNMIGRATED}export async function resolveMode(e,t){const[o,s]=await Promise.all([r.hasFlag(i,a.NO_CALL),r.hasFlag(n(e),a.NO_CALL)]);return o&&s?w(await getBusManifest(e),t,e):m.UNMIGRATED}export function resetManifestCacheForTests(){g=null,h=c}