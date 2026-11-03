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
import{gdriveInjectBridgeFunc as i}from"./mw_scripts/gdrive-inject-bridge.js";import{getAuthUserBridgeFunc as t}from"./mw_scripts/get-auth-user-bridge.js";import{gmailInjectBridgeFunc as e}from"./mw_scripts/gmail-inject-bridge.js";import{geminiInjectBridgeFunc as o}from"./mw_scripts/gemini-inject-bridge.js";import{gdocsInjectBridgeFunc as r}from"./mw_scripts/gdocs-inject-bridge.js";import{linkedinInjectBridgeFunc as s}from"./mw_scripts/linkedin-inject-bridge.js";import{chatgptInjectBridgeFunc as c}from"./mw_scripts/chatgpt-inject-bridge.js";const g={gdrive_inject:{func:i,allowedOrigins:["https://drive.google.com"]},gdrive_auth_user:{func:t,allowedOrigins:["https://drive.google.com"]},gmail_inject:{func:e,allowedOrigins:["https://mail.google.com"]},gemini_inject:{func:o,allowedOrigins:["https://gemini.google.com"]},gdocs_inject:{func:r,allowedOrigins:["https://docs.google.com"]},linkedin_inject:{func:s,allowedOrigins:["https://www.linkedin.com"]},chatgpt_inject:{func:c,allowedOrigins:["https://chatgpt.com"]}};export{g as MAIN_WORLD_INJECT_FUNCS};