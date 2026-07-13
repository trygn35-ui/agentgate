const fs = require('node:fs/promises')
const path = require('node:path')

const DATA_DIRECTORY_NAME = 'data'
/**
 * Electron safeStorage 的主密钥文件。
 *
 * Windows 上 safeStorage 走 Chromium os_crypt：密文以 `v10` 开头，真正的 AES 主密钥
 * 存在 userData 根目录的 `Local State` 里（`os_crypt.encrypted_key` 字段本身由 DPAPI
 * 保护）。改变 userData 路径而不迁移这个文件，会让应用生成新密钥，导致旧密文全部
 * 无法解密。
 */
const LOCAL_STATE_FILE = 'Local State'

async function exists(target) {
  return Boolean(await fs.stat(target).catch(() => undefined))
}

/**
 * 把旧版用户目录迁移到当前用户目录。
 *
 * 先复制 `Local State` 再复制 `data/`：顺序颠倒时若中途失败，会留下有密文却无密钥
 * 的目录。当前目录已有数据时跳过，避免覆盖新数据。
 *
 * @param {string} currentUserData 当前 userData 目录。
 * @param {string[]} legacyAppNames 旧版应用名（与 userData 同级的目录名）。
 * @returns {Promise<{migratedFrom: string, keyMigrated: boolean} | undefined>}
 *   迁移结果；无需迁移或迁移失败时返回 undefined。
 */
async function migrateLegacyUserData(currentUserData, legacyAppNames = []) {
  const currentData = path.join(currentUserData, DATA_DIRECTORY_NAME)
  if (await exists(currentData)) return undefined

  const parent = path.dirname(currentUserData)
  for (const legacyName of legacyAppNames) {
    const legacy = path.join(parent, legacyName)
    const legacyData = path.join(legacy, DATA_DIRECTORY_NAME)
    if (!await exists(legacyData)) continue

    try {
      await fs.mkdir(currentUserData, { recursive: true })
      const legacyLocalState = path.join(legacy, LOCAL_STATE_FILE)
      const keyMigrated = await exists(legacyLocalState)
      if (keyMigrated) {
        await fs.copyFile(legacyLocalState, path.join(currentUserData, LOCAL_STATE_FILE))
      }
      await fs.cp(legacyData, currentData, { recursive: true })
      return { migratedFrom: legacy, keyMigrated }
    } catch {
      // 迁移失败时保留旧目录不动，以空配置启动；用户仍可手动复制。
      return undefined
    }
  }
  return undefined
}

module.exports = {
  DATA_DIRECTORY_NAME,
  LOCAL_STATE_FILE,
  migrateLegacyUserData,
}
