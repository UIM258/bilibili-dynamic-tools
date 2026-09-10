# B站动态工具集 · Bilibili Dynamic Tools

两个运行在 B站用户空间（`space.bilibili.com/<uid>/dynamic`）的用户脚本：

| 脚本 | 说明 |
|---|---|
| [**B站动态分页浏览**](bilibili-dynamic-pager.user.js) | 把无限下拉的动态流改成按页浏览；补上 B 站没有的「按日期直达 / 直达最早」 |
| [**B站动态提取导出器**](bilibili-dynamic-exporter.user.js) | 按日期/类型抓取动态，导出 JSON/CSV/HTML 或 TG 式离线归档 ZIP |

MIT 协议，© 2026 UIM258

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开对应 `.user.js` 的 Raw 地址安装，或 GreasyFork 一键安装：
   - 分页浏览：https://greasyfork.org/zh-CN/scripts/595144
   - 提取导出：https://greasyfork.org/zh-CN/scripts/595147
3. **登录 B 站**后打开目标空间：`https://space.bilibili.com/<用户ID>/dynamic`
4. 右下角粉色「动态分页」/ 左下角蓝色「导出动态」

## 脚本一：动态分页浏览

- 本地分页：上一页 / 下一页（末页自动续载）/ 跳页
- 考古直达：按日期直达 + 直达最早 + 停止加载
- 全格式：图文/收藏、视频/小视频、专栏、纯文字、转发（内嵌原博媒体）、直播/卡片、附加卡片
- 富文本表情（含收藏集/装扮表情）、作者装扮徽章
- 图片灯箱预览；动态直达（每条）/ 动态 ID 直达
- 跟随系统 / 日间 / 夜间

## 脚本二：动态提取导出器

- 日期范围 + 内容类型筛选（图文/收藏、视频/小视频、转发、纯文字、专栏、直播/卡片）
- 导出 HTML / JSON / CSV；ZIP 为 TG 式结构：
  - `messages.html`（可分卷，卷间导航）+ `messages.json` / `messages.csv`
  - `photos/` 图片、`media/covers/` 封面、`media/avatar` 头像、`emoticons/` 表情
  - `video_files/` 视频与音频（DASH `.m4s`）+ `合并视频.bat`（需 ffmpeg）
  - `media_links.txt` 抓取失败兜底
- 内容提取：正文/表情/图片、视频（BV/标题/封面/时长）、专栏、直播、卡片、转发原博
- **投票**（选项与票数）、**抽奖**（奖品/开奖时间/参与人数），并完整保留原始结构于 JSON
- 进度 / 暂停 / 继续 / 停止；限速与失败重试

### 视频合并（ffmpeg）

B站视频是 DASH 分离流，ZIP 内含 `合并视频.bat`：安装 ffmpeg（`winget install Gyan.FFmpeg`）后双击即可把 `video_files/*_video.m4s` + `_audio.m4s` 合并为 `<BV号>.mp4`。

## 说明 / 限制

- 需要已登录 B 站（部分账号未登录接口返回空）
- 动态很多时，日期直达/最早/全量导出需较长时间，请保持间隔、可随时暂停
- 视频/音频文件体积大，导出时按需勾选

## License

MIT © 2026 UIM258