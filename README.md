# ffvideo-plugins

Turn topics into local video drafts with narration, captions and agent feedback.

## 从源码运行

Node.js 22 或更高版本：

```sh
git clone https://github.com/425776024/ffvideo-plugins.git
cd ffvideo-plugins
npm install
npm run build
node ffvideo/dist/bin/ffvideo.mjs --open
```

[完整使用说明](ffvideo/README.md) · [宿主插件](ffvideo/plugins/README.md) · [MIT 许可证](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)

`ffvideo/` 保存产品源码、插件、技能和测试。`packages/`、`src/`、`scripts/` 与 `native/` 保存从 [ffclip-plugins](https://github.com/425776024/ffclip-plugins) 复用的共享引擎及构建支持，保持既有相对导入，使本仓库可独立构建。文本 WASM 同时包含源码、预编译运行时和哈希记录，重编译见 [text-wasm](packages/text-wasm/README.md)。

官网 `ffclip/` 源码、开发者本地数据和旧 Git 历史未包含在本仓库，也不在 MIT 授权范围内。模型权重另行下载并遵循各自许可。
