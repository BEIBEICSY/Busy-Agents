# Agents 在忙啥

英文名 Busy Agents。它住在 Mac 菜单栏里，看本机各个端Agent现在在忙什么。

直接下载：[Busy-Agents-1.0.1.dmg](https://github.com/BEIBEICSY/Busy-Agents/releases/download/v1.0.1/Busy-Agents-1.0.1.dmg)

<img alt="看看你的 Agent 都在忙些什么" src="poster.jpg" width="720">

双击后把应用拖进「应用程序」。打开的磁盘标题是「Agents 在忙啥」，里面的应用是 Busy Agents。需要 Apple 芯片的 Mac，以及本机的 Node.js 20 或更高版本。用 fnm、nvm、asdf 或 nodenv 安装的也可以，应用会自己找到。

## 安装

1. 双击安装盘。
2. 把应用拖进「应用程序」。
3. 打开后，它出现在菜单栏。

## 使用前

- 需要 Apple 芯片的 Mac。
- 本机需要已安装 Node.js 20 或更高版本。用 fnm、nvm、asdf 或 nodenv 安装的也可以，应用会自己找到。没有 Node 的话，应用在，扫描起不来。

## 打开之后
菜单栏图标会显示正在运行的数量，如果有需要处理的则会出现 2 组数字，如“1!·2”，说明有 1 个任务在等待你的响应了。

点菜单栏图标，落下一块浮窗，标题是「Agents 在忙啥」。上面四组：

- 待你处理：工具在等你批准、回答，或者失败、额度用完后你还没看。已经看过的失败会离开这里。自己按停的显示灰色「已停止」，不来提醒。
- 待查看：做完了，原来的工具里还有未读。
- 进行中：还在跑。安静一会儿也仍然算在跑。
- 今日已结束：今天结束、而且你已经看过的任务。

底部可以查看最近 7 天的全部任务。超过 7 天的不进这块看板。点一条任务，会回到原来的工具。

现在认这些工具：Cursor、Codex、Claude Code、Hermes、WorkBuddy、Trae、TraeWork、WPS 灵犀、WPS Comate。Comate 会分开显示本地和云端。

## 它不做的事

- 不代替你回复、批准或继续那些任务。
- 不读取聊天正文，也不把任务、路径上传到别处。数据留在这台 Mac 上。
- 一条记录看起来不对时，可以在任务上右键「这条数据不对我要反馈」。

## 源码

程序源码用 [MIT 许可证](LICENSE) 公开。可以克隆、修改，也可以发 Pull Request。

```bash
git clone https://github.com/BEIBEICSY/Busy-Agents.git
cd Busy-Agents
npm test
npm run dev
```

本地页面是 http://127.0.0.1:4177 。需要 Node.js 20 或更高版本。

Mac 菜单栏应用用 `npm run build:mac` 构建，需要 Xcode 命令行工具。签名和安装盘脚本在 `scripts/`。

更新记录见 [CHANGELOG.md](CHANGELOG.md)。
