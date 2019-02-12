#!/bin/bash
CWD=$(cd "$(dirname $0)";pwd)

export NODE_PATH=${CWD}
export PATH=${CWD}/node_modules/.bin:${PATH}
