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
import{sanitizeErrorMessage as e}from"./util.js";describe("sanitizeErrorMessage",()=>{it("redacts bearer tokens while preserving surrounding diagnostics",()=>{const t=new Error("Request failed: Bearer abc.def_123");expect(e(t)).toBe("Request failed: Bearer [REDACTED]")}),it("redacts credential values in key-value messages without removing URLs",()=>{expect(e('Cannot access contents of url "https://auth.example/deeplink?access_token=secret&state=visible"')).toBe('Cannot access contents of url "https://auth.example/deeplink?access_token=[REDACTED]&state=visible"')}),it("redacts JWTs and handles non-Error inputs",()=>{expect(e("JWT eyJhbGci.eyJzdWI.abc123")).toBe("JWT [REDACTED]"),expect(e(42)).toBe("42")})});