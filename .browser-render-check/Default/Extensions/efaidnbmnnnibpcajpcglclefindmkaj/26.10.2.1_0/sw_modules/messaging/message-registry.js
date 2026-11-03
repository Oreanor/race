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
const t=new Map;const e=new Set(["string","number","boolean","object","null","array"]);function i(t,o,r=""){if(!o||"object"!=typeof o||Array.isArray(o))throw new Error(`invalid schema for op: ${t}`);Object.entries(o).forEach(([o,n])=>{const a=r?`${r}.${o}`:o;if(!n||"object"!=typeof n||"boolean"!=typeof n.required)throw new Error(`invalid schema for op: ${t} (field: ${a})`);const s=Array.isArray(n.type)?n.type:[n.type];if(0===s.length||s.some(t=>!e.has(t)))throw new Error(`invalid schema for op: ${t} (field: ${a}, unknown type: ${n.type})`);if(void 0!==n.nullable&&"boolean"!=typeof n.nullable)throw new Error(`invalid schema for op: ${t} (field: ${a}, nullable must be boolean)`);if(void 0!==n.schema){if(!s.includes("object"))throw new Error(`invalid schema for op: ${t} (field: ${a}, 'schema' is only valid on type "object")`);i(t,n.schema,a)}})}export function assertNoDuplicate(e,i,o,r){const n=t.get(e);if(!n)return;if((void 0===i?n.plain:n.byDiscriminator.get(i)||[]).some(t=>(void 0===o||t.bus===o)&&(void 0===r||void 0===t.targetEndpoint||[r].flat().some(e=>[t.targetEndpoint].flat().includes(e)))))throw new Error(`duplicate op: ${e}`)}export function register(e){assertNoDuplicate(e.op,e.discriminatorField,e.bus,e.targetEndpoint),i(e.op,e.schema);const o=function(e){let i=t.get(e);return i||(i={plain:[],byDiscriminator:new Map},t.set(e,i)),i}(e.op);if(void 0===e.discriminatorField)o.plain.push(e);else{const t=o.byDiscriminator.get(e.discriminatorField)||[];t.push(e),o.byDiscriminator.set(e.discriminatorField,t)}}export function getContract(e,i,o,r){const n=t.get(e);if(!n)return;const a=t=>(void 0===o||t.bus===o)&&(void 0===r||void 0===t.targetEndpoint||[t.targetEndpoint].flat().includes(r));if(void 0!==i){const t=(n.byDiscriminator.get(i)||[]).filter(a);if(t.length>0)return 1===t.length?t[0]:void 0}const s=n.plain.filter(a);return 1===s.length?s[0]:void 0}export function listRegisteredOps(){return Array.from(t.keys())}export function listRegisteredContracts(){return Array.from(t.values()).flatMap(({plain:t,byDiscriminator:e})=>[...t,...Array.from(e.values()).flat()])}