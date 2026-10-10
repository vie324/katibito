# 面接記録アプリ(運用版)のコンテナ。
#   docker build -t katibito .
#   docker run -p 8787:8787 -v $(pwd)/data:/data katibito
# HTTPS は前段のリバースプロキシ(deploy/ の Caddy 構成)で終端する。

# ---------------------------------------------------------------- build
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------------------------------------------------------------- whisper.cpp(文字起こし)
# 録画の音声をサーバーの中で文字にする。モデルは初回に DATA_DIR/models へ取得する(イメージには入れない)
FROM node:22-bookworm-slim AS whisper
RUN apt-get update \
  && apt-get install -y --no-install-recommends git cmake g++ make ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG WHISPER_VERSION=v1.7.6
RUN git clone --depth 1 --branch ${WHISPER_VERSION} https://github.com/ggml-org/whisper.cpp /whisper
WORKDIR /whisper
ARG TARGETARCH
# どのサーバーでも動くように、その場の CPU 向けの最適化はしない(x86_64 は AVX2 を前提にする)。
# OpenMP は使わない(実行時に必要なライブラリを増やさない)
RUN set -eux; \
  extra=""; \
  if [ "${TARGETARCH:-amd64}" = "amd64" ]; then extra="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"; fi; \
  cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF $extra; \
  cmake --build build -j"$(nproc)" --target whisper-cli; \
  strip build/bin/whisper-cli

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim
# ffmpeg: 録画を iPhone などでも再生できる MP4 に変換するため(なくても動く)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=whisper /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY scripts/docker-entrypoint.sh /usr/local/bin/katibito-entrypoint
RUN chmod +x /usr/local/bin/katibito-entrypoint && mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 起動時にデータの保存先の所有者を整えてから、node ユーザー(root ではない)でアプリを動かす
ENTRYPOINT ["katibito-entrypoint"]
CMD ["node", "dist-server/main.js"]
