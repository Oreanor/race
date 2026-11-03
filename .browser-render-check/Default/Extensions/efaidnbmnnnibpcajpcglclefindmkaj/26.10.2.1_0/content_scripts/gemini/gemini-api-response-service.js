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
import state from"./state.js";let geminiSecureIpcActive=!1;const EMPTY_CHAT_TOKEN_RESULT={chatId:void 0,chatTokenValue:void 0},injectGeminiAPIResponseInterceptor=e=>{if(!state?.geminiAPIResponseInterceptorAdded)if(state.geminiAPIResponseInterceptorAdded=!0,e)geminiSecureIpcActive=!0,import(chrome.runtime.getURL("content_scripts/shared/main-world-receiver.js")).then(({setupMainWorldReceiver:e})=>e({channels:[{eventName:"acrobat-gemini-api-data",handler:e=>{geminiDataHandler({detail:e})}}]})).then(({aesKeyBytes:e})=>chrome.runtime.sendMessage({main_op:"inject_main_world",surface:"gemini_inject",args:[e]}).catch(()=>{})).catch(()=>{});else{const e=document.createElement("script");e.src=chrome.runtime.getURL("content_scripts/gemini/gemini-inject.js"),e.onload=function(){this.remove()},(document.head||document.documentElement).appendChild(e)}},getParsedJSON=e=>{let t;try{t=JSON.parse(e)}catch(e){}return t},getSanitizedAPIResponseData=e=>{if("string"!=typeof e||!e)return null;const t=e.replace(/^\)\]\}'\s*/,""),n=t.search(/[[{]/);if(-1===n)return null;const a=[];let i=-1;for(let e=n;e<t.length;e+=1){const n=t[e];if("["===n||"{"===n)a.push(n);else if(("]"===n||"}"===n)&&(a.pop(),0===a.length)){i=e+1;break}}return-1===i?null:t.slice(n,i)},getChatTokenValue=e=>{const t=getParsedJSON(e?.[0]?.[2]);if(null==t)return EMPTY_CHAT_TOKEN_RESULT;const n=t?.[1];let a=t?.[0]?.[0]?.[0]?.[0];return"string"==typeof a&&a.startsWith("c_")?(a=a.slice(2),{chatId:a,chatTokenValue:n}):EMPTY_CHAT_TOKEN_RESULT},parseDataForChatFullyLoaded=e=>{const t=getSanitizedAPIResponseData(e);if(!t)return EMPTY_CHAT_TOKEN_RESULT;const n=getParsedJSON(t);return getChatTokenValue(n)},geminiDataHandler=e=>{const{chatId:t,chatTokenValue:n}=parseDataForChatFullyLoaded(e?.detail?.responseData);if(!t||void 0===n)return;const a=null===n;state.setLRUData(t,a)},observedGeminiDataHandler=window.acrobatExtensionMessaging.wrapCustomEventListener("acrobat-gemini-api-data",geminiDataHandler,{endpoint:"gemini:api-response"}),guardedGeminiDataHandler=e=>{geminiSecureIpcActive||observedGeminiDataHandler(e)},addGeminiDataEventListener=()=>{state.eventControllerSignal.aborted||document.addEventListener("acrobat-gemini-api-data",guardedGeminiDataHandler,{signal:state.eventControllerSignal})};export{injectGeminiAPIResponseInterceptor,addGeminiDataEventListener};