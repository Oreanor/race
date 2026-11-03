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
import{dcTabStorage as o}from"../tab-storage.js";import{loggingApi as e}from"../../../common/loggingApi.js";export function handleOutlookAttachmentFlow(t,r){return new Promise((s,a)=>{const n=Date.now()+45e3,i=()=>{chrome.runtime.sendMessage({main_op:"get-session",type:"outlook-pdf",sessionId:t}).then(t=>{const m=t?.data;if(m?.outlookTabUrl&&o.setItem("outlookTabUrl",m.outlookTabUrl),m?.url){const o=new URL(m.url);Object.entries(m.queryParams||{}).forEach(([e,t])=>{o.searchParams.set(e,t)});const e=m.token?{Authorization:`Bearer ${m.token}`}:{};return r(o.toString(),e),void s()}"error"!==m?.status?Date.now()<n?setTimeout(i,250):(e.error({message:"Outlook attachment resolution failed",error:"Timed out waiting for outlook attachment session"}),a({message:"Timed out waiting for outlook attachment session"})):a({message:"Outlook attachment resolve failed",error:m.error})}).catch(o=>{e.error({message:"Outlook attachment resolution failed",error:"Failed to resolve outlook attachment session"}),a({message:"Failed to resolve outlook attachment session",error:o?.toString()})})};i()})}export function handleMsWordDownloadFlow(o,e){return new Promise((t,r)=>{chrome.runtime.sendMessage({main_op:"get-session",type:"msword-document",sessionId:o}).then(o=>{const s=o?.data;if(!s?.url)return void r({message:"No msword download session"});const a=new URL(s.url);Object.entries(s.queryParams||{}).forEach(([o,e])=>{a.searchParams.set(o,e)}),e(a.toString()),t()}).catch(o=>{r({message:"Failed to resolve msword download session",error:o?.toString()})})})}