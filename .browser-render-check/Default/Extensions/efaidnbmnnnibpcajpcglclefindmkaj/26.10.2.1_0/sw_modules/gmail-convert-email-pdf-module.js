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
import{floodgate as o}from"./floodgate.js";import{util as t}from"./util.js";import{checkUserLocaleEnabled as e,safeParseFeatureFlag as a}from"./gsuite/util.js";import{resolveInactiveTabChallenger as n}from"./direct-verb-inactive-tab-utils.js";import{CACHE_PURGE_SCHEME as i}from"./constant.js";import{GSUITE_INACTIVE_TAB_CONVERSION_FLAG as r}from"../common/constant.js";async function l(l){const[s,c,T]=await Promise.all([o.hasFlag("dc-cv-gmail-convert-email-to-pdf"),o.hasFlag("dc-cv-gmail-convert-email-to-pdf-control"),o.hasFlag(r,i.NO_CALL)]);let g;s?g=a("dc-cv-gmail-convert-email-to-pdf"):c&&(g=a("dc-cv-gmail-convert-email-to-pdf-control"));const m=e(g?.enLocaleEnabled,g?.nonEnLocaleEnabled),f=g?.selectors,v=g?.fteConfig,d=g?.fteEnabled||!1,p=!t.isAcrobatTouchPointEnabled("acrobat-touch-point-in-gmail"),b=s&&!p&&m,E=!(!b||!T)&&await n("gmail");l({enableGmailConvertEmailToPdfTouchpoint:b,selectors:f,fteEnabled:d,fteConfig:v,fteToolTipStrings:{title:t.getTranslation("gmailConvertEmailToPDFFteTitle"),description:t.getTranslation("gmailConvertEmailToPDFFteDescription"),button:t.getTranslation("closeButton")},touchpointText:t.getTranslation("gmailConvertEmailToPDF"),tooltipText:t.getTranslation("gmailConvertEmailToPDFTooltip"),inactiveTabDirectVerbProcessingEnabled:E,convertingTouchPointText:t.getTranslation("convertingTouchPointText"),convertingTooltip:t.getTranslation("convertingTooltip"),convertToPdfToastMessage:t.getTranslation("convertToPdfToastMessage"),convertToPdfErrorToastMessage:t.getTranslation("convertToPdfErrorToastMessage"),convertToPdfTabCloseErrorToastMessage:t.getTranslation("convertToPdfTabCloseErrorToastMessage"),tryAgain:t.getTranslation("tryAgain")})}export{l as gmailConvertEmailPdfInit};