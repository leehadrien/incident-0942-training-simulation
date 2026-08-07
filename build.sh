#!/usr/bin/env bash
set -o errexit

pip install -r requirements.txt

FRONTEND_DIR="frontend"
if [[ ! -f "$FRONTEND_DIR/package.json" ]]; then
  FRONTEND_DIR="."
fi

npm --prefix "$FRONTEND_DIR" ci
npm --prefix "$FRONTEND_DIR" run build
