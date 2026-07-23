import { Readable } from 'node:stream'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  MAX_ACTIVE_BRIDGE_TRANSFORMS,
  MAX_GLOBAL_BRIDGE_BUFFER_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  MAX_RESPONSE_STREAM_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  convertRequestPayload,
  createResponsesToolBridgeJsonTransform,
  createResponsesToolBridgeTransform,
  createResponsesSseJsonTransform,
} = require('../electron/services/responses-tool-bridge.cjs')

async function runTransform(transform, chunks) {
  const output = []
  for await (const chunk of Readable.from(chunks).pipe(transform)) {
    output.push(chunk)
  }
  return Buffer.concat(output).toString('utf8')
}

async function transformSse(chunks) {
  return runTransform(createResponsesToolBridgeTransform(), chunks)
}

describe('Codex Responses 工具兼容桥', () => {
  it('把 Responses SSE 的 response.completed 收拢成同步 JSON', async () => {
    const source = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message"}],"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const output = await runTransform(createResponsesSseJsonTransform(), [
      Buffer.from(source.slice(0, 17), 'utf8'),
      Buffer.from(source.slice(17), 'utf8'),
    ])
    expect(JSON.parse(output)).toEqual({
      id: 'resp_1',
      output: [{ type: 'message' }],
      usage: { input_tokens: 2, output_tokens: 1 },
    })
  })

  it('同步聚合也能转换完成事件里的 exec 工具调用', async () => {
    const source = [
      'event: response.completed\n',
      'data: ' + JSON.stringify({
        type: 'response.completed',
        response: {
          output: [{
            id: 'fc_1',
            type: 'function_call',
            name: 'exec',
            call_id: 'call_1',
            arguments: '{"input":"Get-Date"}',
          }],
        },
      }) + '\n\n',
    ].join('')
    const output = await runTransform(createResponsesSseJsonTransform({
      mapResponse: (response) => require('../electron/services/responses-tool-bridge.cjs')
        .convertResponseObject(response),
    }), [Buffer.from(source, 'utf8')])
    expect(JSON.parse(output).output[0]).toMatchObject({
      type: 'custom_tool_call',
      name: 'exec',
      input: 'Get-Date',
      call_id: 'call_1',
    })
  })

  it('同时转换 exec 定义、历史调用和工具结果并保留 call_id', () => {
    const result = convertRequestPayload({
      model: 'gpt-test',
      tools: [
        { type: 'custom', name: 'exec', description: 'desktop exec' },
        { type: 'function', name: 'search', parameters: { type: 'object' } },
      ],
      input: [
        { type: 'custom_tool_call', id: 'item_1', call_id: 'call_1', name: 'exec', input: 'Get-Date' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: '2026-07-11' },
      ],
    })

    expect(result.tools[0]).toMatchObject({
      type: 'function',
      name: 'exec',
      strict: true,
      parameters: { required: ['input'], additionalProperties: false },
    })
    expect(result.tools[1]).toMatchObject({ type: 'function', name: 'search' })
    expect(result.input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      arguments: '{"input":"Get-Date"}',
    })
    expect(result.input[1]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' })
  })

  it('改写类型时摘掉带类型前缀的 item.id，避免上游按 fc_ 前缀拒收', () => {
    // 真实事故：中转按 custom_tool_call 签发 ctc_ 前缀 id，桥把类型改成
    // function_call 却带着旧 id 回传，上游报 invalid_id_prefix 拒收整个请求。
    const result = convertRequestPayload({
      model: 'gpt-test',
      tools: [{ type: 'custom', name: 'exec' }],
      input: [
        {
          type: 'custom_tool_call',
          id: 'ctc_0035ca6ca3f441cf016a5530cdb0bc81',
          call_id: 'call_9',
          name: 'exec',
          input: 'Get-Date',
        },
        { type: 'custom_tool_call_output', id: 'ctco_77', call_id: 'call_9', output: 'ok' },
        // 非 exec 项原样通过，id 不能被误伤
        { type: 'message', id: 'msg_1', role: 'user', content: 'hi' },
      ],
    })

    expect(result.input[0].id).toBeUndefined()
    expect(result.input[0]).toMatchObject({ type: 'function_call', call_id: 'call_9' })
    expect(result.input[1].id).toBeUndefined()
    expect(result.input[1]).toMatchObject({ type: 'function_call_output', call_id: 'call_9' })
    expect(result.input[2]).toMatchObject({ id: 'msg_1' })
    // 序列化后不能残留 "id": undefined 之类的痕迹
    expect(JSON.stringify(result)).not.toContain('ctc_')
  })

  it('只转换与 exec call_id 配对的 custom tool output', () => {
    const result = convertRequestPayload({
      tools: [
        { type: 'custom', name: 'exec' },
        { type: 'custom', name: 'other_custom' },
      ],
      input: [
        { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: 'Get-Date' },
        { type: 'custom_tool_call_output', call_id: 'exec-1', output: 'ok' },
        { type: 'custom_tool_call', name: 'other_custom', call_id: 'other-1', input: 'x' },
        { type: 'custom_tool_call_output', call_id: 'other-1', output: 'keep-custom' },
      ],
    })

    expect(result.input[1].type).toBe('function_call_output')
    expect(result.input[3].type).toBe('custom_tool_call_output')

    const continuation = convertRequestPayload({
      previous_response_id: 'resp_previous',
      tools: [{ type: 'custom', name: 'exec' }],
      input: [{ type: 'custom_tool_call_output', call_id: 'previous-exec', output: 'ok' }],
    })
    expect(continuation.input[0].type).toBe('function_call_output')

    const ambiguous = convertRequestPayload({
      previous_response_id: 'resp_previous',
      tools: [{ type: 'custom', name: 'exec' }, { type: 'custom', name: 'other_custom' }],
      input: [{ type: 'custom_tool_call_output', call_id: 'unknown', output: 'keep' }],
    })
    expect(ambiguous.input[0].type).toBe('custom_tool_call_output')
  })

  it('将分块 function arguments 严格还原为 custom exec SSE', async () => {
    const source = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","name":"exec","call_id":"call_1","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","call_id":"call_1","delta":"{\\"input\\":\\"Get-"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","call_id":"call_1","delta":"Date\\"}"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"item_1","arguments":"{\\"input\\":\\"Get-Date\\"}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"item_1","type":"function_call","name":"exec","call_id":"call_1","arguments":"{\\"input\\":\\"Get-Date\\"}"}}\n\n',
      'data: [DONE]\n\n',
    ]
    const output = await transformSse([
      Buffer.from(source.join('').slice(0, 117), 'utf8'),
      Buffer.from(source.join('').slice(117), 'utf8'),
    ])

    expect(output).toContain('"type":"custom_tool_call"')
    expect(output).toContain('event: response.custom_tool_call_input.delta')
    expect(output).toContain('"delta":"Get-Date"')
    expect(output).toContain('event: response.custom_tool_call_input.done')
    expect(output).toContain('"input":"Get-Date"')
    expect(output).not.toContain('response.function_call_arguments.delta')
    expect(output).toContain('data: [DONE]')
  })

  it('拒绝畸形参数，不把普通正文中的伪工具语法转换为调用', async () => {
    const malformed = [
      'event: response.output_item.added\n',
      'data: {"item":{"id":"item_1","type":"function_call","name":"exec","call_id":"call_1","arguments":""}}\n\n',
      'event: response.function_call_arguments.done\n',
      'data: {"item_id":"item_1","arguments":"{\\"command\\":\\"Get-Date\\"}"}\n\n',
    ].join('')
    await expect(transformSse([Buffer.from(malformed, 'utf8')]))
      .rejects.toThrow('string input field')

    const text = 'data: {"type":"response.output_text.delta","delta":"[to=functions.exec] Get-Date"}\n\n'
    await expect(transformSse([Buffer.from(text, 'utf8')])).resolves.toContain(text.trim())
  })

  it('UTF-8 多字节字符被原始字节分片时保持完整', async () => {
    const source = Buffer.from(
      'data: {"type":"response.output_text.delta","delta":"你好"}\n\n',
      'utf8',
    )
    const characterStart = source.indexOf(Buffer.from('你', 'utf8'))
    const output = await transformSse([
      source.subarray(0, characterStart + 1),
      source.subarray(characterStart + 1),
    ])

    expect(output).toContain('"delta":"你好"')
    expect(output).not.toContain('\uFFFD')
  })

  it('拒绝超过上限的 SSE 帧和 exec arguments', async () => {
    await expect(transformSse([
      Buffer.alloc(MAX_RESPONSE_FRAME_BYTES + 1, 0x61),
    ])).rejects.toThrow(/SSE frame is too large/)

    const argumentsText = JSON.stringify({ input: 'x'.repeat(MAX_TOOL_ARGUMENT_BYTES) })
    const source = [
      'event: response.output_item.added\n',
      'data: {"item":{"id":"item_1","type":"function_call","name":"exec","call_id":"call_1","arguments":""}}\n\n',
      'event: response.function_call_arguments.done\n',
      `data: ${JSON.stringify({ item_id: 'item_1', arguments: argumentsText })}\n\n`,
    ].join('')
    await expect(transformSse([Buffer.from(source, 'utf8')]))
      .rejects.toThrow(/arguments are too large/)
  })

  it('大量单字节碎片和 arguments delta 保持线性处理', async () => {
    const body = Buffer.from(`data: ${JSON.stringify({
      type: 'response.output_text.delta',
      delta: '中'.repeat(12_000),
    })}\n\n`, 'utf8')
    const byteChunks = Array.from({ length: body.length }, (_value, index) => (
      body.subarray(index, index + 1)
    ))
    let started = performance.now()
    const output = await transformSse(byteChunks)
    expect(output).toContain('中'.repeat(32))
    expect(performance.now() - started).toBeLessThan(3_000)

    const deltas = Array.from({ length: 6_000 }, () => (
      'event: response.function_call_arguments.delta\n'
      + 'data: {"call_id":"call_1","delta":"x"}\n\n'
    ))
    const frames = [
      'event: response.output_item.added\n'
        + 'data: {"item":{"id":"item_1","call_id":"call_1","type":"function_call","name":"exec","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\n'
        + `data: ${JSON.stringify({ call_id: 'call_1', delta: '{"input":"' })}\n\n`,
      ...deltas,
      'event: response.function_call_arguments.delta\n'
        + `data: ${JSON.stringify({ call_id: 'call_1', delta: '"}' })}\n\n`,
      'event: response.function_call_arguments.done\n'
        + 'data: {"call_id":"call_1","arguments":""}\n\n',
      'event: response.output_item.done\n'
        + `data: ${JSON.stringify({ item: { id: 'item_1', call_id: 'call_1', type: 'function_call', name: 'exec' } })}\n\n`,
    ].map((frame) => Buffer.from(frame, 'utf8'))
    started = performance.now()
    const argumentsOutput = await transformSse(frames)
    expect(argumentsOutput).toContain(`"input":"${'x'.repeat(64)}`)
    expect(performance.now() - started).toBeLessThan(3_000)
  })

  it('全局连接和缓冲预算会拒绝并发超限并在销毁后释放', async () => {
    const active = Array.from(
      { length: MAX_ACTIVE_BRIDGE_TRANSFORMS },
      () => createResponsesToolBridgeTransform(),
    )
    await expect(runTransform(createResponsesToolBridgeTransform(), [Buffer.from('data: {}\n\n')]))
      .rejects.toThrow(/concurrent bridge/i)
    const activeClosed = active.map((transform) => once(transform, 'close'))
    active.forEach((transform) => transform.destroy())
    await Promise.all(activeClosed)
    await expect(transformSse([Buffer.from('data: {}\n\n')])).resolves.toContain('data: {}')

    const sseActive = Array.from(
      { length: MAX_ACTIVE_BRIDGE_TRANSFORMS },
      () => createResponsesSseJsonTransform(),
    )
    await expect(runTransform(createResponsesSseJsonTransform(), [Buffer.from('data: {}\n\n')]))
      .rejects.toThrow(/concurrent bridge/i)
    const sseClosed = sseActive.map((transform) => once(transform, 'close'))
    sseActive.forEach((transform) => transform.destroy())
    await Promise.all(sseClosed)

    await expect(runTransform(
      createResponsesSseJsonTransform(),
      [Buffer.alloc(MAX_RESPONSE_STREAM_BYTES + 1)],
    )).rejects.toThrow(/stream is too large/i)

    const holders = [createResponsesToolBridgeTransform(), createResponsesToolBridgeTransform()]
    const bytesPerHolder = MAX_GLOBAL_BRIDGE_BUFFER_BYTES / holders.length
    await Promise.all(holders.map((transform) => new Promise((resolve, reject) => {
      transform.write(Buffer.alloc(bytesPerHolder, 0x61), (error) => (error ? reject(error) : resolve()))
    })))
    await expect(runTransform(createResponsesToolBridgeTransform(), [Buffer.from('x')]))
      .rejects.toThrow(/buffer budget/i)
    const holderClosed = holders.map((transform) => once(transform, 'close'))
    holders.forEach((transform) => transform.destroy())
    await Promise.all(holderClosed)
    await expect(transformSse([Buffer.from('data: {}\n\n')])).resolves.toContain('data: {}')
  })

  it('非流式 JSON 转换完成后立即释放输入 chunks', async () => {
    const transform = createResponsesToolBridgeJsonTransform()
    const output = await runTransform(transform, [Buffer.from('{"output":[]}', 'utf8')])
    expect(JSON.parse(output)).toEqual({ output: [] })
    expect(transform.chunks).toEqual([])
  })
})
