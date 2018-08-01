#!/bin/bash
CWD=$(cd "$(dirname $0)";pwd)

export NODE_PATH=${CWD}
export PATH=${CWD}/node_modules/.bin:${PATH}
chmod +x "${CWD}/node_modules/.bin/node"
chmod +x "${CWD}/node_modules/.bin/pm2"


cd ${CWD}
pm2 delete EasyDarwin
pm2 start pm2.config.js
pm2 log EasyDarwin --raw --lines 5 --nostream
