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
import{extractWebpageHTML as e}from"../../../resources/addWebpage/extractWebpageHTML.js";import{getFloodgateFlag as t}from"../../../common/util.js";import{loggingApi as r}from"../../../common/loggingApi.js";export async function fetchGmailEmailHtml({gmailPrintUrl:a,pdffilename:i,sendPdfPerfMark:m}){const n=await t("dc-cv-gmail-email-pdf-credentials-cleanup").catch(()=>!1)?void 0:"include";let l;try{l=await fetch(a,{credentials:n})}catch(e){throw r.error({message:"Gmail email print fetch failed",errorType:"network",credentials:n,errorMessage:e?.message||String(e)}),e}if(!l.ok)throw r.error({message:"Gmail email print fetch failed",errorType:"http",status:l.status,credentials:n}),new Error(`HTTP ${l.status}`);const o=await l.text(),s=(new DOMParser).parseFromString(o,"text/html"),{html:c}=await e(s,{baseUrl:a,credentials:n}),d=(new TextEncoder).encode(c).buffer,f=i||"Gmail email",p=f.endsWith(".html")?f:`${f}.html`;return m("PDF_Convert_Source_File_Received",{fileSize:d.byteLength,contentType:"text/html"}),{buffer:d,mimeType:"text/html",downLoadEndTime:(new Date).getTime(),pdffilename:p}}