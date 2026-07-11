const fs = require('node:fs/promises')
const path = require('node:path')
const writeFileAtomic = require('write-file-atomic')

/**
 * 使用 Zod 校验并原子持久化 JSON 数据。
 *
 * 读取不存在的文件时返回经过校验的默认值；格式或结构无效时直接报错，避免用
 * 默认值覆盖损坏数据。
 */
class JsonFileStore {
  constructor(filePath, schema, defaultValue) {
    this.filePath = filePath
    this.schema = schema
    this.defaultValue = defaultValue
  }

  /**
   * 读取并校验数据文件。
   *
   * @returns {Promise<object>} 通过 Schema 校验的数据。
   * @throws 文件不可读、JSON 无效或结构不符合 Schema 时抛出错误。
   */
  async read() {
    let source
    try {
      source = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return this.schema.parse(this.defaultValue())
      throw error
    }

    let value
    try {
      value = JSON.parse(source)
    } catch {
      throw new Error(`Keydeck data file is not valid JSON: ${path.basename(this.filePath)}`)
    }
    return this.schema.parse(value)
  }

  /**
   * 校验后以同目录临时文件原子替换目标文件。
   *
   * @param {object} value 待写入的数据。
   * @returns {Promise<object>} 校验后的实际写入值。
   * @throws 校验失败或文件系统写入失败时抛出错误。
   */
  async write(value) {
    const validated = this.schema.parse(value)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFileAtomic(this.filePath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      fsync: true,
      mode: 0o600,
    })
    return validated
  }
}

/**
 * 将同一服务内的修改操作串行化，避免进程内并发覆盖。
 */
class SerialExecutor {
  constructor() {
    this.tail = Promise.resolve()
  }

  /**
   * 在前一个操作结束后执行指定异步任务。
   *
   * @param {() => Promise<unknown>} operation 待执行任务。
   * @returns {Promise<unknown>} 当前任务结果；失败不会阻塞后续任务。
   */
  run(operation) {
    const result = this.tail.then(operation, operation)
    this.tail = result.catch(() => {})
    return result
  }
}

/**
 * 封装 Electron safeStorage，管理 Key 和回滚快照的 DPAPI 密文。
 */
class Vault {
  constructor(safeStorage) {
    this.safeStorage = safeStorage
  }

  /**
   * 确认当前系统能够提供安全存储。
   *
   * @throws DPAPI 不可用时抛出错误，禁止降级为明文保存。
   */
  assertAvailable() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is not available')
    }
  }

  /**
   * 加密字符串并转换为可写入 JSON 的 Base64。
   *
   * @param {string} value 明文。
   * @returns {string} 当前 Windows 用户可解密的密文。
   * @throws 系统加密不可用时抛出错误。
   */
  encrypt(value) {
    this.assertAvailable()
    return this.safeStorage.encryptString(value).toString('base64')
  }

  /**
   * 解锁当前 Windows 用户拥有的密文。
   *
   * @param {string} encryptedValue Base64 密文。
   * @returns {string} 解密后的明文。
   * @throws 密文缺失、损坏或不属于当前用户时抛出错误。
   */
  decrypt(encryptedValue) {
    this.assertAvailable()
    if (!encryptedValue) throw new Error('This profile does not have an API key')
    try {
      return this.safeStorage.decryptString(Buffer.from(encryptedValue, 'base64'))
    } catch {
      throw new Error('The encrypted API key could not be unlocked for this Windows user')
    }
  }

  /**
   * 生成不暴露完整 Key 的尾号摘要。
   *
   * @param {string} value 明文 Key。
   * @returns {string} 仅包含末四位的显示文本。
   */
  hint(value) {
    if (!value) return 'Not set'
    if (value.length <= 4) return '****'
    return `****${value.slice(-4)}`
  }
}

module.exports = {
  JsonFileStore,
  SerialExecutor,
  Vault,
}
