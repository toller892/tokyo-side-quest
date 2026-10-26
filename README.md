# 东京支线 · Tokyo Side Quest

**不用做攻略，花一小时，成为一段东京故事的主角。**

基于位置的东京街区探索网页应用：发现附近地点 → 自由探索或领取原创故事 → 定位或拍照打卡 → AI 核对照片地点 → 七档摄影评级 → 收藏印章与作品 → 生成纪念票根。

> 状态（2026-10-23）：P0 主体功能已实现，单元测试、集成测试和端到端测试都已通过。**以下几项尚未完成真实环境验证**：真实 AI 调用、手机 HTTPS 实地定位、地图底图。详情见 [docs/acceptance.md](docs/acceptance.md)。

规格文档：[docs/development-spec.md](docs/development-spec.md)

## 已实现

- 发现附近：只在用户主动点击后定位，定位失败、拒绝或超时时可以手动选择街区；PostGIS 按直线距离检索；有地图和列表两种视图（未配置底图时只显示列表）。
- 首发街区谷中：6 个地点档案，坐标和资料都标注来源（桌面核对）；3 条原创故事：《猫店长的失落明信片》（4 个主要任务）、《晚霞收集簿》（4 个）、《会走时间的怀表》（5 个）。
- 第二个街区浅草桥（2026-10-26 新增）：柳桥、鸟越神社 2 个地点（桌面核对），原创短故事《迷路的祭礼提灯》（2 个主要任务）。
- 定位打卡：由服务端计算距离，并检查定位精度和读数时间；靠近边界时提示重新定位；原始坐标在 24 小时后清除。
- 拍照打卡：照片清除 EXIF 后异步处理，**先核对地点，再评价摄影**，七档等级由服务端根据分数计算；有缓存去重、失败重试和人工复核。
- 访客身份（无需注册）、足迹、印章（数据库唯一约束保证不重复发放）、作品和历史最佳、故事进度（可结束、可恢复）。
- 1080×1440 PNG 纪念票根：用户主动创建分享链接后才公开，并带二维码；撤销后链接立即失效。
- 在线试玩：固定样例结果，明确标注，与真实数据完全隔离。
- 管理后台：管理员认证、地点与参考图版本管理、故事版本管理、人工复核、AI 任务、系统状态和操作日志。
- 数据设置：删除单张照片、撤销分享、清空全部访客数据。
- 宣传素材：首页、品牌主海报、分享预览图、印章设计（`apps/web/public/brand/`）。

## 本地运行

需要 Node 22 以上、pnpm 10、Docker（含 Compose）。

```bash
pnpm install
pnpm fonts:fetch            # 下载并校验票根所需的 Noto CJK 字体（OFL）
cp .env.example .env        # 填写 SESSION_SECRET（openssl rand -hex 32）
docker compose up -d        # PostGIS、Redis、SeaweedFS（S3 兼容）
pnpm db:migrate
pnpm db:seed                # 导入全部街区内容；会从 Wikimedia Commons 下载授权参考图
pnpm dev                    # Web：http://localhost:3000
pnpm worker:dev             # 另开一个终端：后台 Worker（核验、评分、海报、删除）
```

管理员账号用 `pnpm admin:create` 交互式创建，密码不会出现在命令行参数或日志里。后台地址是 `/admin`。

### 启用真实功能

| 功能 | 需要配置 | 未配置时的表现 |
| --- | --- | --- |
| 照片核验与评分 | 后台 `/admin` →“设置”（owner）：选 Anthropic 或 OpenAI 兼容协议，填接口地址、API Key、模型；也可以用 `.env` 的 `AI_*` 变量 | 提交入口说明“照片核验服务暂未开通”，不会生成任何结果 |
| 照片核验每日额度 | 后台“设置”→“每日额度”（owner）；默认用 `.env` 的 `AI_DAILY_CALL_LIMIT`（200 次/天，东京时间 0 点重置） | 额度用完后，提交入口说明“今天的名额已用完，东京时间明天 0 点恢复”，引导改用定位打卡；已受理的照片照常处理完 |
| 地图 | 后台“设置”填 MapTiler API Key；也可以用 `.env` 的 `MAP_STYLE_URL`（任意 MapLibre style） | 显示“地图暂不可用”，列表照常可用 |
| 手机定位 | HTTPS 访问 | 浏览器拒绝定位，页面说明原因并提供手动入口 |

后台设置优先于 `.env`；清除后台设置后回到 `.env` 的配置。设置页的“测试连接”会用表单里的值发一次真实的小请求，不保存。配置 AI 后运行 `pnpm ai:smoke`，会用授权样例图做一次真实模型冒烟测试，结果追加到 `docs/ai-evaluation-runs.jsonl`。

## 检查与测试

```bash
pnpm typecheck
pnpm lint
pnpm test                   # 单元测试：评分边界、定位规则、图片处理
pnpm test:integration       # 集成测试：真实 Postgres/Redis/S3，测试替身 AI
pnpm test:e2e               # Playwright：试玩流程与接口安全（需要 pnpm dev + worker 在运行）
scripts/e2e-stack.sh start  # 隔离的测试部署（:3100，测试替身 AI，独立数据库）
npx playwright test --project=live-360 --project=live-1440
scripts/e2e-stack.sh stop
```

`scripts/e2e-stack.sh start` 会执行 `next build`，和 `pnpm dev` 共用 `apps/web/.next`。之后如果开发服务器出现页面反复整页刷新（浏览器控制台提示 “HMR hash mismatch”），停掉 `pnpm dev`，删除 `apps/web/.next/dev` 再重启即可。

## 生产构建

```bash
pnpm build && pnpm start    # Web
pnpm worker:start           # Worker（必须单独运行）
```

Docker 与 HTTPS 部署见 [docs/deployment.md](docs/deployment.md)。

## 文档

- [架构](docs/architecture.md)：实际实现与规格的对应关系和差异
- [实现决策](docs/decisions.md)
- [内容来源与授权](docs/content-provenance.md)
- [AI 评估](docs/ai-evaluation.md)
- [验收报告](docs/acceptance.md)
- [部署](docs/deployment.md)
- [功能演示视频](docs/video/README.md)：4 分钟录屏讲解，带配音和字幕

## 许可证

原创代码与内容采用 [MIT License](LICENSE)。参考照片的权利归各自作者，按 [docs/content-provenance.md](docs/content-provenance.md) 记录的许可使用；票根字体为 Noto CJK（SIL OFL 1.1）。本项目为独立项目，与东京官方机构、商家或资料来源方没有合作或背书关系。
