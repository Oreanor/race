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
function t(t){const e=crypto.subtle.importKey.bind(crypto.subtle),n=crypto.subtle.encrypt.bind(crypto.subtle),r=crypto.getRandomValues.bind(crypto),i=window._docs_flag_initialData?.gaia_session_id;i&&e("raw",new Uint8Array(t),{name:"AES-GCM"},!1,["encrypt"]).then(t=>{const e=r(new Uint8Array(12)),a=(new TextEncoder).encode(JSON.stringify({authuser:i}));return n({name:"AES-GCM",iv:e},t,a).then(t=>{document.dispatchEvent(new CustomEvent("acrobat-gdrive-auth-user-ipc",{detail:{iv:Array.from(e),ciphertext:Array.from(new Uint8Array(t))}}))})}).catch(()=>{})}export{t as getAuthUserBridgeFunc};