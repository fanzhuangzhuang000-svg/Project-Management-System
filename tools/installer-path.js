'use strict';
/**
 * 找到要验证的安装包 exe
 *
 * 三个安装验证脚本（verify-installer / verify-overwrite / verify-installed）
 * 都要装同一个 exe，但它们的产物路径来源不同，各自写死过一份，于是各坏各的：
 *   · verify-installed 曾指向 dist-installer-new（两天前打的旧包）
 *   · verify-installer 写死 dist-installer，不认环境变量
 *   · build-artifacts 会把 exe **改名后挪到 dist-artifacts**，三个脚本全找不到
 *
 * 现在统一到这一处，按优先级：
 *   1) PMS_INSTALLER_EXE —— 显式指定文件，CI 里最可靠
 *   2) <dist-installer>/弱电项目管理系统-安装程序.exe —— 本地打包的默认产物
 *   3) <dist-artifacts>/*-windows-standalone.exe —— CI 打完交付包之后的样子
 *   4) 兜底返回 (2) 的路径，让调用方如实报"安装包不存在"
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function findInstaller () {
  if (process.env.PMS_INSTALLER_EXE) {
    return path.resolve(ROOT, process.env.PMS_INSTALLER_EXE);
  }
  const def = path.join(ROOT, process.env.PMS_INSTALLER_OUT || 'dist-installer',
    '弱电项目管理系统-安装程序.exe');
  if (fs.existsSync(def)) return def;

  const art = path.join(ROOT, process.env.PMS_ARTIFACT_OUT || 'dist-artifacts');
  try {
    const hit = fs.readdirSync(art)
      .filter(f => /windows-standalone\.exe$/i.test(f))
      .map(f => path.join(art, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (hit) return hit;
  } catch { /* 目录不存在就走兜底 */ }
  return def;
}

module.exports = { findInstaller, ROOT };
