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
import{getContract as e}from"./message-registry.js";import{MODE as o,DECISION as n}from"./messaging-constants.js";import{validateSchema as t,permit as r,resolveTier as s,resolveTierSync as i,evaluateContract as d,describeTargetEndpoint as a}from"./mediation-helpers.js";export{t as validateSchema,r as permit};export function mediateResolvedMode({busId:e,op:t,contract:r,mode:s,request:c,sender:p,envelopeFields:l,endpoint:m,reportRejectionFn:u,tier:R}){if(!r||s===o.UNMIGRATED)return{decision:n.UNMIGRATED};const E=R??i(e,p),{passes:I,reason:M}=d(r,E,c,l,m);return I||u({bus:e,op:t,tier:E??null,endpoint:m??a(r.targetEndpoint),reason:M,timestamp:Date.now()}),s===o.DARK_LAUNCH?{decision:n.DARK_LAUNCH_PASS}:I?{decision:n.PERMITTED}:{decision:n.REJECTED,reason:M}}export async function mediate({busId:t,op:r,envelopeFields:i,request:d,sender:a,endpoint:c,discriminatorField:p,resolveModeFn:l,reportRejectionFn:m,onModeResolved:u}){const R=e(r,p,t,c)??e(r,p,t);if(!R)return{decision:n.UNMIGRATED};const E=await l(t,r);return u?.(E),E===o.UNMIGRATED?{decision:n.UNMIGRATED}:mediateResolvedMode({busId:t,op:r,contract:R,mode:E,request:d,sender:a,envelopeFields:i,endpoint:c,reportRejectionFn:m,tier:await s(t,a)})}export async function snapshot(n,{resolveModeFn:t}){return Promise.all(n.map(async({busId:n,op:r,discriminatorField:s,endpoint:i})=>{const d=e(r,s,n,i)??e(r,s,n);if(!d||d.bus!==n)return{busId:n,op:r,mode:o.UNMIGRATED,contract:null};const{allowedSenderTiers:a,schema:c,targetEndpoint:p}=d;return{busId:n,op:r,mode:await t(n,r),contract:{allowedSenderTiers:a,schema:c,targetEndpoint:p}}}))}