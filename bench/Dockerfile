# Reproducible image for the delegation benchmark.
#
# Pinned on purpose: a benchmark result is only meaningful together with the
# core, pi, and node versions that produced it.
FROM node:22-bookworm-slim

ARG HC_VERSION=0.1.21
ARG PI_VERSION=1.5.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tar \
  && rm -rf /var/lib/apt/lists/*

# herdr-core ships per-target tarballs. Accept either layout: a plain binary or
# an archive with the binary at some depth.
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    arm64) target="linux-aarch64" ;; \
    amd64) target="linux-x86_64" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  url="https://releases.herdr.dev/core/${HC_VERSION}/herdr-core-${target}.tar.gz"; \
  mkdir -p /opt/hc; \
  curl -fsSL "$url" -o /tmp/hc-download; \
  if tar -tzf /tmp/hc-download >/dev/null 2>&1; then \
    tar -xzf /tmp/hc-download -C /opt/hc; \
    binary="$(find /opt/hc -type f -name 'herdr-core*' -perm -u+x | head -n 1)"; \
  else \
    binary=/opt/hc/herdr-core; \
    cp /tmp/hc-download "$binary"; \
  fi; \
  test -n "$binary"; \
  chmod 755 "$binary"; \
  ln -sf "$binary" /usr/local/bin/herdr-core; \
  ln -sf "$binary" /usr/local/bin/hc; \
  hc --version; \
  rm -f /tmp/hc-download

RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && pi --version

WORKDIR /work
ENTRYPOINT ["bash", "/work/bench/container.sh"]
CMD []
