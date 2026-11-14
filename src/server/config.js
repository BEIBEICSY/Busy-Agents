import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const defaultConfigPath = path.join(projectRoot, 'config/tools.json');

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

export function normalizeToolConfig(rawConfig) {
  const tools = Array.isArray(rawConfig?.tools) ? rawConfig.tools : [];

  return {
    tools: tools
      .map((tool) => ({
        id: String(tool.id || tool.name || '').trim(),
        name: String(tool.name || tool.id || '').trim(),
        type: asStringArray(tool.type),
        processNames: asStringArray(tool.processNames),
        commandKeywords: asStringArray(tool.commandKeywords),
        windowTitleKeywords: asStringArray(tool.windowTitleKeywords),
        preferredOpen: String(tool.preferredOpen || 'app')
      }))
      .filter((tool) => tool.id && tool.name),
    terminalApps: asStringArray(rawConfig?.terminalApps),
    sessionLookbackDays: Number(rawConfig?.sessionLookbackDays || 7),
    cursorAgent: {
      enabled: rawConfig?.cursorAgent?.enabled !== false,
      activeWithinHours: Number(rawConfig?.cursorAgent?.activeWithinHours || 168)
    },
    codex: {
      activeWithinHours: Number(rawConfig?.codex?.activeWithinHours || 168)
    },
    productReaders: {
      workBuddy: rawConfig?.productReaders?.workBuddy !== false,
      traeIde: rawConfig?.productReaders?.traeIde !== false,
      traeWork: rawConfig?.productReaders?.traeWork !== false,
      wpsLingxi: rawConfig?.productReaders?.wpsLingxi !== false,
      wpsComate: rawConfig?.productReaders?.wpsComate !== false
    }
  };
}

export function loadToolConfig(configPath = defaultConfigPath) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return normalizeToolConfig(raw);
}
