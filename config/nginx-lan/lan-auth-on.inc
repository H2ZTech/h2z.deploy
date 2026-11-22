# 对外入口要登录：整个 server 默认走 auth_request，下面 locations.inc 里标了 `auth_request off;` 的地址放行。
# 依赖 h2z.backend 的 GET /account/check 和 GET /ioc/access/media-check（带 cookie h2z_token 或 Authorization，有效回 204，无效回 401）。backend 镜像没有这个接口时
# 这个入口会把受保护地址全拒掉：升级顺序是先 backend 后 security（docs/link/lan-web-login.md）。
auth_request /_h2z_auth;
location = /_h2z_auth {
    internal;
    # 项目的只读接口：交给 IOC 按项目判断（default.conf 的 $h2z_ioc_public）
    if ($h2z_ioc_public) { return 204; }
    # 先验登录（/account/check：有效 → 204，剩余有效期不足一半时顺带续期 cookie）。
    # 没登录（401）且是视频流 / IOC 接口 → 落到 @h2z_site 按站点判断（见下）；其余地址（账号管理、设备网页代理、mqtt……）仍然要登录
    proxy_intercept_errors on;
    error_page 401 = @h2z_site;
    proxy_pass http://$up_backend/account/check;
    proxy_http_version 1.1;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_connect_timeout 2s;
    proxy_read_timeout 5s;
}
# 站点级放行（统一规则）：站点里所有项目都没有访问授权 = 开放，IOC 的视频流和接口不需要登录（匿名 = 完全权限）；
# 只要有一个项目授权了用户 / 设了口令，没登录就是 401。由 h2z.backend 的 GET /ioc/access/media-check 判断。
location @h2z_site {
    internal;
    if ($request_uri !~ ^/(media/|api/ioc/(?!device-web))) { return 401; }
    proxy_pass http://$up_backend/ioc/access/media-check;
    proxy_http_version 1.1;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_connect_timeout 2s;
    proxy_read_timeout 5s;
}
