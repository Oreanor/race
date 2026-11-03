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
export const STUDENT_TOOLS_TOUCHPOINT_REGISTRY={flashcards:{id:"flashcards",contextMenuRoutingContext:"ExtensionContextMenu:generateFlashcards",fabRoutingContext:"ExtensionFAB:generateFlashcards",surfaces:["context-menu","fab"],contextMenuId:"createFlashcardsFromWebpageContextMenu",translationTitleKey:"studentToolsTouchpointFlashcards",fabLabelKey:"studentToolsTouchpointFabFlashcards",analyticsSubType:"flashcards",navigationView:"files"},quiz:{id:"quiz",contextMenuRoutingContext:"ExtensionContextMenu:generatePracticeQuiz",fabRoutingContext:"ExtensionFAB:generatePracticeQuiz",surfaces:["context-menu","fab"],contextMenuId:"createQuizFromWebpageContextMenu",translationTitleKey:"studentToolsTouchpointQuiz",fabLabelKey:"studentToolsTouchpointFabQuiz",analyticsSubType:"quiz",navigationView:"files"},"study-guide":{id:"study-guide",contextMenuRoutingContext:"ExtensionContextMenu:generateStudyGuide",fabRoutingContext:"ExtensionFAB:generateStudyGuide",surfaces:["context-menu","fab"],contextMenuId:"createStudyGuideFromWebpageContextMenu",translationTitleKey:"studentToolsTouchpointStudyGuideContextMenu",fabLabelKey:"studentToolsTouchpointFabStudyGuide",analyticsSubType:"study-guide",navigationView:"files"},mindmap:{id:"mindmap",fabRoutingContext:"ExtensionFAB:generateMindmap",surfaces:["fab"],translationTitleKey:"studentToolsTouchpointMindmap",fabLabelKey:"studentToolsTouchpointFabMindmap",analyticsSubType:"mindmap",navigationView:"files"},notes:{id:"notes",fabRoutingContext:"ExtensionFAB:generateNotesStudyGuide",surfaces:["fab"],translationTitleKey:"studentToolsTouchpointFabNotes",fabLabelKey:"studentToolsTouchpointFabNotes",analyticsSubType:"notes",navigationView:"files"}};export function getStudentToolsTouchpointConfig(e){return STUDENT_TOOLS_TOUCHPOINT_REGISTRY[e]}export function getTouchpointsForSurface(e){return Object.values(STUDENT_TOOLS_TOUCHPOINT_REGISTRY).filter(t=>t.surfaces.includes(e))}