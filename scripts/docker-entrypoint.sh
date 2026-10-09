#!/bin/sh
# コンテナの起動処理。
# データの保存先(既定 /data)を node ユーザーが書けるようにしてから、node ユーザーに切り替えてアプリを動かす。
# docker compose の ./data のように、ホスト側に root のディレクトリが自動で作られた場合でも起動できるようにするため。
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
    echo "[entrypoint] $DATA_DIR の所有者を node ユーザーに変更します"
    chown -R node:node "$DATA_DIR" || echo "[entrypoint] 所有者を変更できませんでした。$DATA_DIR を node ユーザー(UID 1000)が書けるようにしてください"
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
