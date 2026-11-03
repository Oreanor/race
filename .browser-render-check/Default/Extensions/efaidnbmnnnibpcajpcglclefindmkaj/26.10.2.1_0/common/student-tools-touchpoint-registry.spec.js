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
import{STUDENT_TOOLS_TOUCHPOINT_REGISTRY as e,getStudentToolsTouchpointConfig as t,getTouchpointsForSurface as o}from"./student-tools-touchpoint-registry.js";describe('notes (FAB "Generate notes" challenger)',()=>{it("is fab-only, with its own distinct fabRoutingContext for analytics attribution (not study-guide's, not the unrelated 'generateNotes' Notes-tab funnel)",()=>{const e=t("notes"),o=t("study-guide");expect(e.surfaces).toEqual(["fab"]),expect(e.fabRoutingContext).toBe("ExtensionFAB:generateNotesStudyGuide"),expect(e.fabRoutingContext).not.toBe(o.fabRoutingContext),expect(e.fabRoutingContext).not.toBe("ExtensionFAB:generateNotes"),expect(e.googleSearchRoutingContext).toBeUndefined(),expect(e.contextMenuRoutingContext).toBeUndefined()}),it("has a fabLabelKey distinct from translationTitleKey conceptually but present for the FAB pill",()=>{const e=t("notes");expect(e.fabLabelKey).toBe("studentToolsTouchpointFabNotes"),expect(e.translationTitleKey).toBeTruthy()}),it("is included when filtering touchpoints for the fab surface",()=>{expect(o("fab").map(e=>e.id)).toContain("notes")}),it("is not included when filtering touchpoints for the google-search surface",()=>{expect(o("google-search").map(e=>e.id)).not.toContain("notes")})}),describe("STUDENT_TOOLS_TOUCHPOINT_REGISTRY — every entry",()=>{it("declares fabRoutingContext for every touchpoint whose surfaces include fab",()=>{Object.values(e).filter(e=>e.surfaces.includes("fab")).forEach(e=>{expect(e.fabRoutingContext).toBeTruthy(),expect(e.fabLabelKey).toBeTruthy()})}),it("declares contextMenuRoutingContext and contextMenuId for every touchpoint whose surfaces include context-menu",()=>{Object.values(e).filter(e=>e.surfaces.includes("context-menu")).forEach(e=>{expect(e.contextMenuRoutingContext).toBeTruthy(),expect(e.contextMenuId).toBeTruthy()})})});