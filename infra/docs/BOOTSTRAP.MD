cd /opt
git clone git@github.com:YOU/YOUR_REPO.git your-project

mkdir -p /srv/hls
mkdir -p /srv/recordings
mkdir -p /srv/logs


apt update
apt install -y \
  build-essential \
  libpcre3 libpcre3-dev \
  libssl-dev \
  zlib1g-dev \
  git \
  curl


cd /usr/local/src

git clone https://github.com/arut/nginx-rtmp-module.git
curl -LO http://nginx.org/download/nginx-1.24.0.tar.gz

tar xzf nginx-1.24.0.tar.gz
cd nginx-1.24.0


./configure \
  --prefix=/etc/nginx \
  --sbin-path=/usr/sbin/nginx \
  --conf-path=/etc/nginx/nginx.conf \
  --error-log-path=/var/log/nginx/error.log \
  --http-log-path=/var/log/nginx/access.log \
  --pid-path=/run/nginx.pid \
  --lock-path=/run/nginx.lock \
  --with-http_ssl_module \
  --with-http_stub_status_module \
  --add-module=../nginx-rtmp-module

make -j$(nproc)
make install

nginx -V 2>&1 | grep rtmp

You should see:

--add-module=../nginx-rtmp-module


systemctl start nginx
systemctl status nginx

Symlink:

ln -sf /opt/ionia/infra/nginx/nginx.conf /etc/nginx/nginx.conf

ln -sf /opt/ionia/infra/nginx/sites/streaming.conf \
       /etc/nginx/sites-enabled/streaming.conf

mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled

nano /etc/nginx/nginx.conf

copy:

# /etc/nginx/nginx.conf

worker_processes auto;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;

    sendfile        on;
    tcp_nopush      on;
    tcp_nodelay     on;
    keepalive_timeout 65;

    access_log /var/log/nginx/access.log;
    error_log  /var/log/nginx/error.log;

    # Include site configs
    include /etc/nginx/sites-enabled/*.conf;
}

# RTMP configuration
rtmp {
    server {
        listen 1935;
        chunk_size 4096;

        application live {
            live on;

            # HLS
            hls on;
            hls_path /srv/hls;
            hls_fragment 2s;
            hls_playlist_length 120s;

            # Recording
            record all;
            record_path /srv/srs/recordings;
            record_unique on;
            record_suffix .flv;
        }
    }
}

ls /etc/nginx/mime.types
nano /etc/nginx/mime.types


types {
    application/vnd.apple.mpegurl m3u8;
    video/mp2t ts;
}


nano /etc/nginx/sites-enabled/streaming.conf

server {
    listen 80;
    server_name _;

    # Serve HLS
    location /hls {
        root /srv;
        types {
            application/vnd.apple.mpegurl m3u8;
            video/mp2t ts;
        }
        add_header Cache-Control no-cache;
        add_header Access-Control-Allow-Origin *;
    }

    # Serve SRS recordings (VOD)
    # Filesystem root: /srv/srs/recordings (contains subfolders like /live)
    location = /vod {
        return 301 /vod/;
    }

    location /vod/ {
        alias /srv/srs/recordings/;
        autoindex on;
        autoindex_exact_size off;
        autoindex_localtime on;
        add_header Access-Control-Allow-Origin *;
    }
}


Deploy script lives in the repo:

- /opt/ionia/infra/scripts/deploy_nginx.sh

Manual run example:

- bash /opt/ionia/infra/scripts/deploy_nginx.sh phase-2-server-setup

chmod +x /opt/ionia/infra/scripts/deploy_nginx.sh

./infra/scripts/deploy_nginx.sh phase-2-server-setup (example)

chmod +x /opt/ionia/infra/scripts/deploy_nginx.sh

chown -R www-data:www-data /srv/recordings
chmod 755 /srv/recordings

or 
chown -R nobody:nogroup /srv/recordings

chmod +x /opt/ionia/infra/scripts/deploy_nginx.sh

--------------------------------------------------------------------------------------

git clone https://github.com/ossrs/srs.git

cd /opt/srs/trunk
git submodule update --init --recursive
./configure
make -j$(nproc)


mkdir -p /srv/srs/hls
mkdir -p /srv/srs/recordings

chmod -R 755 /srv/srs

cd /opt/srs/trunk
./objs/srs -c conf/ionia.conf


nano /etc/systemd/system/srs.service
[Unit]
Description=SRS Media Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/srs/trunk
ExecStart=/opt/srs/trunk/objs/srs -c /opt/srs/trunk/conf/ionia.conf

# THIS IS THE IMPORTANT PART
LimitNOFILE=10000

Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target

systemctl daemon-reload
systemctl start srs

# =====================================================
# Global
# =====================================================
listen              19350;
max_connections     1000;
daemon              off;

srs_log_tank        file;
srs_log_file        ./objs/srs.log;
srs_log_level       info;

# =====================================================
# HTTP Server (serves HLS files)
# URL root: http://host:8080/
# Filesystem root: /srv/srs/hls
# =====================================================
http_server {
    enabled on;
    listen 8080;
    dir /srv/srs/hls;
}

# =====================================================
# Default VHost
# =====================================================
vhost __defaultVhost__ {

    tcp_nodelay on;
    min_latency on;

    publish {
        mr off;
    }

    # -------------------------
    # HLS
    # -------------------------
    hls {
        enabled         on;

        hls_path        /srv/srs/hls;
        hls_fragment    2;
        hls_window      120;
        hls_cleanup     on;
        hls_dispose     120;

        # Final paths:
        # /srv/srs/hls/live/test3.m3u8
        # /srv/srs/hls/live/test3-xxx.ts
        hls_m3u8_file   [app]/[stream].m3u8;
        hls_ts_file     [app]/[stream]-[seq].ts;
    }

    # -------------------------
    # DVR
    # -------------------------
    dvr {
        enabled             on;
        dvr_path            /srv/srs/recordings;
        dvr_plan            session;
        dvr_wait_keyframe   on;
    }
}


sudo chmod +x /opt/ionia/infra/scripts/deploy_nginx.sh
