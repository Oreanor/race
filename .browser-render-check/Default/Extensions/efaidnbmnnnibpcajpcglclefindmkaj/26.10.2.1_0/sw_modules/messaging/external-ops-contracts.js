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
import{register as e}from"./message-registry.js";import{BUS as r,SENDER_TIER as t}from"./messaging-constants.js";import{OP as E}from"./op-ids.js";export const externalTaskSchemas=[[E.PUSH_BUILD_SIDE_USER_STATE,{userState:{required:!0,type:["string","object"]},requestId:{required:!1,type:"string"}}],[E.DETECT_EXTENSION,{}],[E.DETECT_DESKTOP,{}],[E.DETECT_VIEWER_ENABLED,{}],[E.ENABLE_VIEWER,{}],[E.OPEN_ACROBAT_CLICKED,{reload:{required:!1,type:"boolean"}}],[E.UPSELL_REDIRECT_TO_PDF,{pdfUrl:{required:!1,type:"string",nullable:!0},postPurchaseReload:{required:!1,type:"string"},upsellTouchpoint:{required:!1,type:"string",nullable:!0}}],[E.STORAGE_BULK_READ,{keys:{required:!1,type:"array"}}],[E.STORAGE_BULK_WRITE,{data:{required:!1,type:"object"}}],[E.STORAGE_BULK_REMOVE,{keys:{required:!1,type:"array"}}],[E.OPEN_NOTIFICATION_PREFERENCES,{whatsNew:{required:!1,type:"boolean"}}],[E.OPEN_KEEP_ACROBAT_VISIBLE_PREFERENCE,{}],[E.OPEN_NEW_TAB,{url:{required:!0,type:"string"},storageKey:{required:!1,type:"string"},ttl:{required:!1,type:"number"}}],[E.OPEN_LFA_SETTINGS_PAGE_WITH_ANIMATION,{}],[E.IMS_SIGN_IN_DONE,{tabId:{required:!1,type:["string","number"]}}]];externalTaskSchemas.forEach(([E,i])=>e({op:E,bus:r.EXTERNAL_MESSAGE,discriminatorField:"task",allowedSenderTiers:[t.EXTERNAL],schema:{type:{required:!0,type:"string"},...i},targetEndpoint:"external-clients:task"})),e({op:E.OPEN_SIDE_PANEL,bus:r.EXTERNAL_MESSAGE,discriminatorField:"type",allowedSenderTiers:[t.EXTERNAL],schema:{touchpoint:{required:!1,type:"string"},hashRoute:{required:!1,type:"string"},tab:{required:!1,type:"object"}},targetEndpoint:"external-clients:sync"}),e({op:E.GET_WEBPAGE_HTML_EXTERNAL,bus:r.RUNTIME_CONNECT,discriminatorField:"task",allowedSenderTiers:[t.EXTERNAL],schema:{payload:{required:!0,type:"string"}},targetEndpoint:"external-clients:port"});