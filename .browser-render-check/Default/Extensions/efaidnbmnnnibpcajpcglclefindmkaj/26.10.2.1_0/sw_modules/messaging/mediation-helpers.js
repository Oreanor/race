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
import{classify as e}from"./sender-tier.js";import{CLASSIFIABLE_BUSES as r,FIXED_TIER_BUSES as t}from"./messaging-constants.js";export function validateSchema(e,r,t=""){const n=e??{},i=r??{},o=t?`${t}.`:"",s=Object.keys(n).find(e=>!Object.prototype.hasOwnProperty.call(i,e));if(void 0!==s)return{valid:!1,reason:`unexpected field: ${o}${s}`};const a=Object.entries(i).find(([e,r])=>{const t=n[e];if(void 0===t)return!!r.required;if(null===t&&!0===r.nullable)return!1;let i;return i=null===t?"null":Array.isArray(t)?"array":typeof t,Array.isArray(r.type)?!r.type.includes(i):i!==r.type});if(void 0!==a){const[e,r]=a;return{valid:!1,reason:void 0===n[e]?`missing required field: ${o}${e}`:`field ${o}${e} expected type ${[].concat(r.type).join("|")}`}}const d=Object.entries(i).filter(([e,r])=>r.schema&&null!==n[e]&&"object"==typeof n[e]&&!Array.isArray(n[e])).map(([e,r])=>validateSchema(n[e],r.schema,`${o}${e}`)).find(e=>!e.valid);return d||{valid:!0}}export function permit(e,r){return r.allowedSenderTiers.includes(e)}export function stripEnvelopeFields(e,r){if(!r||0===r.length)return e;const t={...e};return r.forEach(e=>delete t[e]),t}export function isEndpointPermitted(e,r){if(void 0===e||!r)return!0;return(Array.isArray(r)?r:[r]).includes(e)}export function describeTargetEndpoint(e){return e?Array.isArray(e)?e.join(" or "):e:"unknown"}export function evaluateContract(e,r,t,n,i){const o=permit(r,e),s=!isEndpointPermitted(i,e.targetEndpoint),a=o&&!s,d=a?validateSchema(stripEnvelopeFields(t,n),e.schema):{valid:!1},c=a&&d.valid;let l;return l=o?s?`endpoint mismatch: expected ${describeTargetEndpoint(e.targetEndpoint)}, got ${i}`:d.reason:"sender tier not permitted",{passes:c,reason:l}}export function resolveTierSync(n,i){return r.includes(n)?e(i):void 0!==t[n]?t[n]:"unknown"}export async function resolveTier(e,r){return resolveTierSync(e,r)}