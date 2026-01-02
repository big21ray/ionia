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
            record_path /srv/recordings;
            record_unique on;
            record_suffix .mp4;
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

    # Optional: serve recordings directly
    location /vod {
        root /srv;
        add_header Access-Control-Allow-Origin *;
    }
}
