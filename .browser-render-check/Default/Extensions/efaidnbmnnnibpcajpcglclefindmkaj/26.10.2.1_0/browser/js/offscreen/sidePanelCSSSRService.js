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
import{extractWebpageHTML as e}from"../../../resources/addWebpage/extractWebpageHTML.js";import{largeBlobStorage as t}from"../../../common/large-blob-storage.js";import{dcLocalStorage as n}from"./offscrenUtil.js";import"../../../content_scripts/content-script-messaging-gateway.js";import{offscreenSSRPostOps as o}from"../../../sw_modules/messaging/offscreen-ops-contracts.js";export const saveGenAISidePanelRenderedHTML=async r=>{if(document.querySelector("iframe#sidepanel"))return;const[s,a,i,m]=await Promise.all([n.getItem("sidepanelUrl"),n.getItem("appLocale"),n.getItem("theme"),n.getItem("isSidePanelDarkModeEnabled")]),c=new URL(s);c.hash=r.hashRoute;const d=c.origin;c.searchParams.append("la",!1),c.searchParams.append("ca",chrome.runtime.id),c.searchParams.append("locale",a),c.searchParams.append("utl",!0),m&&c.searchParams.append("theme",i||"auto");const l=(e=>{const t=document.createElement("iframe");return t.setAttribute("id","sidepanel"),t.width="373px",t.height="914px",t.border="none",t.onerror=e=>{console.error("Error in loading sidepanel iframe",e)},t.src=e,t})(c.href);let p;document.body.appendChild(l);let g,h=!1,u=!1;const w=()=>{h||(h=!0,clearTimeout(g),p&&window.removeEventListener("message",p),l.remove())};g=setTimeout(w,35e3);const f=(()=>{let e;return{promise:new Promise((t,n)=>{const o=setTimeout(()=>{n(new Error("Hosted sidepanel ready event timeout"))},2e4);e=()=>{clearTimeout(o),t()}}),resolver:e}})();var b;p=window.acrobatExtensionMessaging.wrapPostMessageListener("main_op",o,e=>!!d&&e.origin===d&&!!l.contentWindow&&e.source===l.contentWindow,async n=>{if(!h&&n.origin===d)switch(n.data.main_op){case"saveHtmlContent":if(u)return;u=!0,window.removeEventListener("message",p),await async function(n){const o=(new DOMParser).parseFromString(n.htmlContent,"text/html"),r=await e(o);if(h)return;const s=n.isAnonUser?"anonGenAISSRHtml":"signedInGenAISSRHtml";r?.html&&await t.setItem(s,r.html),w()}(n.data);break;case"cdnReady":f.resolver()}},{endpoint:"offscreen-ssr"}),window.addEventListener("message",p),b={type:"sidepanelHtmlContent",htmlContent:"<html><body><h1>Hello</h1></body></html>",disqualified:!1,pageLanguage:"en",url:"https://www.hello.com",touchpoint:"offscreen"},l&&f.promise.then(()=>l.contentWindow.postMessage(b,d)).catch(e=>{console.error("Error in sending message to sidepanel:",e.toString()),w()})};