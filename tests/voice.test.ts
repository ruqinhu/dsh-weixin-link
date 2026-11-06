import { describe, expect, it } from 'vitest'
import { silkToWavArgs, sttCommandFor, transcribeVoice } from '../src/ilink/voice.js'

describe('sttCommandFor', () => {
  it('runs the bundled helper with python3 and no shell', () => {
    const { argv, shell } = sttCommandFor('/tmp/a.silk')

    expect(shell).toBe(false)
    expect(argv[0]).toBe('python3')
    expect(argv[1]).toMatch(/scripts[/\\]stt\.py$/)
    expect(argv[2]).toBe('/tmp/a.silk')
  })

  it('substitutes and quotes the path in a caller-supplied template', () => {
    const { argv, shell } = sttCommandFor("/tmp/it's here.silk", { command: 'my-stt --audio {file}' })

    expect(shell).toBe(true)
    // A quote in a filename must not be able to end the quoting.
    expect(argv[0]).toBe(`my-stt --audio '/tmp/it'\\''s here.silk'`)
  })

  it('honours a python override', () => {
    const { argv } = sttCommandFor('/tmp/a.wav', { python: '/usr/bin/python3.11' })

    expect(argv[0]).toBe('/usr/bin/python3.11')
  })
})

describe('silkToWavArgs', () => {
  it('uses 24 kHz, the rate the Hermes skill measured for WeChat voice', () => {
    expect(silkToWavArgs('/a.silk', '/a.wav')).toEqual({ silk: '/a.silk', wav: '/a.wav', rate: 24_000 })
  })
})

describe('transcribeVoice', () => {
  it('returns the transcript printed by the helper', async () => {
    const command = `python3 -c "print('华天科技明天的关键位是十七块五')"`

    await expect(transcribeVoice('/tmp/x.wav', { command, timeoutMs: 10_000 })).resolves.toBe(
      '华天科技明天的关键位是十七块五',
    )
  })

  it('reports a failing helper instead of returning an empty transcript', async () => {
    const command = `python3 -c "import sys; sys.stderr.write('model missing'); sys.exit(3)"`

    await expect(transcribeVoice('/tmp/x.wav', { command, timeoutMs: 10_000 })).rejects.toThrow(
      /exited 3: model missing/,
    )
  })

  it('treats an empty transcript as a failure, because silence is not a result', async () => {
    const command = `python3 -c "print('')"`

    await expect(transcribeVoice('/tmp/x.wav', { command, timeoutMs: 10_000 })).rejects.toThrow(/no text/)
  })

  it('gives up on a hung helper instead of blocking the turn forever', async () => {
    const command = `python3 -c "import time; time.sleep(5)"`

    await expect(transcribeVoice('/tmp/x.wav', { command, timeoutMs: 300 })).rejects.toThrow(/timed out/)
  })
})
