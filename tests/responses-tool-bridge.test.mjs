import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  convertRequestPayload,
  createResponsesToolBridgeTransform,
} = require('../electron/services/responses-tool-bridge.cjs')

async function transformSse(chunks) {
  const output = []
  for await (const chunk of Readable.from(chunks).pipe(createResponsesToolBridgeTransform())) {
    output.push(chunk)
  }
  return Buffer.concat(output).toString('utf8')
}

describe('Codex Responses 工具兼容桥', () => {
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

  it('将分块 function arguments 严格还原为 custom exec SSE', async () => {
    const source = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","name":"exec","call_id":"call_1","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"input\\":\\"Get-"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"Date\\"}"}\n\n',
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
})
