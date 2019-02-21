const net = require('net');
const event = require('events');
const shortid = require('shortid');
const url = require('url');
const path = require('path');
const rtpParser = require('rtp-parser');
const BufferPool = require('buffer-pool');
const sdpParser = require('sdp-transform');
const getPort = require('get-port');
const dgram = require('dgram');
const cfg = require('cfg');
const crypto = require("crypto");
const logger = require('./utils/logger');

class RTSPRequest {
    constructor() {
        this.method = '';
        this.url = '';
        this.raw = '';
    }
}

class RTSPSession extends event.EventEmitter {

    constructor(socket, server) {
        super();
        this.type = '';
        this.url = '';
        this.path = '';
        this.aControl = '';
        this.vControl = '';
        this.pushSession = null;
        this.playSessions = {};
        this.transType = 'tcp';

        this.checkConnection = null;

        //-- tcp trans params
        this.aRTPChannel = 0;
        this.aRTPControlChannel = 0;
        this.vRTPChannel = 0;
        this.vRTPControlChannel = 0;
        //-- tcp trans params end

        //-- udp trans params
        this.aRTPClientPort = 0;
        this.aRTPClientSocket = null;
        this.aRTPControlClientPort = 0;
        this.aRTPControlClientSocket = null;
        this.vRTPClientPort = 0;
        this.vRTPClientSocket = null;
        this.vRTPControlClientPort = 0;
        this.vRTPControlClientSocket = null;

        this.aRTPServerPort = 0;
        this.aRTPServerSocket = null;
        this.aRTPControlServerPort = 0;
        this.aRTPControlServerSocket = null;
        this.vRTPServerPort = 0;
        this.vRTPServerSocket = null;
        this.vRTPControlServerPort = 0;
        this.vRTPControlserverSokcet = null;
        //-- udp trans params end

        //-- sdp info
        this.sdp = null;
        this.sdpRaw = '';

        this.aCodec = '';
        this.aRate = '';
        this.aPayload = '';

        this.vCodec = '';
        this.vRate = '';
        this.vPayload = '';
        //-- sdp info end

        //-- stats info
        this.inBytes = 0;
        this.outBytes = 0;
        this.startAt = new Date();
        //-- stats info end

        this.sid = shortid.generate(); // session id
        this.socket = socket;
        this.host = this.socket.address().address;
        this.server = server;
        this.bp = new BufferPool(this.genHandleData());
        this.bp.init();
        this.gopCache = [];

        this.socket.on("data", data => {
            this.bp.push(data);
        }).on("close", () => {
            this.stop();
        }).on("error", err => {
            this.socket.destroy();
            logger.error(err);
        }).on("timeout", () => {
            this.socket.end();
        })
    }

    * genHandleData() {
        while (true) {
            if (this.bp.need(1)) {
                if (yield) return;
            }
            var buf = this.bp.read(1);
            if (buf.readUInt8() == 0x24) { // rtp over tcp
                if (this.bp.need(3)) {
                    if (yield) return;
                }
                buf = this.bp.read(3);
                var channel = buf.readUInt8();
                var rtpLen = buf.readUInt16BE(1);
                if (this.bp.need(rtpLen)) {
                    if (yield) return;
                }
                var rtpBody = this.bp.read(rtpLen);
                if (channel == this.aRTPChannel) {
                    this.broadcastAudio(rtpBody);
                } else if (channel == this.vRTPChannel) {
                    if (this.vCodec == 'H264') {
                        var rtp = rtpParser.parseRtpPacket(rtpBody);
                        if (rtpParser.isKeyframeStart(rtp.payload)) {
                            // console.log(`find key frame, current gop cache size[${this.gopCache.length}]`);
                            this.gopCache = [];
                        }
                        this.gopCache.push(rtpBody);
                    }
                    this.broadcastVideo(rtpBody);
                } else if (channel == this.aRTPControlChannel) {
                    this.broadcastAudioControl(rtpBody);
                } else if (channel == this.vRTPControlChannel) {
                    this.broadcastVideoControl(rtpBody);
                }
                this.inBytes += (rtpLen + 4);
            } else { // rtsp method
                var reqBuf = Buffer.concat([buf], 1);
                while (true) {
                    if (this.bp.need(1)) {
                        if (yield) return;
                    }
                    buf = this.bp.read(1);
                    reqBuf = Buffer.concat([reqBuf, buf], reqBuf.length + 1);
                    if (buf.toString() == '\n' && reqBuf.toString().endsWith("\r\n\r\n")) {
                        break;
                    }
                }
                var req = this.parseRequestHeader(reqBuf.toString());
                this.inBytes += reqBuf.length;
                if (req['Content-Length']) {
                    var bodyLen = parseInt(req['Content-Length']);
                    if (this.bp.need(bodyLen)) {
                        if (yield) return;
                    }
                    this.inBytes += bodyLen;
                    buf = this.bp.read(bodyLen);
                    var bodyRaw = buf.toString();
                    if (req.method == 'ANNOUNCE') {
                        this.sdp = sdpParser.parse(bodyRaw);
                        // console.log(JSON.stringify(this.sdp, null, 1));
                        this.sdpRaw = bodyRaw;
                        if (this.sdp && this.sdp.media && this.sdp.media.length > 0) {
                            for (var media of this.sdp.media) {
                                if (media.type == 'video') {
                                    this.vControl = media.control;
                                    if (media.rtp && media.rtp.length > 0) {
                                        this.vCodec = media.rtp[0].codec;
                                        this.vRate = media.rtp[0].rate;
                                        this.vPayload = media.rtp[0].payload;
                                    }
                                } else if (media.type == 'audio') {
                                    this.aControl = media.control;
                                    if (media.rtp && media.rtp.length > 0) {
                                        this.aCodec = media.rtp[0].codec;
                                        this.aRate = media.rtp[0].rate;
                                        this.aPayload = media.rtp[0].payload;
                                    }
                                }
                            }
                        }
                    }
                    req.raw += bodyRaw;
                }
                this.handleRequest(req);
            }
        }

    }

    /**
     * 
     * @param {Object} opt 
     * @param {Number} [opt.code=200]
     * @param {String} [opt.msg='OK']
     * @param {Object} [opt.headers={}]
     */
    makeResponseAndSend(opt = {}) {
        var def = { code: 200, msg: 'OK', headers: {} };
        var opt = Object.assign({}, def, opt);
        var raw = `RTSP/1.0 ${opt.code} ${opt.msg}\r\n`;
        for (var key in opt.headers) {
            raw += `${key}: ${opt.headers[key]}\r\n`;
        }
        raw += `\r\n`;
        logger.info(`>>>>>>>>>>>>> response[${opt.method}] >>>>>>>>>>>>>\n${raw}`);
        this.socket.write(raw);
        this.outBytes += raw.length;
        if (opt.body) {
            // console.log(new String(opt.body).toString());
            this.socket.write(opt.body);
            this.outBytes += opt.body.length;
        }
        return raw;
    }

    parseRequestHeader(header = '') {
        var ret = new RTSPRequest();
        ret.raw = header;
        var lines = header.trim().split("\r\n");
        if (lines.length == 0) {
            return ret;
        }
        var line = lines[0];
        var items = line.split(/\s+/);
        ret.method = items[0];
        ret.url = items[1];
        for (var i = 1; i < lines.length; i++) {
            line = lines[i];
            items = line.split(/:\s+/);
            ret[items[0]] = items[1];
        }
        return ret;
    }

    parseQuery(query = '') {
        var result = {};
        query.split("&").forEach(function(part) {
            var item = part.split("=");
            result[item[0]] = decodeURIComponent(item[1]);
        });
        return result;
    }

    encrypt(key, salt, request) {
        var hmac = crypto.createHmac("sha512", key);
        var signing_key = hmac.update(salt).digest();
        
        var hmac2 = crypto.createHmac("sha512", signing_key);
        var signed = hmac2.update(new Buffer(request, 'utf-8')).digest('base64');

        return signed;
    }

    authenticate(method, cur_url) {
        var uri = cur_url.split("?");
        var raw_uri = uri[0];
        var param_list = uri[1].split("&");
        var param_uri = param_list[0];

        var params = this.parseQuery(url.parse(cur_url).query)

        var exp_time = params['expires'];
        var salt = params['salt'];
        var signature = params['signature'];

        if (!exp_time || !salt || !signature) {
            return '410';
        }

        //if curtime > exp_time, return false
        if (Date.now() > Date.parse(exp_time)) {
            return '407';
        }

        //if signature != signature, return false 
        //var secret_key = "\xe5\x9eG\x16\x0c\x9e\xfd\xd4\xfa[\xd2\x94\x0c\x96(MQ\xb0\x8d\xe95\xaf\x91UW&\xf29,\xab\x89\xd7V5\x99\xaa\x84^\xff\x95\xe0\xeb]J\x97~\xcc8@&\n9S& \x02\xc8W\x9c\xbep\x9fe\xeb";

        var fs = require('fs');
        var secret_key_buffer = JSON.parse(fs.readFileSync(cfg.secret_key, 'utf8'));
        var secret_key_hex = secret_key_buffer['STREAM_SECRET_KEY'];

        var secret_key = new Buffer(secret_key_hex, 'hex');
        var prefix = Buffer.from('TV');
        var arr = [prefix, secret_key];
        secret_key = Buffer.concat(arr);

        var request = method + '\n' + raw_uri + '\n' + param_uri;
        var salt_raw = new Buffer(salt, 'base64');

        if (this.encrypt(secret_key, salt_raw, request) != signature) {
            return '408';
        } 

        return '100'
    }


    /**
     * 
     * @param {RTSPRequest} req 
     */
    async handleRequest(req) {
        logger.info(`<<<<<<<<<<< request[${req.method}] <<<<<<<<<<<<<\n${req.raw}`);
        var res = {
            method: req.method,
            headers: {
                CSeq: req['CSeq'],
                Session: this.sid
            }
        };
        switch (req.method) {
            case 'OPTIONS':
                res.headers['Public'] = "DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, OPTIONS, ANNOUNCE, RECORD";
                break;
            case 'ANNOUNCE':
                this.type = 'pusher';
                this.url = req.url;
                this.path = url.parse(this.url).pathname;

                var res_code = this.authenticate(req.method, this.url);
                if (res_code != '100') {
                    res.code = res_code;
                    res.msg = 'Not Acceptable';
                    break;
                }

                var pushSession = this.server.sessions[this.path];
                if (pushSession) {
                    res.code = 406;
                    res.msg = 'Not Acceptable';
                }
                this.checkConnection = setInterval(this.checkNoConnection.bind(this), 30000);
                break;
            case 'SETUP':
                var ts = req['Transport'] || "";
                var control = req.url.substring(req.url.lastIndexOf('/') + 1);
                var mtcp = ts.match(/interleaved=(\d+)(-(\d+))?/);
                var mudp = ts.match(/client_port=(\d+)(-(\d+))?/);
                if (mtcp) {
                    this.transType = 'tcp';
                    if (control == this.vControl) {
                        this.vRTPChannel = parseInt(mtcp[1]) || 0;
                        this.vRTPControlChannel = parseInt(mtcp[3]) || 0;
                    }
                    if (control == this.aControl) {
                        this.aRTPChannel = parseInt(mtcp[1]) || 0;
                        this.aRTPControlChannel = parseInt(mtcp[3]) || 0;
                    }
                } else if (mudp) {
                    this.transType = 'udp';
                    if (control == this.aControl) {
                        this.aRTPClientPort = parseInt(mudp[1]) || 0;
                        this.aRTPClientSocket = dgram.createSocket(this.getUDPType());
                        this.aRTPControlClientPort = parseInt(mudp[3]) || 0;
                        if (this.aRTPControlClientPort) {
                            this.aRTPControlClientSocket = dgram.createSocket(this.getUDPType());
                        }
                        if (this.type == 'pusher') {
                            this.aRTPServerPort = await getPort();
                            this.aRTPServerSocket = dgram.createSocket(this.getUDPType());
                            this.aRTPServerSocket.on('message', buf => {
                                this.inBytes += buf.length;
                                this.broadcastAudio(buf);
                            }).on('error', err => {
                                logger.error(err);
                            })
                            await this.bindUDPPort(this.aRTPServerSocket, this.aRTPServerPort);
                            this.aRTPControlServerPort = await getPort();
                            this.aRTPControlServerSocket = dgram.createSocket(this.getUDPType());
                            this.aRTPControlServerSocket.on('message', buf => {
                                this.inBytes += buf.length;
                                this.broadcastAudioControl(buf);
                            }).on('error', err => {
                                logger.error(err);
                            })
                            await this.bindUDPPort(this.aRTPControlServerSocket, this.aRTPControlServerPort);
                            ts = ts.split(';');
                            ts.splice(ts.indexOf(mudp[0]) + 1, 0, `server_port=${this.aRTPServerPort}-${this.aRTPControlServerPort}`);
                            ts = ts.join(';');
                        }
                    }
                    if (control == this.vControl) {
                        this.vRTPClientPort = parseInt(mudp[1]) || 0;
                        this.vRTPClientSocket = dgram.createSocket(this.getUDPType());
                        this.vRTPControlClientPort = parseInt(mudp[3]) || 0;
                        if (this.vRTPControlClientPort) {
                            this.vRTPControlClientSocket = dgram.createSocket(this.getUDPType());
                        }
                        if (this.type == 'pusher') {
                            this.vRTPServerPort = await getPort();
                            this.vRTPServerSocket = dgram.createSocket(this.getUDPType());
                            this.vRTPServerSocket.on('message', buf => {
                                if (this.vCodec.toUpperCase() == 'H264') {
                                    var rtp = rtpParser.parseRtpPacket(buf);
                                    if (rtpParser.isKeyframeStart(rtp.payload)) {
                                        // console.log(`find key frame, current gop cache size[${this.gopCache.length}]`);
                                        this.gopCache = [];
                                    }
                                    this.gopCache.push(buf);
                                }
                                this.inBytes += buf.length;
                                this.broadcastVideo(buf);
                            }).on('error', err => {
                                logger.error(err);
                            })
                            await this.bindUDPPort(this.vRTPServerSocket, this.vRTPServerPort);
                            this.vRTPControlServerPort = await getPort();
                            this.vRTPControlserverSokcet = dgram.createSocket(this.getUDPType());
                            this.vRTPControlserverSokcet.on('message', buf => {
                                this.inBytes += buf.length;
                                this.broadcastVideoControl(buf);
                            })
                            await this.bindUDPPort(this.vRTPControlserverSokcet, this.vRTPControlServerPort);
                            ts = ts.split(';');
                            ts.splice(ts.indexOf(mudp[0]) + 1, 0, `server_port=${this.vRTPServerPort}-${this.vRTPControlServerPort}`);
                            ts = ts.join(';');
                        }
                    }
                }
                res.headers['Transport'] = ts;
                break;
            case 'DESCRIBE':
                this.type = 'player';
                this.url = req.url;
                this.path = url.parse(this.url).pathname;

           
                var res_code = this.authenticate(req.method, this.url);
                if (res_code != '100') {
                    res.code = res_code;
                    res.msg = 'Not Acceptable';
                    break;
                }


                var pushSession = this.server.sessions[this.path];
                if (pushSession && pushSession.sdpRaw) {
                    res.headers['Content-Length'] = pushSession.sdpRaw.length;
                    res.body = pushSession.sdpRaw;
                    this.sdp = pushSession.sdp;
                    this.sdpRaw = pushSession.sdpRaw;

                    this.aControl = pushSession.aControl;
                    this.aCodec = pushSession.aCodec;
                    this.aRate = pushSession.aRate;
                    this.aPayload = pushSession.aPlayload;

                    this.vControl = pushSession.vControl;
                    this.vCodec= pushSession.vCodec;
                    this.vRate = pushSession.vRate;
                    this.vPayload = pushSession.vPayload;

                    this.pushSession = pushSession;
                } else {
                    res.code = 404;
                    res.msg = 'NOT FOUND';
                }
                break;
            case 'PLAY':
                process.nextTick(() => {
                    if(this.pushSession) {
                        this.sendGOPCache();
                        this.pushSession.playSessions[this.sid] = this;
                    }
                })
                res.headers['Range'] = req['Range'];
                break;
            case 'RECORD':
                process.nextTick(() => {
                    this.server.sessions[this.path] = this;
                })
                break;
            case 'TEARDOWN':
                this.makeResponseAndSend(res);
                this.socket.end();
                return;
        }
        this.makeResponseAndSend(res);
    }

    checkNoConnection() {
        var session = this.server.sessions[this.path];
        var stop = !session || Object.keys(session.playSessions).length == 0;
        logger.info('checkNoConnection: path=' + this.path + ', stop=' + stop);
        if (stop) {
            if(session) {
                this.stop();
            }
            clearInterval(this.checkConnection);
        }
    }
 
    stop() {
        this.bp.stop();

        if(this.type == 'pusher') {
            delete this.server.sessions[this.path];
        } else if(this.type == 'player' && this.pushSession) {
            delete this.pushSession.playSessions[this.sid];
        }

        this.aRTPClientSocket && this.aRTPClientSocket.close();
        this.aRTPControlClientSocket && this.aRTPControlClientSocket.close();
        this.vRTPClientSocket && this.vRTPClientSocket.close();
        this.vRTPControlClientSocket && this.vRTPControlClientSocket.close();

        this.aRTPServerSocket && this.aRTPServerSocket.close();
        this.aRTPControlServerSocket && this.aRTPControlServerSocket.close();
        this.vRTPServerSocket && this.vRTPServerSocket.close();
        this.vRTPControlserverSokcet && this.vRTPControlserverSokcet.close();

        this.socket.destroy();
        logger.info(`end: rtsp session[type=${this.type}, path=${this.path}, sid=${this.sid}]`);
    }

    sendGOPCache() {
        for (var rtpBuf of this.pushSession.gopCache) {
            if (this.transType == 'tcp') {
                var len = rtpBuf.length + 4;
                var headerBuf = Buffer.allocUnsafe(4);
                headerBuf.writeUInt8(0x24, 0);
                headerBuf.writeUInt8(this.vRTPChannel, 1);
                headerBuf.writeUInt16BE(rtpBuf.length, 2);
                this.socket.write(Buffer.concat([headerBuf, rtpBuf], len));
                this.outBytes += len;
                this.pushSession.outBytes += len;
            } else if(false && this.transType == 'udp' && this.vRTPClientSocket) {// disable gop cache in UDP mode
                this.vRTPClientSocket.send(rtpBuf, this.vRTPClientPort, this.host);
                this.outBytes += rtpBuf.length;
                this.pushSession.outBytes += rtpBuf.length;
            }
        }
    }

    sendVideo(rtpBuf) {
        if (this.transType == 'tcp') {
            var len = rtpBuf.length + 4;
            var headerBuf = Buffer.allocUnsafe(4);
            headerBuf.writeUInt8(0x24, 0);
            headerBuf.writeUInt8(this.vRTPChannel, 1);
            headerBuf.writeUInt16BE(rtpBuf.length, 2);
            this.socket.write(Buffer.concat([headerBuf, rtpBuf], len));
            this.outBytes += len;
            this.pushSession.outBytes += len;
        } else if (this.transType == 'udp' && this.vRTPClientSocket) {
            this.vRTPClientSocket.send(rtpBuf, this.vRTPClientPort, this.host);
            this.outBytes += rtpBuf.length;
            this.pushSession.outBytes += rtpBuf.length;
        }
    }

    sendVideoControl(rtpBuf) {
        if (this.transType == 'tcp') {
            var len = rtpBuf.length + 4;
            var headerBuf = Buffer.allocUnsafe(4);
            headerBuf.writeUInt8(0x24, 0);
            headerBuf.writeUInt8(this.vRTPControlChannel, 1);
            headerBuf.writeUInt16BE(rtpBuf.length, 2);
            this.socket.write(Buffer.concat([headerBuf, rtpBuf], len));
            this.outBytes += len;
            this.pushSession.outBytes += len;
        } else if (this.transType == 'udp' && this.vRTPControlClientSocket) {
            this.vRTPControlClientSocket.send(rtpBuf, this.vRTPControlClientPort, this.host);
            this.outBytes += rtpBuf.length;
            this.pushSession.outBytes += rtpBuf.length;
        }
    }

    sendAudio(rtpBuf) {
        if (this.transType == 'tcp') {
            var len = rtpBuf.length + 4;
            var headerBuf = Buffer.allocUnsafe(4);
            headerBuf.writeUInt8(0x24, 0);
            headerBuf.writeUInt8(this.aRTPChannel, 1);
            headerBuf.writeUInt16BE(rtpBuf.length, 2);
            this.socket.write(Buffer.concat([headerBuf, rtpBuf], len));
            this.outBytes += len;
            this.pushSession.outBytes += len;
        } else if (this.transType == 'udp' && this.aRTPClientSocket) {
            this.aRTPClientSocket.send(rtpBuf, this.aRTPClientPort, this.host);
            this.outBytes += rtpBuf.length;
            this.pushSession.outBytes += rtpBuf.length;
        }
    }

    sendAudioControl(rtpBuf) {
        if (this.transType == 'tcp') {
            var len = rtpBuf.length + 4;
            var headerBuf = Buffer.allocUnsafe(4);
            headerBuf.writeUInt8(0x24, 0);
            headerBuf.writeUInt8(this.aRTPControlChannel, 1);
            headerBuf.writeUInt16BE(rtpBuf.length, 2);
            this.socket.write(Buffer.concat([headerBuf, rtpBuf], len));
            this.outBytes += len;
            this.pushSession.outBytes += len;
        } else if (this.transType == 'udp' && this.aRTPControlClientSocket) {
            this.aRTPControlClientSocket.send(rtpBuf, this.aRTPControlClientPort, this.host);
            this.outBytes += rtpBuf.length;
            this.pushSession.outBytes += rtpBuf.length;
        }
    }

    broadcastVideo(rtpBuf) {
        for (var sid in this.playSessions) {
            this.playSessions[sid].sendVideo(rtpBuf);
        }
    }

    broadcastVideoControl(rtpBuf) {
        for (var sid in this.playSessions) {
            this.playSessions[sid].sendVideoControl(rtpBuf);
        }
    }

    broadcastAudio(rtpBuf) {
        for (var sid in this.playSessions) {
            this.playSessions[sid].sendAudio(rtpBuf);
        }
    }

    broadcastAudioControl(rtpBuf) {
        for (var sid in this.playSessions) {
            this.playSessions[sid].sendAudioControl(rtpBuf);
        }
    }

    sleep(timeout = 1000) {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve();
            }, timeout);
        })
    }

    getUDPType() {
        return this.socket.address().family == 'IPv6' ? 'udp6' : 'udp4';
    }

    sendUDPPack(buf, socket, port, host) {
        return new Promise((resolve, reject) => {
            socket.send(buf, port, host, (err, len) => {
                resolve();
            })
        })
    }

    bindUDPPort(socket, port) {
        return new Promise((resolve, reject) => {
            socket.bind(port, () => {
                // console.log(`UDP socket bind on ${port} done.`);
                resolve();
            })
        })
    }
}

module.exports = RTSPSession;
