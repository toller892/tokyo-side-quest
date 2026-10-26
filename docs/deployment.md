# 部署

## 组成

| 进程 | 命令 | 说明 |
| --- | --- | --- |
| web | `pnpm start` | Next.js，监听 3000 |
| worker | `pnpm worker:start` | **必须单独运行**：发布 outbox、AI 核验和评分、渲染海报、执行删除、定时清理原始坐标 |
| migrate | `pnpm db:migrate` | 每次发布前执行一次 |
| PostgreSQL 15+ / PostGIS 3 | | 业务数据 |
| Redis 7+ | | BullMQ、限流、Worker 心跳（建议 `maxmemory-policy noeviction`） |
| S3 兼容存储 | | 私有 bucket：用户照片、参考图、票根 |

## Docker

```bash
docker build --build-arg APP_BASE_URL=https://你的域名 -t tokyo-side-quest:$(git rev-parse --short HEAD) .
cp .env.example tsq.env   # 填写生产值：SESSION_SECRET、存储、AI、MAP 等
POSTGRES_PASSWORD=... TSQ_VERSION=<tag> docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml run --rm web pnpm db:seed      # 首次导入内容（需要访问 Wikimedia）
docker compose -f docker-compose.prod.yml run --rm web pnpm db:seed asakusabashi   # 以后新增街区时只导入这个街区，已有街区不动
docker compose -f docker-compose.prod.yml run --rm web pnpm db:seed --quests-only  # 只给已有街区新增故事，地点、参考图和试玩样例都不动
docker compose -f docker-compose.prod.yml run --rm -it web pnpm admin:create
```

`docker-compose.prod.yml` 包含 postgres、redis、migrate（一次性任务）、web 和 worker。对象存储默认使用外部 S3 兼容服务，在 `tsq.env` 中配置；如果要自托管，叠加 `docker-compose.selfhost-storage.yml`（SeaweedFS，只在 compose 内网可见），说明见文件开头。

## HTTPS（必需）

浏览器定位只在安全上下文（HTTPS）中可用，Cookie 在 `APP_BASE_URL` 为 https 时才会设置 `Secure`。请在前面放一层反向代理：

```nginx
server {
  server_name tokyo.example.com;
  client_max_body_size 16m;            # 照片上限 15 MB
  location / {
    proxy_pass http://127.0.0.1:3010;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

在反向代理后面运行时，设置 `TRUST_PROXY=true`，IP 维度的限流才能生效。

**手机联调**：局域网 HTTP 地址上定位一定会失败，这不是功能问题。请使用可信的 HTTPS 预览域名。

## 发布前检查

1. `GET /api/v1/health/ready` 返回 200，并且 database、queue、worker、storage 全部为 ok。
2. 用 owner 账号打开 `/admin` →“设置”，填写视觉 AI 和 MapTiler key（或者用 `.env`），先点“测试连接”。再到“系统状态”确认 AI 和地图的状态符合预期。
3. 配置了 AI 时运行 `pnpm ai:smoke`，确认真实调用正常。

后台保存的 AI Key 用 `SESSION_SECRET` 派生的密钥加密（AES-256-GCM）。**更换 `SESSION_SECRET` 后需要在后台重新填写 AI Key**，在那之前照片核验会显示未开通，后台会提示“无法解密”。MapTiler key 是浏览器端公开 key，请在 MapTiler 后台把 Allowed HTTP origins 限制为站点域名。
4. 用手机通过 HTTPS 打开 `/explore`，验证定位允许和拒绝两种情况。

## 数据保护

- 原始定位坐标在 `LOCATION_RAW_RETENTION_HOURS`（默认 24）小时后由 Worker 清除。
- 删除照片或访客数据后，Worker 会立即删除存储中的文件。**备份中的副本按你的备份保留周期过期**，请在隐私说明里如实写明这一点。
- 模型提供方的数据处理和保留设置请在这里记录（本项目没有替提供方承诺零保留）：____
- 日志不包含照片、坐标或令牌。

## 回滚

镜像按 commit 打标签，回滚时把 `TSQ_VERSION` 改回上一个标签即可。数据库迁移只做增量变更；如需回退结构，必须单独评估。
