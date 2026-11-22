absolute_redirect off;
root /usr/share/nginx/html;
client_max_body_size 100m;
# 上游按名字每次重新解析（Docker 内置 DNS），单独重建容器换了 IP 时不会一直连旧地址
resolver 127.0.0.11 valid=10s ipv6=off;
set $up_backend backend:3001;
set $up_zlm zlm:80;
set $up_link edge-link:8099;
set $up_emqx emqx:8083;
