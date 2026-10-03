# ffvideo usage

## Watch the examples

The install command opens the built-in gallery. Press Play, switch works, read details, leave comments, or export. The bundled narration is already included.

## Connect your assistant

The copyable installation prompt asks your assistant to detect its supported local MCP configuration. Use command `ffvideo` with arguments `--mcp --port 0`. Preserve other configured servers. Restart the connection if required, then call `open_feed` to open the gallery.

Ask: "Make five different short videos about space." New creation needs a connected assistant or a separately configured generation provider. The first ready work appears while the rest are being prepared.

## Install a plugin bundle from source

```sh
git clone https://github.com/425776024/ffvideo-plugins.git
cd ffvideo-plugins
npm install
npm run build
node ffvideo/dist/bin/ffvideo.mjs --provider agent --open
```

Generated plugin roots are `ffvideo/dist/plugins/codex/` and `ffvideo/dist/plugins/claude/`. Install the generated bundle appropriate to your host, rather than the source manifest. Each bundle includes its runtime, skill, player and examples.

## Save and export

Works persist in `~/.ffvideo`. Use `--data-dir /absolute/path` for a separate library. Export from the work controls and keep the player open until complete. Downloaded media keeps its source and license credits.

## Optional speech

New narration uses macOS system voices or separately installed browser speech models. Watching the built-in examples needs neither a generation account nor model downloads. Optional background generation uses your configured provider and may consume its account quota.
