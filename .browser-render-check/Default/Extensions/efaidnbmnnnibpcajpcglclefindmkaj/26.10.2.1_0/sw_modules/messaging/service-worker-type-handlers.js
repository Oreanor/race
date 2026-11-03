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
import{sidepanelState as e}from"../SidepanelState.js";import{getUpsellSessionByWindowId as t,registerUpsellPopupWindow as o,startQAWithWebpage as s}from"../ch-context-menu.js";import{dcLocalStorage as i}from"../../common/local-storage.js";import{openPreferences as p}from"../../common/navigation-helper.js";import n from"../ExplicitBlocklist.js";import{handleGdriveResumableUploadChunk as r}from"../gdrive-upload.js";import{OP as a}from"./op-ids.js";import{wrapSynchronousRuntimeMessageListener as d}from"./service-worker-messaging-gateway.js";const E={[a.GET_WINDOW_TYPE]:(e,t,o)=>{t?.tab?.windowId?chrome.windows.get(t.tab.windowId).then(e=>{const t="popup"===e.type,s="app"===e.type;o({isPopup:t,isApp:s})}):o({isPopup:!1,isApp:!1})},[a.IS_UPSELL_POPUP_TAB]:(e,o,s)=>{const i=o?.tab?.windowId;s({isUpsellPopupTab:null!=i&&!!t(i)})},[a.GET_SIDEPANEL_STATE]:(t,o,s)=>{s({isOpen:e.getIsOpen(o.tab?.id)})},[a.SIDEPANEL_LOAD_STATE]:t=>{e.setLoadState(t.tabId,e.LOAD_STATE[t.state])},[a.SIDEPANEL_RENDER_MODE]:t=>{e.setRenderMode(t.tabId,t.renderMode)},[a.SIDEPANEL_CLOSE_REASON]:t=>{e.setCloseReason(t.tabId,t.reason)},[a.REGISTER_UPSELL_POPUP_WINDOW]:e=>o(e.tabId,e.windowId),[a.OPEN_SIDE_PANEL]:(e,t)=>s(e,t.tab||e.tab),[a.OPEN_OPTIONS_PAGE]:e=>p({preferenceTabId:e.preferenceTabId,controlId:e.controlId,accordionId:e.accordionId,sectionClassNames:e.highlightSection}),[a.SEND_TO_SIDEPANEL]:(e,t)=>chrome.runtime.sendMessage({...e,tabId:t.tab?.id}),[a.GET_EXPLICIT_BLOCKLIST]:(e,t,o)=>{"true"===i.getItem("enableGenAIFab")||!0===i.getItem("isSidePanelHomeEnabled")?n.getExplicitBlocklist().then(e=>o(e)).catch(()=>o([])):o([])},[a.GET_EXPRESS_WEBVIEW_ALLOWED_LIST]:(e,t,o)=>{n.getExpressWebviewAllowedList().then(e=>o(e)).catch(()=>o([]))},[a.CLOSE_UPSELL_POPUP]:(e,t)=>{const o=i.getItem("upsellSessions")||{},s=Object.entries(o).find(([,e])=>e.popupWindow?.id===t.tab?.windowId);if(s){const[t,p]=s;e.upsellTouchpoint&&(p.upsellTouchpoint=e.upsellTouchpoint,o[t]=p,i.setItem("upsellSessions",o)),chrome.windows.remove(p.popupWindow.id).catch(()=>null)}},[a.GDRIVE_RESUMABLE_UPLOAD_CHUNK]:(e,t,o)=>r(e,o)};export function createWorkerTypeDispatcher(e){return{handles:e=>Object.prototype.hasOwnProperty.call(E,e),dispatch:d("type",(t,o,s)=>{E[t.type](t,o,s),e(t,o,s)},{endpoint:"service-worker:type"})}}