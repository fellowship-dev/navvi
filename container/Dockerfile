FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1
ENV NAVVI_PORT=8024
ENV VNC_PORT=6080

# System packages: Xvfb, xdotool, scrot, x11vnc, Python + Camoufox deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xdotool \
    scrot \
    x11vnc \
    python3 \
    python3-pip \
    python3-venv \
    wget \
    unzip \
    procps \
    ca-certificates \
    gnupg \
    libgtk-3-0 \
    libasound2 \
    libx11-xcb1 \
    libdbus-glib-1-2 \
    && rm -rf /var/lib/apt/lists/*

# Install Camoufox (anti-detect Firefox) — binary fetched to /opt/camoufox
RUN pip3 install --no-cache-dir --break-system-packages camoufox \
    && python3 -m camoufox fetch \
    && CFOX_DIR=$(python3 -c "from camoufox.pkgman import camoufox_path; print(camoufox_path())") \
    && mkdir -p /opt/camoufox \
    && cp -a "$CFOX_DIR"/. /opt/camoufox/ \
    && chmod +x /opt/camoufox/camoufox-bin \
    && ln -s /opt/camoufox/camoufox-bin /usr/local/bin/camoufox-bin \
    && pip3 uninstall --break-system-packages -y camoufox playwright browserforge \
    && rm -rf /root/.cache/camoufox

# Install gopass (credential manager) — needs git as dependency
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
ARG GOPASS_VERSION=1.15.14
RUN ARCH=$(dpkg --print-architecture) \
    && wget -q "https://github.com/gopasspw/gopass/releases/download/v${GOPASS_VERSION}/gopass_${GOPASS_VERSION}_linux_${ARCH}.deb" -O /tmp/gopass.deb \
    && dpkg -i /tmp/gopass.deb \
    && rm /tmp/gopass.deb

# noVNC (web-based VNC client)
RUN wget -q https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz -O /tmp/novnc.tar.gz \
    && tar -xzf /tmp/novnc.tar.gz -C /opt \
    && mv /opt/noVNC-1.4.0 /opt/novnc \
    && ln -s /opt/novnc/vnc.html /opt/novnc/index.html \
    && rm /tmp/novnc.tar.gz

# websockify (noVNC needs it to proxy VNC)
RUN pip3 install --no-cache-dir --break-system-packages websockify

# Python dependencies
COPY requirements.txt /opt/navvi/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /opt/navvi/requirements.txt

# Application code
COPY navvi-server.py /opt/navvi/navvi-server.py
COPY marionette.py /opt/navvi/marionette.py
COPY start.sh /opt/navvi/start.sh
RUN chmod +x /opt/navvi/start.sh

# Create non-root user
RUN useradd -m -s /bin/bash user
USER user
WORKDIR /home/user

# Browser profile directory (mount a named volume here for persistence)
RUN mkdir -p /home/user/.mozilla

EXPOSE 8024 6080

ENTRYPOINT ["/opt/navvi/start.sh"]
