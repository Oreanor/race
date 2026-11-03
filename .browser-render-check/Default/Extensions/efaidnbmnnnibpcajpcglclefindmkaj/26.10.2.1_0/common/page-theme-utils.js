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
function e(e){if(!e||"normal"===e)return null;const t=/\bdark\b/.test(e),n=/\blight\b/.test(e);return t&&!n?"dark":n&&!t?"light":null}function t(e){return(e.querySelector('meta[name="color-scheme"]')?.content||"").toLowerCase().trim()}function n(e,t){if(!t?.getComputedStyle)return null;const n=t.getComputedStyle(e).backgroundColor;if(!n)return null;const o=n.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);if(!o)return null;if((void 0!==o[4]?parseFloat(o[4]):1)<.1)return null;return(299*parseInt(o[1],10)+587*parseInt(o[2],10)+114*parseInt(o[3],10))/255e3}export function detectPageTheme({contextEl:o=null,doc:r=document}={}){const l=r.defaultView;try{if(o){let e=o.parentElement||o;for(;e&&e!==r.documentElement;){const t=n(e,l);if(null!==t)return t<.5?"dark":"light";e=e.parentElement}}const c=function(t,...n){return t?.getComputedStyle&&n.map(n=>n?e((t.getComputedStyle(n).colorScheme||"").toLowerCase().trim()):null).find(Boolean)||null}(l,r.documentElement,r.body)||e(t(r));if(c)return c;const u=[r.body,r.documentElement].find(e=>e&&null!==n(e,l));if(u){return n(u,l)<.5?"dark":"light"}if(l?.getComputedStyle&&r.documentElement&&!function(e,n){const o=(n.getComputedStyle(e.documentElement).colorScheme||"").toLowerCase().trim(),r=o&&"normal"!==o?o:t(e);return/\bdark\b/.test(r)&&/\blight\b/.test(r)}(r,l))return"light"}catch{}return l?.matchMedia?.("(prefers-color-scheme: dark)")?.matches?"dark":"light"}export function createPageThemeWatcher({contextEl:e=null,onChange:t,doc:n=document,debounceMs:o=75}){const r=n.defaultView;let l=null,c=null,u=null,a=null;const d=()=>{const o=detectPageTheme({contextEl:e,doc:n});return o===l||(l=o,t(o)),o},m=()=>{clearTimeout(c),c=setTimeout(d,o)};return{start:()=>u?l??detectPageTheme({contextEl:e,doc:n}):(l=detectPageTheme({contextEl:e,doc:n}),a=r?.matchMedia?.("(prefers-color-scheme: dark)"),a?.addEventListener("change",m),u=new MutationObserver(m),n.documentElement&&u.observe(n.documentElement,{attributes:!0}),n.body&&u.observe(n.body,{attributes:!0}),l),stop:()=>{clearTimeout(c),c=null,a?.removeEventListener("change",m),u?.disconnect(),u=null,a=null}}}