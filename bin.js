#!/usr/bin/env node

/**
 * cc-cockpit CLI 入口
 *
 * npx cc-cockpit 一条命令启动
 * __dirname 定位静态文件，不依赖 process.cwd()
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 确保在 package 目录中运行（npx 场景）
process.chdir(__dirname);

// 启动 server
await import('./core/server.js');
