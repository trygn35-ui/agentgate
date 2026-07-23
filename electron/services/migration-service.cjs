const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const path = require('node:path')
const writeFileAtomic = require('write-file-atomic')

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
const STAGING_PREFIX = '.legacy-migration-'
const ENCRYPTED_FIELD_NAMES = new Set([
  'encryptedBackup',
  'encryptedContent',
  'encryptedKey',
  'encryptedRouteToken',
  'encryptedState',
  'encryptedToken',
])

async function exists(target) {
  return Boolean(await fs.stat(target).catch(() => undefined))
}

function containsEncryptedValue(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsEncryptedValue)
  return Object.entries(value).some(([key, child]) => (
    (ENCRYPTED_FIELD_NAMES.has(key) && typeof child === 'string' && child.length > 0)
    || containsEncryptedValue(child)
  ))
}

async function validateJsonFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  let usesEncryption = false
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      usesEncryption = await validateJsonFiles(target) || usesEncryption
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const value = JSON.parse(await fs.readFile(target, 'utf8'))
      usesEncryption = containsEncryptedValue(value) || usesEncryption
    }
  }
  return usesEncryption
}

async function localStateContainsEncryptionKey(file) {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'))
    return typeof state?.os_crypt?.encrypted_key === 'string'
      && state.os_crypt.encrypted_key.length > 0
  } catch {
    return false
  }
}

async function readFileSnapshot(file) {
  try {
    return { existed: true, content: await fs.readFile(file) }
  } catch (error) {
    if (error.code === 'ENOENT') return { existed: false }
    throw error
  }
}

async function restoreFileSnapshot(file, snapshot) {
  if (snapshot.existed) {
    await writeFileAtomic(file, snapshot.content, { fsync: true })
    return
  }
  try {
    await fs.unlink(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

async function restoreFileSnapshotIfCurrent(file, snapshot, expectedHash) {
  const current = await readFileSnapshot(file)
  if (!current.existed || hashBuffer(current.content) !== expectedHash) return false
  await restoreFileSnapshot(file, snapshot)
  return true
}

/**
 * 把旧版用户目录迁移到当前用户目录。
 *
 * 先把旧数据复制到当前目录内的 staging，校验后再原子重命名为 `data/`。需要解密
 * 旧 Key 时先原子提交 `Local State`，使最终 `data/` 一旦可见就必然已有对应主密钥。
 * 当前目录已有数据时跳过，避免覆盖新数据。
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

    let stagingDirectory
    let currentLocalStateSnapshot
    let localStateCommitted = false
    let committedLocalStateHash
    try {
      await fs.mkdir(currentUserData, { recursive: true })
      stagingDirectory = await fs.mkdtemp(path.join(currentUserData, STAGING_PREFIX))
      const stagedData = path.join(stagingDirectory, DATA_DIRECTORY_NAME)
      await fs.cp(legacyData, stagedData, { recursive: true })
      const encryptedData = await validateJsonFiles(stagedData)

      const legacyLocalState = path.join(legacy, LOCAL_STATE_FILE)
      const legacyLocalStateAvailable = await exists(legacyLocalState)
      const keyMigrated = encryptedData && legacyLocalStateAvailable
      const stagedLocalState = path.join(stagingDirectory, LOCAL_STATE_FILE)
      if (keyMigrated) {
        await fs.copyFile(legacyLocalState, stagedLocalState)
      }
      if (encryptedData
        && (!keyMigrated || !await localStateContainsEncryptionKey(stagedLocalState))) {
        throw new Error('Legacy encrypted profiles require the matching Local State file')
      }
      if (keyMigrated) {
        const currentLocalState = path.join(currentUserData, LOCAL_STATE_FILE)
        currentLocalStateSnapshot = await readFileSnapshot(currentLocalState)
        const stagedLocalStateContent = await fs.readFile(stagedLocalState)
        await writeFileAtomic(
          currentLocalState,
          stagedLocalStateContent,
          { fsync: true },
        )
        committedLocalStateHash = hashBuffer(stagedLocalStateContent)
        localStateCommitted = true
      }
      await fs.rename(stagedData, currentData)
      await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
      return { migratedFrom: legacy, keyMigrated }
    } catch {
      let rollbackError
      if (localStateCommitted) {
        try {
          await restoreFileSnapshotIfCurrent(
            path.join(currentUserData, LOCAL_STATE_FILE),
            currentLocalStateSnapshot,
            committedLocalStateHash,
          )
        } catch (error) {
          rollbackError = error
        }
      }
      if (stagingDirectory) {
        await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
      }
      if (rollbackError) {
        throw new Error('Legacy migration failed and Local State could not be restored', {
          cause: rollbackError,
        })
      }
      // 迁移失败时保留旧目录和最终 data/ 不动，下次启动可以重试。
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
