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
import{POST_PURCHASE_ACK_SW_FALLBACK_MS as e}from"../common/upsellPostPurchaseConstants.js";import{loggingApi as o}from"../common/loggingApi.js";import{UPSELL_SKIP_RELOAD_FLAG as s}from"../common/constant.js";import{CACHE_PURGE_SCHEME as a}from"./constant.js";import{floodgate as r}from"./floodgate.js";export const reloadViewerAfterPostPurchase=async({tabId:t,upsellTouchpoint:l,popupWindowId:n,wasSignedInAtOpen:m})=>{const c=!0===m&&!!await r.hasFlag(s,a.NO_CALL);let i=!1;const p=chrome.tabs.sendMessage(t,{main_op:"upsell_post_purchase",upsellTouchpoint:l,skipReload:c}).catch(e=>(i=!0,o.error({message:"[Paywall] Post-purchase message delivery failed — viewer may not have been reachable",error:e?.message}),null));let h=!1;const u=new Promise(o=>{setTimeout(()=>{h=!0,o()},e)});await Promise.race([p,u]),h&&!i&&o.warn({message:"[Paywall] Post-purchase ack not received within timeout",skipReload:c}),null!=n&&chrome.windows.remove(n).catch(()=>null),c||chrome.tabs.reload(t).catch(e=>{o.error({message:"[Paywall] Viewer tab reload after post-purchase failed",error:e?.message})})};