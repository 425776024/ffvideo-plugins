# ffvideo

[英文](README.md) · [官网](https://ffclip.com)

告诉 AI 助手一个话题，观看有配音、字幕的作品，评论并导出。

<img src="ffvideo/assets/docs/ffvideo-demo.jpg" alt="插件实际运行：内置有声作品展示页面" width="390">

- 让 AI 助手把话题做成有配音、字幕的视频草稿。
- 在作品展示页直接观看、切换和评论。
- 复用模板、修改作品并导出视频。

## 复制给 AI 助手，安装后直接体验

```text
帮我安装 https://github.com/425776024/ffvideo-plugins 的 ffvideo，接入当前助手，保留已有配置，并在浏览器打开内置作品展示页面。需要 Node.js 22 或更新版本。如果新工具需要重启才能连接，先用命令行打开页面让我体验。先展示自带作品，不要立即生成新作品。
```

## 或复制这一行到终端

```sh
npm install -g @ffclip-com/ffvideo@latest && ffvideo --provider agent --open
```

需要 Node.js 22+ 和 Chrome 或 Edge。页面自带五条有声作品，无需下载模型即可观看。连接助手后，可以说：“做五个关于太空的短视频。”

[使用说明](ffvideo/docs/usage-zh.md) · [MIT 许可证](LICENSE)
