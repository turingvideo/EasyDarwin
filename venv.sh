#!/bin/bash
# Usage: source venv.sh
CWD=$(cd "$(dirname $1)";pwd)

export NODE_PATH=${CWD}
export PATH=${CWD}/node_modules/.bin:${PATH}
