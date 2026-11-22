proxy_http_version 1.1;
proxy_set_header Host $host;
# 真实来源地址（覆盖，不追加：客户端自己带的 X-Forwarded-For 不算数）：口令错误限流、审计按人算
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_buffering off;
proxy_read_timeout 3600s;
