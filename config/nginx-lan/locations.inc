# 三个入口共用的地址表。`auth_request off;` 的地址在对外入口也不要登录；其余地址在对外入口要先过 auth_request。
# 内部入口（:81）和本机入口（:82）没有 server 级 auth_request，这些指令不起作用。
location = /healthz { auth_request off; return 200 'ok'; add_header Content-Type text/plain; }
location = / { auth_request off; return 302 /ioc/; }
location = /ioc { auth_request off; return 302 /ioc/; }
# 品牌名 / 公司名（OEM 隐藏配置，docs/BRANDING-OEM.md）：init / 开机按 .env 的 H2Z_BRAND_NAME / H2Z_COMPANY_NAME 生成的静态文件
# （docker2/runtime/brand.json 挂到 /usr/share/nginx/html/brand.json），只含 brandName / companyName 两项。登录页也要显示品牌，所以免登录；
# no-cache = 每次带条件请求重新验证，改了配置刷新页面就生效，不会被长缓存卡住。
location = /brand.json { auth_request off; default_type application/json; add_header Cache-Control "no-cache"; try_files /brand.json =404; }
# 页面壳和静态资源：要先打得开才能显示登录页。前端缓存同 config/nginx.conf（index.html 不缓存，带哈希的 assets 长缓存）
location /ioc/assets/ { auth_request off; try_files $uri =404; add_header Cache-Control "public, max-age=31536000, immutable"; }
location = /ioc/index.html { auth_request off; add_header Cache-Control "no-store"; }
location /ioc/ { auth_request off; add_header Cache-Control "no-store"; try_files $uri $uri/ /ioc/index.html; }
# 登录 / 退出 / 当前身份：本来就由 backend 自己鉴权（登录限流、JWT）；不放开这几个，登录页就没法登录
location = /api/login { auth_request off; include /etc/nginx/h2z/api-proxy.inc; rewrite ^/api/(.*) /$1 break; proxy_pass http://$up_backend; }
location = /api/logout { auth_request off; include /etc/nginx/h2z/api-proxy.inc; rewrite ^/api/(.*) /$1 break; proxy_pass http://$up_backend; }
location = /api/account/me { auth_request off; include /etc/nginx/h2z/api-proxy.inc; rewrite ^/api/(.*) /$1 break; proxy_pass http://$up_backend; }
location = /api/account/check { auth_request off; include /etc/nginx/h2z/api-proxy.inc; rewrite ^/api/(.*) /$1 break; proxy_pass http://$up_backend; }
# 健康检查（不含业务数据；开机就绪判断、监控用）
location = /api/ioc/health { auth_request off; include /etc/nginx/h2z/api-proxy.inc; rewrite ^/api/(.*) /$1 break; proxy_pass http://$up_backend; }
# iroh 边缘状态摘要（不含端点 ID / 配对信息 / 查看者列表）：登录页也要能显示「录像机在线」
location = /h2z-link/summary {
    auth_request off;
    proxy_pass http://$up_link/summary;
    proxy_http_version 1.1;
    proxy_connect_timeout 2s;
    proxy_read_timeout 5s;
    add_header Cache-Control "no-store";
}
# ---- 以下全部要登录（对外入口）----
location /api/ {
    # 滑动续期：backend 在 /account/check 的响应里带新的 Set-Cookie 时转给浏览器（没带就是空，不输出）
    auth_request_set $h2z_cookie $upstream_http_set_cookie;
    add_header Set-Cookie $h2z_cookie always;
    include /etc/nginx/h2z/api-proxy.inc;
    rewrite ^/api/(.*) /$1 break;
    proxy_pass http://$up_backend;
}
# H2Z OS 整包升级包（约 2 GB）：只有这一个地址放开大小，边收边转给后端（不在 nginx 落盘）
location = /api/ioc/device/network/upgrade/upload {
    include /etc/nginx/h2z/api-proxy.inc;
    rewrite ^/api/(.*) /$1 break;
    proxy_pass http://$up_backend;
    client_max_body_size 8g;
    proxy_request_buffering off;
    proxy_send_timeout 3600s;
}
# 浏览器走 IOC 带鉴权的 AI 中继，绝不暴露 h2z-api 的服务凭据
location /api/h2z/ { return 404; }
location = /mqtt {
    proxy_pass http://$up_emqx/mqtt;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
}
location /media/index/api/ { return 403; }
# 视频流：auth_request 只在请求开始时校验一次；长流中途会话过期不会被切断，重连才需要有效会话（所以 backend 要做长有效期 + 滑动续期）
location /media/ {
    rewrite ^/media/(.*) /$1 break;
    proxy_pass http://$up_zlm;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
