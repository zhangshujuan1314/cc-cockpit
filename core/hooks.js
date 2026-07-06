import fs from 'fs';
import path from 'path';

/**
 * Hooks 安装器
 *
 * 安全要求：
 * 1. 读取现有 settings.json → 深合并 → 写回
 * 2. 任何情况下不得覆盖已有键
 * 3. 安装前备份为 settings.json.bak
 * 4. 先在副本上演练 diff，确认只增不改
 */

export class HookInstaller {
  constructor(options = {}) {
    this.settingsPath = options.settingsPath ||
      path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json');
    this.hookScriptPath = options.hookScriptPath || '';
  }

  /**
   * 获取 settings.json 路径
   */
  getSettingsPath() {
    return this.settingsPath;
  }

  /**
   * 读取现有 settings.json
   */
  readSettings() {
    try {
      if (fs.existsSync(this.settingsPath)) {
        return JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'));
      }
    } catch (err) {
      console.warn('[hooks] 读取 settings.json 失败:', err.message);
    }
    return {};
  }

  /**
   * 生成要合并的 hooks 配置
   */
  generateHooksConfig(hookScriptAbsPath) {
    const scriptPath = hookScriptAbsPath || this.hookScriptPath;
    return {
      hooks: {
        Stop: [{
          hooks: [{
            type: 'command',
            command: `node "${scriptPath}" stop`
          }]
        }],
        Notification: [{
          hooks: [{
            type: 'command',
            command: `node "${scriptPath}" notification`
          }]
        }]
      }
    };
  }

  /**
   * 深合并（只添加，不覆盖）
   */
  deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (key in result) {
        if (typeof result[key] === 'object' && typeof source[key] === 'object'
            && !Array.isArray(result[key]) && !Array.isArray(source[key])) {
          result[key] = this.deepMerge(result[key], source[key]);
        }
        // 已存在的键：不覆盖（数组/原始值保留原样）
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  /**
   * 演练合并（不写文件，返回 diff 描述）
   */
  dryRun(hookScriptAbsPath) {
    const current = this.readSettings();
    const hooksConfig = this.generateHooksConfig(hookScriptAbsPath);
    const merged = this.deepMerge(current, hooksConfig);

    const changes = [];
    if (!current.hooks) {
      changes.push('新增 hooks 键');
    } else {
      if (!current.hooks.Stop) changes.push('新增 hooks.Stop');
      if (!current.hooks.Notification) changes.push('新增 hooks.Notification');
    }

    // 验证不会丢失现有键
    const lostKeys = [];
    for (const key of Object.keys(current)) {
      if (!(key in merged)) {
        lostKeys.push(key);
      }
    }

    return {
      changes,
      lostKeys,
      hasDangerousLoss: lostKeys.length > 0,
      preview: merged
    };
  }

  /**
   * 安装 hooks（带备份）
   */
  install(hookScriptAbsPath) {
    // 1. 演练
    const dryRun = this.dryRun(hookScriptAbsPath);
    if (dryRun.hasDangerousLoss) {
      throw new Error(`安装会导致丢失键: ${dryRun.lostKeys.join(', ')}`);
    }

    // 2. 备份
    const backupPath = this.settingsPath + '.bak';
    if (fs.existsSync(this.settingsPath)) {
      fs.copyFileSync(this.settingsPath, backupPath);
    }

    // 3. 合并写入
    const current = this.readSettings();
    const hooksConfig = this.generateHooksConfig(hookScriptAbsPath);
    const merged = this.deepMerge(current, hooksConfig);

    fs.writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2), 'utf-8');

    return {
      success: true,
      backupPath,
      changes: dryRun.changes
    };
  }

  /**
   * 验证安装结果
   */
  verify() {
    const settings = this.readSettings();
    const hasStop = !!settings.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    const hasNotification = !!settings.hooks?.Notification?.[0]?.hooks?.[0]?.command;
    const backupExists = fs.existsSync(this.settingsPath + '.bak');

    return {
      hooksInstalled: hasStop && hasNotification,
      stopHook: hasStop,
      notificationHook: hasNotification,
      backupExists
    };
  }
}
