const path = require("path");
const os = require("os");
const fs = require('fs');

const cfg = {
    http_port: 10008,
    rtsp_tcp_port: 8554,
    defaultPwd: 'admin',
    rootDir: __dirname,
    wwwDir: path.resolve(__dirname, "www"),
    dataDir: path.resolve(os.homedir(), ".easydarwin"),
    tls: {
        key: '',
        cert: ''
    }
};

if(cfg.tls) {
    cfg.tls.key = fs.readFileSync(cfg.tls.key);
    cfg.tls.cert = fs.readFileSync(cfg.tls.cert);
}

module.exports = cfg;