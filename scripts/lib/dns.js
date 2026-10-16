"use strict";

// SPDX-License-Identifier: GPL-3.0-only
// SplitPort (SRV) - the DNS client, loaded with require("lib/dns").
//
// This exists because ArcDns cannot read an answer that contains a CNAME;
// the long explanation is in the comment block below and in
// docs/INTERNALS.md section 4.

const util = require("lib/util");
const stripDot = util.stripDot;
const isNoService = util.isNoService;

// ---------------------------------------------------------------------
// DNS client
//
// ArcDns ships a hand-rolled SRV parser that assumes *every* record in the
// answer section is an SRV. A nameserver that puts the CNAME first - which is
// exactly what happens when `_mindustry._tcp.alias.example.com` is published
// as a CNAME to `_mindustry._tcp.real.example.com` - makes it read the CNAME's
// RDATA as priority/weight/port, walk straight off the end of that RDATA and
// finally throw StringIndexOutOfBoundsException.
//
// That is a RuntimeException, so ArcDns.getSrvRecords(domain) - which only
// catches IOException - lets it escape, and the caller's own
// `catch(IOException)` does not catch it either. The result differs per build:
//
//   * vanilla Mindustry: it escapes ArcNetProvider.pingHost, Net's ping
//     executor swallows it silently and the server entry spins on
//     "refreshing..." forever; nothing is ever reported back.
//   * MindustryX: Net.pingHost is replaced by PingService (patch 0061), which
//     calls InetAddress.getByName() and ArcDns.getSrvRecords() with no
//     protection at all. A pure-SRV domain (no A/AAAA record) throws on the
//     very first call, a CNAME chain throws on the second, and either way the
//     entry spins just the same.
//
// The mod therefore talks DNS itself: records are dispatched by type, every
// RR is stepped over by its own RDLENGTH, names follow compression pointers,
// and CNAME chains are resolved.
// ---------------------------------------------------------------------

/** UDP timeout for one SRV query, matching ArcDns. */
const DNS_TIMEOUT = 2000;

/** Accept up to this many bytes of a UDP answer (EDNS0 advertises 1232). */
const DNS_BUFFER = 1400;

/** CNAME chains longer than this are treated as a loop. */
const DNS_CNAME_DEPTH = 4;

/** Compression-pointer hops allowed while reading one name. */
const DNS_MAX_NAME_JUMPS = 16;

const DNS_TYPE_CNAME = 5;
const DNS_TYPE_SRV = 33;
const DNS_CLASS_IN = 1;
const DNS_FLAG_TRUNCATED = 0x0200;

/** Java bytes are signed; go through Latin-1 so every char is one byte.
 *  The explicit string coercion matters: Rhino hands java.lang.String back as
 *  a wrapped Java object, and charCodeAt()/substring() only behave as expected
 *  on a real JS string. */
function dnsText(bytes, length){
    return "" + new java.lang.String(bytes, 0, length, "ISO-8859-1");
}

/** Read a (possibly compressed) DNS name starting at `start`.
 *  @return {name, next} where next is the offset just past the name in the
 *          original stream, or null when the message is malformed. */
function dnsName(msg, start, end){
    let name = "";
    let pos = start;
    let next = -1;
    let jumps = 0;

    while(pos >= 0 && pos < end){
        // `let`, not `const`: Rhino's optimiser folds a const declared inside
        // a loop to its first evaluation, so a const here would keep reading
        // the same byte forever (see the notes at the top of this file).
        let len = msg.charCodeAt(pos);

        if(len === 0){
            pos++;
            if(next < 0) next = pos;
            break;
        }

        if((len & 0xc0) === 0xc0){
            if(pos + 1 >= end) return null;
            let target = ((len & 0x3f) << 8) | msg.charCodeAt(pos + 1);
            if(next < 0) next = pos + 2;
            jumps++;
            // a pointer must stay inside the message and never loop
            if(jumps > DNS_MAX_NAME_JUMPS || target >= end) return null;
            pos = target;
            continue;
        }

        // 0x40/0x80 label types are reserved; they never appear in an answer
        if((len & 0xc0) !== 0) return null;
        if(pos + 1 + len > end) return null;

        if(name.length > 0) name += ".";
        name += msg.substring(pos + 1, pos + 1 + len);
        pos += 1 + len;
    }

    if(next < 0) return null;
    return {name: name, next: next};
}

/** Parse an SRV answer.
 *  @return {records, cname} - records is a plain array, cname is the target of
 *          the first CNAME in the answer (or null). Returns null when the
 *          answer cannot be walked at all. */
function dnsParseAnswer(msg, length){
    if(length < 12) return null;

    const flags = (msg.charCodeAt(2) << 8) | msg.charCodeAt(3);
    if((flags & 0x0f) !== 0) return null;                // NXDOMAIN / SERVFAIL
    if((flags & DNS_FLAG_TRUNCATED) !== 0) return null;   // truncated: cannot trust it

    const questions = (msg.charCodeAt(4) << 8) | msg.charCodeAt(5);
    const answers = (msg.charCodeAt(6) << 8) | msg.charCodeAt(7);

    let pos = 12;
    for(let i = 0; i < questions; i++){
        let question = dnsName(msg, pos, length);
        if(question === null) return null;
        pos = question.next + 4;
        if(pos > length) return null;
    }

    const records = [];
    let cname = null;

    for(let i = 0; i < answers; i++){
        let owner = dnsName(msg, pos, length);
        if(owner === null) return null;
        pos = owner.next;
        if(pos + 10 > length) return null;

        let type = (msg.charCodeAt(pos) << 8) | msg.charCodeAt(pos + 1);
        let cls = (msg.charCodeAt(pos + 2) << 8) | msg.charCodeAt(pos + 3);
        let ttl = 0;
        for(let k = 0; k < 4; k++){
            ttl = (ttl * 256) + msg.charCodeAt(pos + 4 + k);
        }
        let rdlength = (msg.charCodeAt(pos + 8) << 8) | msg.charCodeAt(pos + 9);

        let rdata = pos + 10;
        let rdataEnd = rdata + rdlength;
        if(rdataEnd > length) return null;

        if(cls === DNS_CLASS_IN && type === DNS_TYPE_SRV && rdlength >= 7){
            let priority = (msg.charCodeAt(rdata) << 8) | msg.charCodeAt(rdata + 1);
            let weight = (msg.charCodeAt(rdata + 2) << 8) | msg.charCodeAt(rdata + 3);
            let port = (msg.charCodeAt(rdata + 4) << 8) | msg.charCodeAt(rdata + 5);
            // the target may be a pointer, so it is read against the whole message
            let srvTarget = dnsName(msg, rdata + 6, length);
            if(srvTarget !== null && srvTarget.name.length > 0){
                records.push({ttl: ttl, priority: priority, weight: weight, port: port, target: srvTarget.name});
            }
        }else if(cls === DNS_CLASS_IN && type === DNS_TYPE_CNAME){
            let cnameTarget = dnsName(msg, rdata, length);
            if(cnameTarget !== null && cnameTarget.name.length > 0 && cname === null){
                cname = cnameTarget.name;
            }
        }

        // never let anything but RDLENGTH advance the stream
        pos = rdataEnd;
    }

    return {records: records, cname: cname};
}

/** Wire format of one SRV query. Kept apart from the socket work because the
 *  Rhino optimiser gives up (StackMapTable array overrun) when a single
 *  function holds too many locals - do not merge these back together. */
function dnsBuildQuery(name, id){
    const stream = new java.io.ByteArrayOutputStream(192);
    const out = new java.io.DataOutputStream(stream);
    const labels = name.split(".");

    out.writeShort(id);
    out.writeShort(0x0100);   // standard query, recursion desired
    out.writeShort(1);        // questions
    out.writeShort(0);
    out.writeShort(0);
    out.writeShort(0);

    for(let i = 0; i < labels.length; i++){
        let label = labels[i];
        if(label.length === 0 || label.length > 63) continue;
        out.writeByte(label.length);
        out.writeBytes(label);
    }
    out.writeByte(0);
    out.writeShort(DNS_TYPE_SRV);
    out.writeShort(DNS_CLASS_IN);
    out.flush();

    return stream.toByteArray();
}

/** Receive one answer and drop it unless it belongs to our query. */
function dnsReceive(socket, id){
    const buffer = java.nio.ByteBuffer.allocate(DNS_BUFFER).array();

    try{
        const packet = new java.net.DatagramPacket(buffer, buffer.length);
        socket.receive(packet);

        const length = packet.getLength();
        if(length < 12) return null;

        const replyId = ((buffer[0] & 0xff) << 8) | (buffer[1] & 0xff);
        if(replyId !== id) return null;

        return {text: dnsText(packet.getData(), length), length: length};
    }catch(e){
        return null;
    }
}

/** Send one SRV query to one nameserver.
 *  @return {text, length} or null when nothing answered. */
function dnsExchange(name, nameserver){
    const socket = new java.net.DatagramSocket();

    try{
        const id = (Math.random() * 65535) | 0;
        const request = dnsBuildQuery(name, id);

        socket.setSoTimeout(DNS_TIMEOUT);
        socket.send(new java.net.DatagramPacket(request, request.length, nameserver));
        return dnsReceive(socket, id);
    }catch(e){
        return null;
    }finally{
        try{
            socket.close();
        }catch(ignored){
        }
    }
}

/** Resolve one SRV name through a single nameserver, following CNAMEs.
 *  @return {records} when the nameserver ANSWERED (an empty array means the
 *          name really has no SRV record), or null when it did not answer /
 *          answered with something unparsable. Keeping those two apart is what
 *          lets the caller retry the one and trust the other. */
function dnsQueryOnce(name, nameserver){
    const visited = new java.util.HashSet();
    let current = name;

    for(let depth = 0; depth < DNS_CNAME_DEPTH; depth++){
        if(!visited.add(new java.lang.String(current.toLowerCase()))) return {records: []};

        let answer = dnsExchange(current, nameserver);
        if(answer === null) return null;

        let parsed = dnsParseAnswer(answer.text, answer.length);
        if(parsed === null) return null;

        if(parsed.records.length > 0) return {records: parsed.records};
        // an answer without SRV and without CNAME is a definitive "no record"
        if(parsed.cname === null) return {records: []};

        current = stripDot(parsed.cname);
        if(isNoService(current)) return {records: []};
    }

    return {records: []};
}

/** Wrap parsed records in an arc Seq, sorted by priority then weight exactly
 *  like ArcDns does. */
function toSrvSeq(records){
    const seq = new Packages.arc.struct.Seq();
    for(let i = 0; i < records.length; i++){
        let record = records[i];
        seq.add(new Packages.arc.net.dns.SRVRecord(record.ttl, record.priority,
            record.weight, record.port, new java.lang.String(record.target)));
    }
    return seq.sort();
}

module.exports = {

    dnsQueryOnce: dnsQueryOnce,

    toSrvSeq: toSrvSeq

};
