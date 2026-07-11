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
