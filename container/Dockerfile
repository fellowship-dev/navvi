FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1
ENV NAVVI_PORT=8024
ENV VNC_PORT=6080

# System packages: Firefox ESR, Xvfb, xdotool, scrot, x11vnc, Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    firefox-esr \
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
    && rm -rf /var/lib/apt/lists/*

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

# Firefox profile directory (mount a named volume here for persistence)
RUN mkdir -p /home/user/.mozilla

EXPOSE 8024 6080

ENTRYPOINT ["/opt/navvi/start.sh"]
