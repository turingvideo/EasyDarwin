const path = require("path");
const os = require("os");
const fs = require('fs');
const conf_path = './config.json';

var config = {}
if (fs.existsSync(conf_path)){
    config = require(conf_path);
}

const where = config.run_where || 'local';
const cfg = {
    http_port: 10008,
    rtsp_tcp_port: 8554,
    defaultPwd: 'admin',
    rootDir: __dirname,
    wwwDir: path.resolve(__dirname, "www"),
    dataDir: config.data_dir || path.resolve(os.homedir(), ".easydarwin"),
    tls: {
        key: config.tls_key || '/home/ubuntu/ssl/turingvideo.key',
        cert: config.tls_cert || '/home/ubuntu/ssl/STAR_turingvideo_com.bundle'
    },
    secret_key: config.secret_key || '/home/ubuntu/EasyDarwin/environment.json',
    enableAuthentication: true
};

if(where === 'local') {
    cfg.tls = null;
    cfg.enableAuthentication = false;
}

if(cfg.tls) {
    cfg.tls.key = fs.readFileSync(cfg.tls.key);
    cfg.tls.cert = fs.readFileSync(cfg.tls.cert);
}

module.exports = cfg;