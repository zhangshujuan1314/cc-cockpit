import fs from 'fs';
import path from 'path';

/**
 * 成本计算模块
 *
 * - 按模型名前缀匹配定价表
 * - 支持双币显示（USD / CNY）
 * - 今日累计：遍历当天有写入的全部 JSONL 的 usage 求和
 */

export class CostCalculator {
  constructor(config = {}) {
    this.pricing = config.pricing || {};
    this.usdToCny = config.usd_to_cny || 7.25;
    this.warningThresholdCny = config.cost_warning_threshold_cny || 50;
  }

  /**
   * 按模型名前缀匹配定价
   * "claude-sonnet-4-20250514" → 匹配 "claude-sonnet-4"
   */
  getPricing(model) {
    if (!model) return null;
    const modelLower = model.toLowerCase();

    // 精确匹配优先
    if (this.pricing[modelLower]) return this.pricing[modelLower];

    // 前缀匹配（按 key 长度降序，取最长匹配）
    const keys = Object.keys(this.pricing).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (modelLower.startsWith(key.toLowerCase())) {
        return this.pricing[key];
      }
    }

    return null; // 未匹配
  }

  /**
   * 计算单次 usage 的费用（USD）
   * 兼容两种字段命名：raw JSONL (input_tokens) 和 camelCase (input)
   */
  calculateUsage(model, usage) {
    const pricing = this.getPricing(model);
    if (!pricing) {
      return { usd: 0, cny: 0, matched: false };
    }

    const input = usage.input_tokens || usage.input || 0;
    const output = usage.output_tokens || usage.output || 0;
    const cacheRead = usage.cache_read_input_tokens || usage.cacheRead || 0;
    const cacheWrite = usage.cache_creation_input_tokens || usage.cacheWrite || 0;

    const usd =
      (input / 1_000_000) * pricing.input +
      (output / 1_000_000) * pricing.output +
      (cacheRead / 1_000_000) * pricing.cache_read +
      (cacheWrite / 1_000_000) * pricing.cache_write;

    return {
      usd,
      cny: usd * this.usdToCny,
      matched: true
    };
  }

  /**
   * 计算会话总成本
   */
  calculateSession(tokenUsage, modelBreakdown = {}) {
    let totalUsd = 0;
    let hasUnknown = false;

    // 如果有模型细分，按模型分别计算
    for (const [model, usage] of Object.entries(modelBreakdown)) {
      const result = this.calculateUsage(model, usage);
      totalUsd += result.usd;
      if (!result.matched) hasUnknown = true;
    }

    // 如果没有模型细分，用总量估算（假设 sonnet 价格）
    if (Object.keys(modelBreakdown).length === 0) {
      const defaultPricing = this.pricing['claude-sonnet-4'] || { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 };
      totalUsd =
        ((tokenUsage.input || 0) / 1_000_000) * defaultPricing.input +
        ((tokenUsage.output || 0) / 1_000_000) * defaultPricing.output +
        ((tokenUsage.cacheRead || 0) / 1_000_000) * defaultPricing.cache_read +
        ((tokenUsage.cacheWrite || 0) / 1_000_000) * defaultPricing.cache_write;
    }

    return {
      usd: totalUsd,
      cny: totalUsd * this.usdToCny,
      hasUnknown
    };
  }

  /**
   * 格式化 token 数量
   */
  static formatTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  }

  /**
   * 格式化金额
   */
  static formatCost(usd, cny) {
    return `$${usd.toFixed(4)} (¥${cny.toFixed(2)})`;
  }
}
