import { loadToolConfig } from './config.js';
import { createHttpServer } from './httpServer.js';
import { defaultTerminalSessionLogPath } from './terminalSessionLog.js';

const config = loadToolConfig();
const port = Number(process.env.PORT || 4177);
const server = createHttpServer(config, {
  terminalSessionLogPath: process.env.TERMINAL_SESSION_LOG || defaultTerminalSessionLogPath()
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AI 工具会话看板已启动：http://127.0.0.1:${port}`);
});
