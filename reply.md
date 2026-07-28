已复制到图片管家 workspace： [YUP-446](mention://issue/7a0ac917-5bfd-4eb3-9788-d8666332bb3e)

| 项 | 值 |
|----|-----|
| Workspace | 图片管家 |
| 标题 | 配置自托管 GitLab VCS 集成 |
| 状态 | todo |
| Project | 图管主站 |

需要在图片管家 workspace 下做的配置步骤和峰照网络一样：
1. 设置 → 集成 → Git 代码托管 → 连接 GitLab（`https://gitlab.s.upyun.com`）
2. 注册 webhook 到 impress 仓库或其他需要关联 issue 的仓库
3. 注意 webhook URL 使用 `multica-webhook.aicake.com` 而不是 `multica.aicake.com`
