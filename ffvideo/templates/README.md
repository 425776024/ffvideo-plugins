# 场景模板

内置 20 个模板：科普、观点口播、微教学、游戏复盘、户外准备、旅行日记、美食观察、物品演示、历史物件、读书笔记、创作过程、技术图解、语言跟读、人物访谈、误区辨析、方案对比、手作步骤、活动回顾、自然观察和小数据图解。每个模板都有中文用途、填写字段、3–5 幕结构与可直接制作的完整示例。

`catalog.json` 是共享原件，由静态 JSON import 打入服务包。复制或填写模板得到独立 Recipe；修改副本不会改动原件、其他副本或已有作品。自定义主题时不沿用示例事实，缺少必填字段会返回 `recipe: null` 和 `missingFields`。用户确实填写的内容才进入新稿。

已安装的 AI 宿主使用以下 MCP 接口，无需导入源码：

| 接口 | 结果 |
| --- | --- |
| `list_draft_templates({})` | `templates` 列表：用途、字段、结构与风格 |
| `get_draft_template({templateId})` | 完整模板，包含 `example:{topic,values,recipe}` |
| `instantiate_draft_template({templateId})` | 独立的完整示例 Recipe；不会创建作品 |
| `instantiate_draft_template({templateId,topic,values,overrides?})` | 填写后的 Recipe，或者 `recipe:null` 和 `missingFields` |
| `create_template_draft({templateId,topic?,values?,overrides?})` | 创建一条新草稿并返回 `jobId/feedId/previewUrl`，等待真实配音完成 |
| `reuse_draft({workId,topic?,overrides?})` | 复制已有草稿并局部改写，原作品和评论保留 |

例如，先读取 `micro-lesson`，然后用 `instantiate_draft_template({templateId:"micro-lesson",overrides:{scenes:[{index:2,heading:"改这一幕",body:"自己改写的这一段旁白。"}]}})` 预览示例的局部副本。确认内容符合用户请求后，可把同一参数传给 `create_template_draft` 制作独立草稿。自己的主题应按照 `fields` 填写全部必填值；主题最多 80 字符，其余上限由每个字段的 `maxLength` 指定。创建任务不等于可播放成品，须通过 `get_feed_state` 或 `get_work` 确认 `ready` 和旁白资源。

局部修改支持分镜的 `heading/body/visualPrompt/visualQuery/seconds/accent`，以及根层的 `title/narration/tags/language/visualTheme/visualStyle`。分镜索引从 0 开始；不能越界、重复或加入未声明字段。改 `body` 时自动按各幕重建旁白，显式提供 `narration` 则优先保留。所有可制作结果均经过现有 `validateRecipe` 校验。

`pickTemplate(topic)` 根据主题关键词推荐场景；`templateGenerationGuide(templateOrId, {topic,angle,language,values})` 给模型提供结构和内容约束。模型应为新主题填写真正相关的事实与镜头，不复制示例中的人物、地点或数字。口播可用旁白和相关画面，也可替换为授权真人片段；游戏实录需用户提供，缺素材时只使用明确的示意图。

版式建议使用现有 `cinema/magazine/collage/explain/diary` 五种布局。`mediaKinds` 表示模板适合的素材方式；四项 `mediaPreset` 指向内置受控示例：

| 模板 / 分镜索引 | 本地素材 | 适配边界 |
| --- | --- | --- |
| `micro-lesson` / 2 | `media/process.svg` | 已检入的 SVG 步骤图，转为确定时间的图形 HTML |
| `book-note` / 1 | `media/reading.md` | 标题、列表、段落转原生文字与 PNG 背景，不执行 HTML |
| `tech-concept` / 2 | `media/flow.json` | 固定 Canvas 流程，`window.tick(seconds)` 驱动 |
| `creative-process` / 1 | `media/shape.lottie.json` | 2D shape、椭圆/矩形/静态贝塞尔路径、纯色填充及数值变换 linear/hold 关键帧 |

SVG、Canvas 和 Lottie 使用共享 Chromium 图形帧适配器预览和导出，需要本机 Chrome/Chromium。Lottie 不支持外部图片/assets、expressions、groups、mask/effect/stroke/text/3D/easing 或动态路径。以上都是固定内置预设，不表示支持任意外部 SVG、脚本、Markdown 或 Lottie 文件导入。其余分镜仍可用授权照片、PNG 或用户视频。

发行包包含 `templates/`；独立插件根也包含本说明、完整目录和素材。服务的目录 JSON 静态打入 bundle，图形文件额外放在 `dist/templates/media/`，插件运行时对应 `runtime/dist/templates/media/`。复制插件根不需要源仓库或外链即可读取这些预设。

作品配音默认 `voiceMode:"random"`，在当前语言已安装的音色中轮换，保留固定音色选择。音色随作品持久化；本机验证过中文 10 个、英文 18 个系统声音，其他设备库存可能不同。仅一个音色时，语速变化属于表达变化。模板实例化本身不合成声音，实际声音与视频导出需另外验收。
