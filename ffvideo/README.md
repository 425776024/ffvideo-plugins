# @ffclip-com/ffvideo

源码：[ffvideo-plugins](https://github.com/425776024/ffvideo-plugins)，采用 [MIT](LICENSE) 许可证。官网 `ffclip/` 不在开源范围内。

ffvideo 把一个感兴趣的话题变成有声音的竖屏草稿，用户只需要观看、评论和导出。它是独立入口，直接复用当前项目的 VideoCut 项目格式、渲染器、音频时钟、配音与导出实现；不复制编辑器，也不挂载时间轴、画布选择或拖拽控件。

0.2.0 增加 20 个可填写和复制的场景模板、分镜局部改写、已有草稿复用，以及按作品轮换的随机配音。

画面默认优先使用相关的真实视频片段：从 Wikimedia Commons 检索有来源与可复用许可的素材，下载到本机后播放。视频使用有体积限制的实际视频源或转码版本，不能用缩略图冒充动态镜头；主题词必须匹配素材标题，避免仅命中机构或分类文字。没有合适视频时回退到主题照片，再回退到说明插画。设置中可选择真实图片优先或插画与动画。最多两个下载同时进行，整体等待上限 15 秒；下载素材在 `media-cache` 缓存，后续副本可复用。保留作者、来源与许可，导出附带来源文件。

macOS 配音在本机合成，中文随机轮换已安装的婷婷和美佳，采用适中的语速并统一响度；其他风格音色仍可固定选择，不调用联网配音。素材与配音并行准备，当前作品合成时可开始下一条脚本，最多积压两条待合成作品。默认自动安排20–60秒的完整内容，按角度和模板调整建议时长，不再将每条都限定为25秒；最后时长由实际旁白决定，也可在偏好中选择指定目标时长。后台 Codex 默认使用账户公布的模型，偏好可指定制作模型与思考强度；普通对话设置保持独立。历史文案与配音不改写，缺失的完整字幕会在后台补上。

## 文字编排与独立制作

话题决定内容与取材，一轮构思同时生成旁白、镜头和原创文字编排。新作品的 `design.typography` 支持同一行混合字号、字体、颜色、空心字、下划线和局部色块，以及逐行错时入场、字距、行距和对齐；文字关系由内容决定，没有固定标题卡。`captionKeywords` 只强调真实旁白中的重点短语，完整字幕始终保留。

本机 Chrome/Chromium 按安装字体一次测量、排版为透明 PNG，随后用原生时间轴播放和导出；没有调用生成式图片服务，也没有逐帧 HTML 文字渲染或额外模型审片。过密、超出安全区的文字会明确失败，不截掉内容。字幕时间按文本长度分配，尚未实现精确逐字语音对齐。

本地素材库存只在相关时帮助减少重复下载，不要求用户的随机话题迁就库存。素材以内容哈希去重，支持跨作品、同义查询离线复用；缺失具体主体时按话题联网检索。草稿文件与共享原件独立，支持的文件系统采用写时复制。不会额外调用模型翻做全部旧作品。

MCP `list_reusable_materials({topic?,limit?})` 让不同宿主读取同一库存。已有完成作品的素材在启动时离线导入。复用对象是原始素材和底层制作能力；成片镜头关系、说明方式及节奏必须重新创作。换色、换文字、换素材或挪动几像素无法绕过结构重复检查。完整设计见 [制作系统](design/PRODUCTION_SYSTEM.md)。

这保证缓存复用和结构底线，不等于每条成片都达到艺术质量；实际素材质量、语义对应和镜头表达仍需验收。

## 在当前项目运行

使用父项目已经安装的依赖，Node.js 22 或更高版本：

```sh
npm --prefix ffvideo run build
node ffvideo/dist/bin/ffvideo.mjs --open
```

默认打开 `http://127.0.0.1:4320`，数据保存到 `~/.ffvideo`。可用 `--data-dir /absolute/path` 指定独立作品库，`--port 0` 使用空闲端口。开发模式运行 `npm --prefix ffvideo run dev`；只修改 ffvideo，不修改现有 VideoCut 产品入口。

第一次打开显示已有话题和历史作品。顶部输入话题后制作五个不同角度的作品；每完成一条画面和配音就立即发布，不等待整批。页面只有话题和历史两个 tab，不提供独立推荐页。默认界面为居中的窄竖屏观看页。浏览器首次播放可能需要点击播放以允许声音。

视频下方有独立控制区，标题、播放控件和进度条不遮挡画面。进度条支持点击、鼠标拖动和触摸拖动，跳转后保留原先的播放或暂停状态。进度条获得焦点时，可用方向键调整时间，Home / End 跳到开头或结尾；焦点不在输入框或按钮时，空格播放或暂停，上下方向键切换作品，Esc 返回评论前的列表位置。拖动和跳过的时间不会计入有效观看。

叠化转场会预留视频素材的前后余量，包括从第0秒开始的镜头和短视频循环。转场按实际素材余量与相邻片段长度缩短，极短片段采用直接切换；完整旁白、字幕和作品总时长保持不变。

导出完成后，“下载 MP4 / WebM”使用独立下载地址并返回附件响应头，支持中文文件名，释放播放会话或重启服务后仍可下载已保存的视频。macOS 本地页面也提供“打开文件夹”，可直接在 Finder 找到导出的原文件；内嵌浏览器不处理下载时可使用该入口。

话题只显示当前选中话题的作品；历史显示全部作品，按生成时间倒序排列。选择话题会同步后台任务目标和页面 URL，即使该话题还没有成品也能开始制作。普通状态更新和新作品追加保持当前播放位置；重复版本通知不会重启配音。

## 填写、复制和改写模板

内置 20 个场景模板覆盖科普、口播、教学、游戏复盘、户外、旅行、美食、演示、历史、读书、创作、技术、语言练习、采访、误区、对比、手作、活动、自然和数据图解。每个都有中文用途、填写字段、3–5 幕结构和完整示例。模板库说明与原始字段见 [templates/README.md](templates/README.md)。

AI 宿主可以使用这些 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `list_draft_templates({})` | 查看 20 个模板的用途、字段和分镜结构 |
| `get_draft_template({templateId})` | 读取完整模板、`example.values` 和可复制示例 |
| `instantiate_draft_template({templateId, topic?, values?, overrides?})` | 预览填写或局部改写后的 Recipe，不创建作品 |
| `create_template_draft({templateId, topic?, values?, overrides?})` | 创建参考稿任务，AI重新设计镜头后制作有声作品 |
| `reuse_draft({workId, topic?, overrides?})` | 复制已有作品作为参考，局部改写并重新设计镜头 |
| `create_topic_feed({topic, templateId?})` | 以模板为初始参考，交给模型独立创作首批五条内容与镜头设计 |

不传 `topic` 或 `values` 表示复制完整示例；输入自己的主题后必须提供模板声明的必填字段，缺项返回 `recipe:null` 与 `missingFields`，不会套用示例的事实。模板的主题字段最多 80 字符，其余字段上限由 `fields[].maxLength` 给出。`overrides.scenes` 使用从 0 开始的现有分镜索引，可改 `heading/body/visualPrompt/visualQuery/seconds/accent`。改 `body` 会重建完整旁白；显式传 `overrides.narration` 则采用该旁白。复制和局部修改总是创建独立副本，保留原件、原作品及其评论。创建回执只证明任务已提交；应等待 `get_feed_state` / `get_work` 的 `ready` 与实际声音，再播放或导出。

初始化示例保留四个离线图形参考素材（新作品不会按这些预设直接制作）：微教学使用 SVG 步骤图、读书笔记使用 Markdown 排版、技术图解使用 Canvas 流程动画、创作过程使用 Lottie 几何动画。它们是已检入的固定素材，SVG/Canvas/Lottie 通过确定时间的图形容器预览和导出，需要本机 Chrome/Chromium；Markdown 转成原生文字和 PNG 背景。Lottie 仅适配 2D shape、椭圆/矩形/静态贝塞尔路径、纯色填充，以及数值变换的 linear/hold 关键帧。这些预设不提供任意外部 SVG、脚本、Markdown 或 Lottie 文件的通用导入能力；其他分镜仍使用已授权图片或主题插画。

## 持续制作

普通网页启动默认使用 Codex 后台制作，避免任务无人领取；需要本机已安装并登录 Codex。`--mcp` 启动默认使用 `agent`，由连接的 AI 宿主认领任务并提交完整旁白和场景。保存的制作模式和显式 `--provider` 参数优先，手动助手模式不会偷偷切换后台账户。普通 MCP 工具不会在对话结束后唤醒宿主。可显式启用独立的后台生成器：

```sh
node ffvideo/dist/bin/ffvideo.mjs --provider codex --open
```

这一模式需要本机已安装并登录 Codex，使用独立的 `codex app-server --stdio` 连接，消耗模型额度。制作方式缓存于本地；显式 CLI 参数优先。新话题先制作五条，首条完成即显示。话题页按真实播放位置准备后面至少三条，仅制作该话题的新角度。历史页不触发补充。关闭“话题自动补充”后，显式输入的话题仍可完成首批五条，也可点击“继续生成”。初次打开、观看时长、评论不会生成其他主题或个性化推荐。

偏好中的“视频制作模型”只控制后台出稿，模型名称原样保存，下一条脚本生效，不会静默替换为其它模型。思考强度可选“关闭”（请求 `none`，需接入通道支持）、“最低”（选模型公布的最低强度）和“标准”（模型默认）。后台线程关闭无关工具和插件，直接生成一份完整脚本与设计。页面显示实际脚本输出字数；90秒没有返回内容或超过240秒上限会停止并显示原因，可重连重试，避免无限显示“已完成0条”。

模型支持还取决于启动的 Codex 版本。2026-10-03 在本机验证：PATH 中的 0.153.4 对 `gpt-6-luna` 返回不支持；ChatGPT 桌面内置 0.159.2 能实际调用 `gpt-6-luna` 和 `gpt-5.6-luna`，且 `gpt-6-luna` 的 `none` 请求成功。此结果不代表所有账户或宿主都可用。可用 `--codex-command /absolute/path/to/codex --model gpt-6-luna` 明确选择新版运行程序；CLI 路径需要在启动时指定，作品库内保存的模型偏好优先于 `--model` 默认值。

其他模型或本地代理可以通过显式命令适配器接入：

```sh
node ffvideo/dist/bin/ffvideo.mjs --provider command --generator-command-config /absolute/path/generator.json
```

配置为 `{"command":"/absolute/path/to/program","args":[]}`。程序从标准输入读取一行 `{prompt,schema,job,preferences}`，标准输出只返回一份符合 schema 的作品 JSON。服务直接启动指定程序，不通过 shell；模型账户和 SDK 由该程序自己配置。未配置的宿主不会被自动启动。

配音默认按作品随机轮换，只从当前语言已安装且可用的音色中选择，尽量避免相邻重复，并在音色库存允许时轮换男声与女声。分配结果随作品保存，重启和重建保留同一音色；偏好中仍可选择固定音色，MCP 对应 `set_preferences({preferences:{voiceMode:"random"}})` 或 `voiceMode:"fixed"` 加已安装的 `voice` ID。macOS 使用系统配音，当前验收机器有 10 个中文、18 个英文音色能产生非静音 PCM，但默认中文随机池只使用 Tingting 和 Meijia 两种自然旁白，避免角色音色影响清晰度；其他设备的库存可能不同。并行任务在配音前顺序预留音色，避免未发布作品重复领取同一声音。语速变化属于表达变化，不冒充另一种音色；只有一个可用音色时会明确说明。

其他平台默认使用共享 Kokoro 浏览器配音，可用 `--speech browser` 切换；首次使用需在偏好中主动安装模型和音色，并保持观看页打开，模型不会自动下载。随机选择也仅使用已安装的音色。新作品按视觉开场、远近景变化、动作或细节展示和收尾组织三至五个镜头。实拍优先时使用全幅画面，保留视频本身的运动；照片备用镜头采用轻微运镜与短叠化，不堆整段文字。使用 [MediaWiki Videoinfo API](https://www.mediawiki.org/wiki/Extension:TimedMediaHandler/API) 与 [Imageinfo API](https://www.mediawiki.org/wiki/API:Imageinfo)，下载可复用的视频或 JPEG、PNG、WebP，不让模型虚构素材地址。当前是实拍素材剪辑，尚未提供任意剧情的生成式真人镜头或数字人。

模板保留全幅电影镜头、留白杂志、错位照片拼贴、清晰科普图示和复古旅行日记五种版式。带声音的作品从完整旁白生成短句字幕，而不是只显示每幕摘要；开场标题不再占用第一句旁白的字幕时间，图文预设也保留独立的旁白字幕。每次显示一条1–2行字幕，覆盖完整音轨；时间按文本与实际音轨长度估算，尚非逐字强制对齐。完整旁白和画面来源可在评论详情查看。

旧文字草稿在后台逐条补充画面，保留旁白、评论和观看记录，原项目保存在 `original-project.json`。详情可查看素材来源；导出带素材署名，另保存同名 `.credits.txt`。服务重启时浏览器会更新连接令牌并重取当前作品，保留播放时间，避免旧连接导致图片 401。

## 宿主连接与实时反馈

```sh
node ffvideo/dist/bin/ffvideo.mjs --print-host-config codex
node ffvideo/dist/bin/ffvideo.mjs --print-host-config claude
node ffvideo/dist/bin/ffvideo.mjs --print-host-config codebuddy
node ffvideo/dist/bin/ffvideo.mjs --print-host-config workbuddy
node ffvideo/dist/bin/ffvideo.mjs --print-host-config qoder
```

这些命令打印当前本地构建的可用配置，不修改宿主设置。安装包发布后可使用 `npx -y @ffclip-com/ffvideo --mcp`。`dist/plugins/codex` 和 `dist/plugins/claude` 是包含运行时与技能的插件根；其余宿主使用同一 MCP 工具和 video-feed 技能，具体配置见 [hosts/README.md](hosts/README.md)。同一个作品库只允许一个服务进程，可复用正在运行服务的 HTTP `/mcp` 端点；独立 stdio 服务请指定不同数据目录。

| 宿主 | 普通接入 | 实时反馈的实现边界 |
| --- | --- | --- |
| Codex | stdio / HTTP MCP、插件 | 可选显式 app-server 事件桥；普通 MCP 本身不唤醒空闲聊天 |
| ChatGPT | 可达的 HTTPS MCP 或已经配置的 Secure MCP Tunnel | 工具调用可读反馈；本地端口不会自动对云端可达 |
| Claude Code | stdio / HTTP MCP、插件 | 显式启用 Native Channels 后可以发送事件；需要宿主允许该通道 |
| CodeBuddy Code | stdio / HTTP MCP | 显式启用 Native Channels；不等同于 WorkBuddy 桌面唤醒能力 |
| WorkBuddy | stdio / streamableHttp 配置 | 活跃回合长轮询，或独立后台生成器 |
| Qoder | stdio / HTTP MCP 配置 | 活跃回合长轮询，或独立后台生成器 |

Claude / CodeBuddy 通道启动参数为 `--mcp --channels --host claude` 或 `--mcp --channels --host codebuddy`，还需按宿主文档明确加载通道。通知会合并，不把每个播放心跳或原始评论正文灌入对话；宿主重新读取当前状态来制作。通道写成功不代表模型已经接收或处理。

Codex 可选事件桥仅连接用户明确提供的本机 app-server WebSocket 和目标线程：

```sh
node ffvideo/dist/bin/ffvideo.mjs --codex-bridge-url ws://127.0.0.1:4500 --thread-id TARGET_THREAD_ID
```

桥使用 `turn/start.toolOutput` 递交合并后的反馈，兼容支持该协议的 app-server 将其排入当前回合。并非通过屏幕监控、定时向用户发消息或中断对话来实现。桌面应用没有公开并启用这个连接时，不能声称已接通当前聊天；该桥和后台生成器是两种独立能力。

远程 HTTP 监听需要设置专用 `FFVIDEO_MCP_TOKEN`，例如 `--listen-host 0.0.0.0`。MCP 在 `/mcp`，非本地请求需要 bearer token；配置 `--public-url` 后，所有请求都要求认证，包括反向代理改写 Host 后的本地请求。观看页可使用首次 `/?token=...` 建立 HttpOnly 会话，资源仍使用独立的引擎令牌。`--open` 在公开模式下打开经过认证的公开观看地址。HTTPS、隧道、云端认证与观看页的可达性需要单独部署；本项目不创建这些基础设施，也不宣称实现了 ChatGPT 内嵌 MCP App 或 MCP 2 事件订阅。

## 每条作品独立设计

模板只提供初始化参考，不再直接填充模板后发布。生成器必须返回原创 `recipe.design`：具体镜头顺序、切镜时机、画面起止位置与尺寸、临时文字和图形标注、字幕字体配色及动画。原生渲染器执行这份设计，预览和 MP4 共用项目。多分镜作品至少使用两幕素材；片内不能全程复用同一个卡片布局；同话题只换文字、素材但镜头布局与标注时间完全一致的结果会被拒绝。

标题可以短暂出现，也可以融入镜头，不再强制贯穿标题栏。文字、矩形、椭圆是可组合的原生元素，不是预设布局。画面与字幕保留独立安全区域。当前支持镜头裁切运镜、切镜/叠化、局部标注、原生图形和文字淡入/上浮/侧滑/缩放；不是任意脚本执行或任意生成式真人视频。

复制模板、复制已有作品若未提交新的设计，会先排入 AI 设计任务，保留参考稿文案；连接的模型或宿主 Agent 完成设计后才制作声音和发布。历史与内置参考作品继续播放原项目，文字编排改造用于新创作，不会自动用模型改写原作品。

## 话题补充和本地数据

作品追加由当前话题和播放位置驱动。每条完成后通过 SSE 直接更新列表，轮询只作为断线兜底。评论保存为作品评论，不参与兴趣权重计算或跨话题推荐。已有作品和评论保留；旧的混合推荐待办在启动时取消。

`feed-state.json` 原子持久化偏好、评论、任务租约与事件游标。作品在 `works/`，导出文件在 `exports/`。清空历史删除草稿、评论和旧脚本，保留偏好与已导出视频，清空后不自动生成无主题任务。导出进度及结果在可关闭对话框中显示，关闭不取消渲染。

## 验证和打包

```sh
npm --prefix ffvideo test
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p ffvideo/tsconfig.json
npm --prefix ffvideo run build
node ffvideo/scripts/check-package.mjs
npm --prefix ffvideo pack
```

测试覆盖话题补充、租约、去重、有效观看区间、清空和重启、协议取消/并发、宿主配置、模板副本隔离与局部改写、随机音色选择及独立插件运行时。打包检查把 Codex 和 Claude 插件分别复制到临时目录，检查 MCP 工具发现、全部 20 个模板的读取/复制/填写，以及四项图形资源的本地文件，随后检查播放器和实际样例声音；不写入宿主安装配置。跨宿主配置与协议测试不等于每个桌面产品中的实时事件送达验收。实际观看、配音、导出结果另行验证，不用静态构建结果代替。
