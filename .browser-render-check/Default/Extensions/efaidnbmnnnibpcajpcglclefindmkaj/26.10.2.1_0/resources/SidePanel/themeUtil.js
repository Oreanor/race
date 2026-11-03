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
import{dcTabStorage as e}from"../../browser/js/tab-storage.js";export function resolveTheme(e){return e&&"auto"!==e?e:window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}export const SHELL_THEME_HINT_KEY="sidePanelShellThemeHint";function t(t){document.documentElement.classList.toggle("theme-dark",t),document.body.classList.toggle("theme-dark",t),e.setItem(SHELL_THEME_HINT_KEY,t?"dark":"light")}export function applyBodyTheme(e){t("dark"===resolveTheme(e))}export function watchSystemThemeChanges(e){window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>{const t=e();t&&"auto"!==t||applyBodyTheme(t)})}function o(e,o){e?applyBodyTheme(o()):t(!1)}export function initShellTheme({getDarkModeEnabled:e,getTheme:t}){let n=e();o(n,t),chrome.storage.onChanged.addListener((e,a)=>{n=function(e,t,n,a){if("local"!==t)return n;if(e.isSidePanelDarkModeEnabled){const t=e.isSidePanelDarkModeEnabled.newValue;return o(t,a),t}return e.theme&&n&&applyBodyTheme(e.theme.newValue),n}(e,a,n,t)}),watchSystemThemeChanges(()=>n?t():"light")}