import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import chokidar from 'chokidar';

/**
 * JSONL 增量尾读器
 */
export class Tailer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.projectsDir = options.projectsDir || path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');
    this.usePolling = options.usePolling !== undefined ? options.usePolling : true;
    this.pollingInterval = options.pollingInterval || 300;
    this.fileState = new Map(); // { offset, partialLine }
    this.watcher = null;
    this.sessionFiles = new Map();
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    if (!fs.existsSync(this.projectsDir)) {
      console.warn(`[tailer] projects 目录不存在: ${this.projectsDir}`);
      this.emit('ready', { sessions: [] });
      return;
    }

    // 扫描已有文件
    const files = this._scanJsonlFiles();
    console.log(`[tailer] 发现 ${files.length} 个 JSONL 文件`);
    for (const fp of files) {
      this.fileState.set(fp, { offset: 0, partialLine: '' });
      this._readIncremental(fp);
    }

    // chokidar 监听
    const watchPattern = path.join(this.projectsDir, '**', '*.jsonl');
    this.watcher = chokidar.watch(watchPattern, {
      persistent: true,
      ignoreInitial: true,
      usePolling: this.usePolling,
      interval: this.pollingInterval,
      awaitWriteFinish: false
    });

    this.watcher.on('change', (fp) => this._readIncremental(fp));
    this.watcher.on('add', (fp) => {
      if (!this.fileState.has(fp)) {
        this.fileState.set(fp, { offset: 0, partialLine: '' });
      }
      this._readIncremental(fp);
    });

    this.emit('ready', { sessions: Array.from(this.sessionFiles.keys()) });
  }

  async stop() {
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
    this._started = false;
    this.fileState.clear();
    this.sessionFiles.clear();
  }

  /**
   * 手动触发增量读取（测试用，或 chokidar 不可靠时的降级）
   */
  poke(filePath) {
    if (!this.fileState.has(filePath)) {
      this.fileState.set(filePath, { offset: 0, partialLine: '' });
    }
    this._readIncremental(filePath);
  }

  /**
   * 扫描所有 .jsonl 文件
   */
  _scanJsonlFiles() {
    const results = [];
    const walk = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.jsonl')) {
            results.push({ path: full, mtime: fs.statSync(full).mtimeMs });
          }
        }
      } catch {}
    };
    walk(this.projectsDir);
    results.sort((a, b) => b.mtime - a.mtime);
    return results.map(r => r.path);
  }

  /**
   * 增量读取
   */
  _readIncremental(filePath) {
    let state = this.fileState.get(filePath);
    if (!state) {
      state = { offset: 0, partialLine: '' };
      this.fileState.set(filePath, state);
    }

    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (stat.size <= state.offset) return;

    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - state.offset);
      fs.readSync(fd, buf, 0, buf.length, state.offset);
      fs.closeSync(fd);

      const text = state.partialLine + buf.toString('utf-8');
      const lines = text.split('\n');
      state.partialLine = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) this._processLine(filePath, line);
      }
      state.offset = stat.size;
    } catch (err) {
      console.warn(`[tailer] 读取失败: ${filePath}`, err.message);
    }
  }

  _processLine(filePath, line) {
    try {
      const data = JSON.parse(line);
      const sessionId = data.sessionId || path.basename(filePath, '.jsonl');
      if (!this.sessionFiles.has(sessionId)) {
        this.sessionFiles.set(sessionId, filePath);
        this.emit('session:discovered', { sessionId, filePath });
      }
      this.emit('message', {
        sessionId, filePath, data,
        timestamp: data.timestamp || new Date().toISOString()
      });
    } catch (err) {
      console.warn(`[tailer] JSON 解析失败，跳过: ${filePath}`, err.message);
    }
  }

  getSessions() {
    return Array.from(this.sessionFiles.entries()).map(([sessionId, filePath]) => ({ sessionId, filePath }));
  }
}
