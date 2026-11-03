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
import{OFFSCREEN_DOCUMENT_PATH as e}from"../../common/offscreen-document-path.js";import{SENDER_TIER as t}from"./messaging-constants.js";import{OP as i}from"./op-ids.js";const r=new Map;export function isMimeHandlerVerificationCandidate(e){return e?.id===chrome.runtime.id&&e.url?.split("?")[0]===chrome.runtime.getURL("viewer.html")&&Number.isInteger(e.tab?.id)&&"string"==typeof e.documentId&&e.documentId.length>0}export function clearMimeHandlerVerificationsForTab(e){r.forEach((t,i)=>{t.tabId===e&&r.delete(i)})}export function verifyNativeMimeHandlerSender(e){if(!isMimeHandlerVerificationCandidate(e))return Promise.resolve(!1);let t=r.get(e.documentId);return t&&t.tabId===e.tab.id||(t={tabId:e.tab.id,verified:!1},r.set(e.documentId,t),t.pending=chrome.tabs.sendMessage(e.tab.id,{main_op:i.VERIFY_MIME_HANDLER_CONTEXT},{documentId:e.documentId}).then(i=>{const n=r.get(e.documentId)===t;return t.verified=n&&!0===i?.isNativeMimeHandler&&i.tabId===e.tab.id,n&&!t.verified&&r.delete(e.documentId),t.verified},i=>{throw r.get(e.documentId)===t&&r.delete(e.documentId),i})),t.pending}function n(){return`chrome-extension://${chrome.runtime.id}/`}export function classify(i){if(!i)return t.UNKNOWN;if(i.id===chrome.runtime.id&&!i.tab&&!i.url)return t.SERVICE_WORKER;if(i.url&&i.url.startsWith(n())){const d=function(e){const t=e.indexOf("?");return-1===t?e:e.slice(0,t)}(i.url);if(d===`${n()}${e}`)return t.OFFSCREEN;if(d===`${n()}service-worker.js`)return t.SERVICE_WORKER;if(isMimeHandlerVerificationCandidate(i)){const e=r.get(i.documentId);if(e?.verified&&e.tabId===i.tab.id)return t.EXTENSION_PAGE_OPENED_DIRECTLY}return function(e){return e.tab?e.tab.url&&e.tab.url.startsWith(n())?t.EXTENSION_PAGE_OPENED_DIRECTLY:t.EXTENSION_PAGE_EMBEDDED_IN_FOREIGN_TAB:t.EXTENSION_PAGE_OPENED_DIRECTLY}(i)}return i.tab?i.id===chrome.runtime.id?t.CONTENT_SCRIPT:t.EXTERNAL:i.id&&i.id!==chrome.runtime.id?t.EXTERNAL:t.UNKNOWN}