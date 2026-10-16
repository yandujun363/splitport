"use strict";

// SPDX-License-Identifier: GPL-3.0-only
// SplitPort (SRV) - shared helpers, loaded with require("lib/util").
//
// Every Rhino rule this file obeys is explained in docs/INTERNALS.md
// section 5: no regular expressions, and never a const declared inside a
// loop body.

// ---------------------------------------------------------------------
// small helpers (no regex!)
// ---------------------------------------------------------------------

function errText(e){
    try{
        if(e === null) return "null";
        if(e === undefined) return "undefined";
        if(e.message !== undefined && e.message !== null) return "" + e.message;
        return "" + e;
    }catch(ignored){
        return "unknown error";
    }
}

/** An exception thrown *by* Java code and caught in JS arrives either as the
 *  raw Throwable or wrapped in Rhino's WrappedException (which also carries
 *  the original in a `.javaException` property in Mindustry's Rhino fork).
 *  Net.handleException needs the real Throwable, so unwrap it here. */
function asThrowable(e){
    try{
        if(e !== null && e !== undefined){
            if(e instanceof java.lang.Throwable){
                // WrappedException.getWrappedException(); absent on anything else
                try{
                    const wrapped = e.getWrappedException();
                    if(wrapped !== null && wrapped !== undefined) return wrapped;
                }catch(notWrapped){
                }
                return e;
            }
            if(e.javaException !== undefined && e.javaException !== null) return e.javaException;
            if(e.rhinoException !== undefined && e.rhinoException !== null) return e.rhinoException;
        }
    }catch(ignored){
    }
    return new java.lang.RuntimeException(errText(e));
}

/** Same as asThrowable, but guaranteed to return an Exception (for Cons<Exception>). */
function asException(e){
    const t = asThrowable(e);
    try{
        if(t instanceof java.lang.Exception) return t;
    }catch(ignored){
    }
    return new java.lang.RuntimeException(errText(e));
}

/** True for IPv4 literals and for anything containing ':' (IPv6 literals). */
function isIpAddress(address){
    if(address === null || address === undefined) return false;
    const s = "" + address;
    if(s.length === 0) return false;
    if(s.indexOf(":") !== -1) return true;

    let dots = 0, partLength = 0;
    for(let i = 0; i < s.length; i++){
        let c = s.charCodeAt(i);
        if(c === 46){ // '.'
            if(partLength === 0 || partLength > 3) return false;
            dots++;
            partLength = 0;
        }else if(c >= 48 && c <= 57){ // '0'-'9'
            partLength++;
        }else{
            return false;
        }
    }
    return dots === 3 && partLength > 0 && partLength <= 3;
}

/** ArcDns returns targets without a trailing dot, but be defensive.
 *  RFC 2782 also allows a single "." to mean "service not available". */
function stripDot(host){
    try{
        if(host === null || host === undefined) return null;
        const s = "" + host;
        if(s.length > 1 && s.charAt(s.length - 1) === ".") return s.substring(0, s.length - 1);
        return s;
    }catch(ignored){
        return null;
    }
}

function isNoService(host){
    return host === null || host === undefined || host === "" || host === ".";
}

module.exports = {

    errText: errText,

    asThrowable: asThrowable,

    asException: asException,

    isIpAddress: isIpAddress,

    stripDot: stripDot,

    isNoService: isNoService

};
