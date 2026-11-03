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
import{setImmediate as t}from"timers";export async function warmRuntimePolicy(n,i,e,o={},a={id:"id"}){window.acrobatExtensionMessaging.wrapContentScriptListener(n,[i],()=>{},{endpoint:e})({[n]:i,...o},a,()=>{}),await new Promise(n=>t(n))}export async function warmPostPolicy(n,i,e,o={}){const a="https://trusted.example.com";window.acrobatExtensionMessaging.wrapPostMessageListener(n,[i],a,()=>{},{endpoint:e})({origin:a,data:{[n]:i,...o}}),await new Promise(n=>t(n))}