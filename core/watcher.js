import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import chokidar from 'chokidar';

/**
 * 文件改动监听 + diff
 *
 * 数据来源：
 * 1. tool call 中的 Write/Edit/MultiEdit → file_path
 * 2. chokidar 监听 cwd 目录的实际文件变动
 *
 * 对抗性设计：
 * - CRLF 归一化：diff 前 \r\n → \n
 * - 二进制/超大文件(>2MB)：跳过 diff，只标记"已变更"
 * - 文件删除/重命名：独立状态卡片
 * - 非 git 仓库：内存快照 diff
 */

const MAX_DIFF_SIZE = 2 * 1024 * 1024; // 2MB
const SNAPSHOT_LRU_MAX = 50; // 最多缓存 50 个文件快照

export class FileWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.projectsDir = options.projectsDir;
    this.usePolling = options.usePolling || true;
    this.pollingInterval = options.pollingInterval || 500;

    // { filePath: { status, oldContent, toolCall, timestamp } }
    this.trackedFiles = new Map();

    // { cwd: chokidar watcher }
    this.dirWatchers = new Map();

    // { filePath: content } — 非 git 仓库的快照
    this.snapshotCache = new Map();
    this.snapshotOrder = []; // LRU 淘汰用

    // 从 tool call 捕获的文件路径
    this.pendingToolFiles = new Map(); // { filePath: { toolName, input, timestamp } }
  }

  /**
   * 注册 tool call 产生的文件操作
   */
  registerToolCall(toolName, input, sessionId) {
    const filePath = input?.file_path || input?.path;
    if (!filePath) return;

    // 只跟踪写入类操作
    if (!['Write', 'Edit', 'MultiEdit', 'create', 'update'].includes(toolName)) return;

    const normalized = path.normalize(filePath);
    this.pendingToolFiles.set(normalized, {
      toolName,
      input,
      sessionId,
      timestamp: new Date()
    });

    // 标记为 tool call 直接写入
    this._updateFileStatus(normalized, 'tool-written', { toolName, sessionId });
  }

  /**
   * 开始监听 cwd 目录
   */
  watchDirectory(cwd) {
    if (!cwd || this.dirWatchers.has(cwd)) return;
    if (!fs.existsSync(cwd)) return;

    try {
      const watcher = chokidar.watch('.', {
        cwd,
        persistent: false, // 不阻止进程退出
        ignoreInitial: true,
        usePolling: this.usePolling,
        interval: this.pollingInterval,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.*',
          '**/*.log'
        ],
        awaitWriteFinish: false
      });

      watcher.on('change', (relPath) => {
        const absPath = path.join(cwd, relPath);
        this._handleFileChange(absPath, 'modified');
      });

      watcher.on('add', (relPath) => {
        const absPath = path.join(cwd, relPath);
        this._handleFileChange(absPath, 'created');
      });

      watcher.on('unlink', (relPath) => {
        const absPath = path.join(cwd, relPath);
        this._handleFileChange(absPath, 'deleted');
      });

      watcher.on('error', (err) => {
        console.warn(`[watcher] 监听错误 ${cwd}:`, err.message);
      });

      this.dirWatchers.set(cwd, watcher);
    } catch (err) {
      console.warn(`[watcher] 无法监听 ${cwd}:`, err.message);
    }
  }

  /**
   * 处理文件变动
   */
  _handleFileChange(absPath, status) {
    const normalized = path.normalize(absPath);
    const isToolWritten = this.pendingToolFiles.has(normalized);

    // 首次见到的文件，先建立快照（归一化存储）
    if (!this.snapshotCache.has(normalized) && status !== 'deleted') {
      const content = this._readFileNormalized(normalized);
      if (content) this._updateSnapshot(normalized, content);
    }

    this._updateFileStatus(normalized, status, isToolWritten ? this.pendingToolFiles.get(normalized) : null);
    this._generateDiff(normalized, status);

    if (isToolWritten) {
      this.pendingToolFiles.delete(normalized);
    }
  }

  /**
   * 更新文件状态
   */
  _updateFileStatus(filePath, status, toolInfo = null) {
    const existing = this.trackedFiles.get(filePath) || {};
    const entry = {
      ...existing,
      filePath,
      status,
      timestamp: new Date(),
      toolCall: toolInfo || existing.toolCall || null,
      isToolWritten: status === 'tool-written' || existing.isToolWritten || false
    };

    this.trackedFiles.set(filePath, entry);
    this.emit('file:changed', entry);

    // LRU 淘汰
    if (this.trackedFiles.size > SNAPSHOT_LRU_MAX * 2) {
      const oldest = [...this.trackedFiles.entries()]
        .sort((a, b) => new Date(a[1].timestamp) - new Date(b[1].timestamp))
        .slice(0, this.trackedFiles.size - SNAPSHOT_LRU_MAX);
      for (const [key] of oldest) {
        this.trackedFiles.delete(key);
      }
    }
  }

  /**
   * 生成 diff
   */
  _generateDiff(filePath, status) {
    let diff = null;
    let skipped = false;
    let skipReason = '';

    try {
      // 文件删除
      if (status === 'deleted') {
        const oldContent = this.snapshotCache.get(filePath) || '';
        diff = this._generateManualDiff(filePath, oldContent, '');
        this.snapshotCache.delete(filePath);
        this._emitDiff(filePath, diff, false, '');
        return;
      }

      // 检查文件大小
      let stat;
      try { stat = fs.statSync(filePath); } catch { return; }

      if (stat.size > MAX_DIFF_SIZE) {
        skipped = true;
        skipReason = `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB > 2MB)`;
      }

      // 检查是否二进制
      if (!skipped && this._isBinary(filePath)) {
        skipped = true;
        skipReason = '二进制文件';
      }

      if (skipped) {
        this._emitDiff(filePath, null, true, skipReason);
        return;
      }

      // 尝试 git diff
      const gitDiff = this._tryGitDiff(filePath);
      if (gitDiff !== null) {
        diff = gitDiff;
      } else {
        // 手动 diff（非 git 仓库）
        const newContent = this._readFileNormalized(filePath);
        const oldContent = this.snapshotCache.get(filePath) || '';
        diff = this._generateManualDiff(filePath, oldContent, newContent);

        // 更新快照（归一化后存储，避免 CRLF 陷阱）
        this._updateSnapshot(filePath, newContent);
      }

      this._emitDiff(filePath, diff, false, '');
    } catch (err) {
      console.warn(`[watcher] diff 生成失败 ${filePath}:`, err.message);
    }
  }

  /**
   * 尝试 git diff（CRLF 归一化）
   */
  _tryGitDiff(filePath) {
    try {
      // 检查是否在 git 仓库中
      const dir = path.dirname(filePath);
      execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe', timeout: 3000 });

      // git diff（--no-color 避免 ANSI，-w 忽略空白差异）
      // 用 --no-index 对比工作区 vs HEAD
      let diff;
      try {
        diff = execSync(
          `git diff --no-color --ignore-cr-at-eol -- "${filePath}"`,
          { cwd: dir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
      } catch (e) {
        // git diff 返回非 0 表示有差异，stdout 是 diff 内容
        diff = e.stdout || '';
      }

      // 如果是 untracked 文件
      if (!diff || diff.trim() === '') {
        try {
          const status = execSync(
            `git status --porcelain -- "${filePath}"`,
            { cwd: dir, encoding: 'utf-8', timeout: 3000 }
          ).trim();
          if (status.startsWith('??')) {
            // 新文件，显示全部内容
            const content = this._readFileNormalized(filePath);
            return `--- /dev/null\n+++ b/${path.basename(filePath)}\n` +
              content.split('\n').map(l => `+${l}`).join('\n');
          }
        } catch {}
      }

      // CRLF 归一化后对比
      if (diff) {
        diff = diff.replace(/\r\n/g, '\n');
        // 如果 diff 显示整个文件变更（CRLF 陷阱），尝试只取实际变更行
        const lines = diff.split('\n');
        const addedLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
        const removedLines = lines.filter(l => l.startsWith('-') && !l.startsWith('---'));
        // 如果变更行数 > 50 且文件行数 > 100，可能是 CRLF 全量 diff
        if (addedLines.length > 50 && removedLines.length > 50) {
          const fileLines = this._readFileNormalized(filePath).split('\n').length;
          if (Math.abs(addedLines.length - fileLines) < 5) {
            // 全量 diff，回退到手动 diff
            const newContent = this._readFileNormalized(filePath);
            const oldContent = this.snapshotCache.get(filePath) || newContent;
            diff = this._generateManualDiff(filePath, oldContent, newContent);
            this._updateSnapshot(filePath, newContent);
          }
        }
      }

      return diff || null;
    } catch {
      return null; // 不在 git 仓库中
    }
  }

  /**
   * 手动 diff（LCS 算法）
   */
  _generateManualDiff(filePath, oldContent, newContent) {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const changes = [];
    let i = 0, j = 0;

    while (i < oldLines.length || j < newLines.length) {
      if (i >= oldLines.length) {
        changes.push({ type: 'add', line: newLines[j], lineNum: j + 1 });
        j++;
      } else if (j >= newLines.length) {
        changes.push({ type: 'del', line: oldLines[i], lineNum: i + 1 });
        i++;
      } else if (oldLines[i] === newLines[j]) {
        // 上下文行（只显示变更前后各 3 行）
        if (changes.length > 0 || i < oldLines.length - 1) {
          changes.push({ type: 'ctx', line: oldLines[i], oldLine: i + 1, newLine: j + 1 });
        }
        i++; j++;
      } else {
        // 简单向前查找匹配
        let found = false;
        for (let k = j + 1; k < Math.min(j + 5, newLines.length); k++) {
          if (oldLines[i] === newLines[k]) {
            while (j < k) {
              changes.push({ type: 'add', line: newLines[j], lineNum: j + 1 });
              j++;
            }
            found = true;
            break;
          }
        }
        if (!found) {
          changes.push({ type: 'del', line: oldLines[i], lineNum: i + 1 });
          i++;
        }
      }
    }

    // 生成 unified diff 格式
    const basename = path.basename(filePath);
    let diff = `--- a/${basename}\n+++ b/${basename}\n`;
    let hunkStart = -1;
    let hunkLines = [];

    for (const c of changes) {
      if (c.type !== 'ctx') {
        if (hunkStart === -1) hunkStart = c.lineNum || c.oldLine || 1;
        hunkLines.push(c);
      } else if (hunkLines.length > 0) {
        hunkLines.push(c);
        if (hunkLines.length > 10) {
          diff += this._formatHunk(hunkStart, hunkLines);
          hunkStart = -1;
          hunkLines = [];
        }
      }
    }
    if (hunkLines.length > 0) {
      diff += this._formatHunk(hunkStart, hunkLines);
    }

    return diff;
  }

  _formatHunk(start, lines) {
    const adds = lines.filter(l => l.type === 'add').length;
    const dels = lines.filter(l => l.type === 'del').length;
    let hunk = `@@ -${start},${dels + lines.filter(l => l.type === 'ctx').length} +${start},${adds + lines.filter(l => l.type === 'ctx').length} @@\n`;
    for (const l of lines) {
      if (l.type === 'add') hunk += `+${l.line}\n`;
      else if (l.type === 'del') hunk += `-${l.line}\n`;
      else hunk += ` ${l.line}\n`;
    }
    return hunk;
  }

  /**
   * 检查是否二进制文件
   */
  _isBinary(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);

      // 检查前 8KB 是否包含 null 字节
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 读取文件并归一化换行符
   */
  _readFileNormalized(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
    } catch {
      return '';
    }
  }

  /**
   * 更新快照缓存（LRU）
   */
  _updateSnapshot(filePath, content) {
    if (this.snapshotCache.has(filePath)) {
      // 移到最新
      const idx = this.snapshotOrder.indexOf(filePath);
      if (idx >= 0) this.snapshotOrder.splice(idx, 1);
    }
    this.snapshotCache.set(filePath, content);
    this.snapshotOrder.push(filePath);

    // LRU 淘汰
    while (this.snapshotOrder.length > SNAPSHOT_LRU_MAX) {
      const oldest = this.snapshotOrder.shift();
      this.snapshotCache.delete(oldest);
    }
  }

  /**
   * 发射 diff 事件
   */
  _emitDiff(filePath, diff, skipped, skipReason) {
    const entry = this.trackedFiles.get(filePath) || { filePath };
    entry.diff = diff;
    entry.diffSkipped = skipped;
    entry.diffSkipReason = skipReason;
    this.trackedFiles.set(filePath, entry);
    this.emit('file:diff', entry);
  }

  /**
   * 获取最近的文件改动列表
   */
  getRecentFiles(limit = 30) {
    return [...this.trackedFiles.values()]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit)
      .map(f => ({
        filePath: f.filePath,
        basename: path.basename(f.filePath),
        status: f.status,
        timestamp: f.timestamp,
        isToolWritten: f.isToolWritten,
        toolCall: f.toolCall ? { toolName: f.toolCall.toolName, sessionId: f.toolCall.sessionId } : null,
        diff: f.diff || null,
        diffSkipped: f.diffSkipped || false,
        diffSkipReason: f.diffSkipReason || ''
      }));
  }

  /**
   * 停止所有监听
   */
  async stop() {
    for (const watcher of this.dirWatchers.values()) {
      await watcher.close();
    }
    this.dirWatchers.clear();
    this.trackedFiles.clear();
    this.snapshotCache.clear();
    this.snapshotOrder = [];
  }
}
