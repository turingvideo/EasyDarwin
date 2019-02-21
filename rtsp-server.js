const tls = require('tls');
const fs = require('fs');
const net = require('net');
const ip = require('@penggy/internal-ip');
const RTSPSession = require('rtsp-session');
const events = require('events');
const cfg = require('cfg');
const logger = require('./utils/logger');

class RTSPServer extends events.EventEmitter {

    constructor(port = 554) {
        super();
        this.port = port;
        // push sessions : path <-> session
        this.sessions = {};
        var connectName = ''
        var protocol = ''
        if(cfg.tls) {
            connectName = "secureConnection"
            protocol = 'rtsps'
            const options = {
                key: cfg.tls.key,
                cert: cfg.tls.cert
            };
            this.server = tls.createServer(options);
        }
        else {
            connectName = 'connection'
            protocol = 'rtsp'
            this.server = net.createServer();
        }
        this.server.on(connectName, socket => {
            new RTSPSession(socket, this);
        }).on("error", err => {
            logger.error('rtsp server error:', err);
        }).on("listening", async () => {
            var host = await ip.v4();
            var env = process.env.NODE_ENV || "development";
            logger.info(`EasyDarwin rtsp server listening on ${protocol}://${host}:${this.port} in ${env} mode`);
        })
    }

    start() {
        this.server.listen(this.port);
        this.stats();
    }

    stats() {
        require('routes/stats').rtspServer = this;
    }

    addSession(session) {
        if(session.type == 'pusher') {
            this.sessions[session.path] = session;
        } else if(session.type == 'player') {
            var playSessions = this.playSessions[session.path];
            if(!playSessions) {
                playSessions = [];
                this.playSessions[session.path] = playSessions;
            }
            if(playSessions.indexOf(session) < 0) {
                playSessions.push(session);
            }
        }
    }

    removeSession(session) {
        if(session.type == 'pusher') {
            delete this.sessions[session.path];
        } else if(session.type == 'player') {
            var playSessions = this.playSessions[session.path];
            if(playSessions && playSessions.length > 0) {
                var idx = playSessions.indexOf(session);
                if(idx >= 0) {
                    playSessions.splice(idx, 1);
                }
            }
        }
    }
}

module.exports = RTSPServer;